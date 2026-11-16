<#
.SYNOPSIS
  Deploys armbackup to an App Service Plan, Storage, Workspace/DCR and Key Vault that already exist.
  One file, Azure CLI only (no Bicep or parameter files).

.DESCRIPTION
  KT network governance, enforced from the moment the Web App exists (one create request, no open window):
    - Networking: public access "Enabled from select virtual networks and IP addresses" (default action Deny).
      Allowed IPs are added by the operator in the portal; this script never opens the app to everyone.
    - VNet Integration into -VnetSubnetId (delegated to Microsoft.Web/serverFarms), set at creation.
    - Private Endpoint (sites) in -PrivateEndpointSubnetId with a Private DNS zone group (DNS integration).
    - The site resource is written only by ARM requests that carry siteConfig.ipSecurityRestrictionsDefaultAction, because
      the policy rejects a site write without it. That is why "az webapp identity assign" and "az webapp update" are not used.

  1. Creates (or updates) the Web App on the existing Linux plan with a system-assigned identity.
  2. Applies site settings, app settings (ARMBACKUP_AUTH_MODE ...), sign-in mode, SCM/FTP basic-auth block,
     the Private Endpoint and DNS integration.
  3. Grants the identity its roles on the resources you pass in (skip with -SkipRoles).
  4. Packages the app, zip-deploys it, then checks /health and that anonymous access is rejected.

  Every step is idempotent: running the script again converges the app to the values you pass.
  Use -WhatIf to see every change without making any.

  IP rules: -AllowedClientIps / -AllowCurrentIp REPLACE the app's IP rule list. Without them, existing rules
  (for example IPs the operator added in the portal) are kept and a new app starts with none (deny all).
  Log Analytics: give -WorkspaceId (resource ID). Without -DcrId the script creates the custom table ArmBackup_CL
  and a Direct Data Collection Rule (-DcrName, default dcr-armbackup) in the workspace's resource group, or reuses
  them if they exist. With -DcrId it uses that rule. Either way the rule id / endpoint in the package config are
  filled in from the real rule at deploy time, so the config's DCR fields can stay placeholders.

  Code deployment needs the deployment PC to be allowed (public IP rule) or on the VNet (Private Endpoint).

  Secrets: pass an @Microsoft.KeyVault(SecretUri=...) reference as -PasswordHash / -ClientSecret, or set the
  environment variables ARMBACKUP_AUTH_PASSWORD_HASH / ARMBACKUP_ENTRA_CLIENT_SECRET. Values are written only to a
  temporary file that is deleted at the end.

  Default sign-in: when both -Username and -PasswordHash are omitted, the script removes those two app settings
  and the app starts with its temporary built-in login admin / password. Pass both to use your own credentials.

.EXAMPLE
  # Password sign-in; networking per KT governance (IPs are added later in the portal)
  .\scripts\deploy-customer.ps1 -SubscriptionId <id> -ResourceGroup rg-armbackup -AppName app-armbackup-acme `
    -AppServicePlanId <plan id> -VnetSubnetId <integration subnet id> -PrivateEndpointSubnetId <pe subnet id> `
    -AuthMode password -Username ops.admin `
    -PasswordHash '@Microsoft.KeyVault(SecretUri=https://kv-acme.vault.azure.net/secrets/armbackup-hash/)' `
    -StorageAccountId <id> -WorkspaceId <id> -DcrId <id> -KeyVaultId <id> `
    -DeployConfigFile .\deploy-config.local.json -WhatIf

  # A PC without the source code, git or Python: deploy a package built elsewhere (needs only this script, the zip and Azure CLI)
  .\deploy-customer.ps1 ... -PackagePath .\armbackup-deploy.zip
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$SubscriptionId,
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][ValidateLength(2, 60)][string]$AppName,
  [Parameter(Mandatory)][string]$AppServicePlanId,
  [Parameter(Mandatory, HelpMessage = 'Subnet delegated to Microsoft.Web/serverFarms for VNet Integration')]
  [string]$VnetSubnetId,
  [Parameter(Mandatory, HelpMessage = 'Subnet for the Private Endpoint (not delegated, different from VnetSubnetId)')]
  [string]$PrivateEndpointSubnetId,
  [string]$PrivateEndpointName,
  [string]$PrivateDnsZoneId,
  [ValidateSet('password', 'entra')][string]$AuthMode = 'password',

  [string]$Username,
  [string]$PasswordHash = $env:ARMBACKUP_AUTH_PASSWORD_HASH,

  [string]$TenantId,
  [string]$OperatorObjectId,
  [string]$ClientId,
  [string]$ClientSecret = $env:ARMBACKUP_ENTRA_CLIENT_SECRET,

  [string[]]$AllowedClientIps = @(),
  [switch]$AllowCurrentIp,

  [string]$StorageAccountId,
  [string]$WorkspaceId,
  [string]$DcrId,
  [string]$DcrName = 'dcr-armbackup',
  [string]$KeyVaultId,
  [switch]$SkipRoles,
  [switch]$SkipSubscriptionRoles,

  [string]$DeployConfigFile,
  [string]$PackagePath,
  [switch]$SkipCode,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$api = '2023-12-01'
$temporary = New-Object System.Collections.Generic.List[string]
$sha = $null
$startup = 'PYTHONPATH=$PWD/src python -m armbackup.webui --hosted --port 8000 --live-config $PWD/hosted/console.json'
# Windows ships curl.exe (in Windows PowerShell "curl" is an alias of Invoke-WebRequest); macOS and Linux have plain curl.
$onWindows = $PSVersionTable.PSEdition -eq 'Desktop' -or $IsWindows
$curl = if ($onWindows) { 'curl.exe' } else { 'curl' }
$nullDevice = if ($onWindows) { 'NUL' } else { '/dev/null' }

function Step($message) { Write-Host "`n== $message" -ForegroundColor Cyan }
function Require($value, $name) {
  if ([string]::IsNullOrWhiteSpace([string]$value)) { throw "$name is required" }
}
function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)" }
}
function Invoke-Change {
  [CmdletBinding(SupportsShouldProcess)]
  param([string]$Description, [scriptblock]$Action)
  if ($PSCmdlet.ShouldProcess($AppName, $Description)) { & $Action }
}
function Write-TemporaryJson($value) {
  $path = Join-Path ([IO.Path]::GetTempPath()) ("armbackup-" + [guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
  $temporary.Add($path)
  $path
}
function Invoke-Rest($method, $path, $body, $apiVersion = $api) {
  $file = Write-TemporaryJson $body
  Invoke-Az rest --method $method --url "https://management.azure.com$path`?api-version=$apiVersion" --body "@$file" -o none
}
function Set-PackageLogging($zipPath) {
  # The DCR's rule id and endpoint exist only after it is created, so the packaged config is completed here.
  if (-not $logging) { return }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::Open($zipPath, 'Update')
  try {
    foreach ($name in 'hosted/capture.json', 'hosted/console.json') {
      $entry = $archive.GetEntry($name)
      $reader = New-Object IO.StreamReader($entry.Open())
      try { $document = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      if ($name -like '*capture.json') {
        # The whole section is written here, so the deploy config does not need a "logging" section at all.
        $section = [ordered]@{
          workspace_resource_id = $WorkspaceId; dcr_resource_id = $logging.dcr_resource_id
          endpoint = $logging.endpoint; rule_id = $logging.rule_id; stream = $logging.stream }
        $document | Add-Member -NotePropertyName logging -NotePropertyValue ([pscustomobject]$section) -Force
      } elseif ($document.workspace_guid -ine $workspace.guid) {
        Write-Host "  workspace_guid is set to $($workspace.guid)"
        $document | Add-Member -NotePropertyName workspace_guid -NotePropertyValue $workspace.guid -Force
      }
      $entry.Delete()
      $writer = New-Object IO.StreamWriter($archive.CreateEntry($name).Open(), (New-Object Text.UTF8Encoding($false)))
      try { $writer.Write(($document | ConvertTo-Json -Depth 10)) } finally { $writer.Dispose() }
    }
  } finally { $archive.Dispose() }
}
function Grant($scope, $role, $label) {
  Invoke-Change "Grant '$role' on $label" {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & az role assignment create --assignee-object-id $script:principalId --assignee-principal-type ServicePrincipal `
      --role $role --scope $scope -o none 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($code -ne 0 -and "$output" -notmatch 'already exists|RoleAssignmentExists') { throw "Role assignment '$role' on $label failed: $output" }
  }
}
function Http-Status($url) { (& $curl -s -o $nullDevice -w '%{http_code}' --max-time 30 $url) }
function Get-ForbiddenIp($url) {
  $headers = & $curl -s -I --max-time 15 $url 2>$null
  foreach ($line in @($headers)) {
    if ("$line" -match '(?i)^x-ms-forbidden-ip:\s*([0-9.]+)') { return $Matches[1].Trim() }
  }
  $null
}

try {
  # Entra sign-in is temporarily disabled until an App Registration is available.
  if ($AuthMode -eq 'entra') { throw "-AuthMode entra is temporarily disabled; use -AuthMode password." }
  if ($AuthMode -eq 'password') {
    # Both omitted: the app starts with its built-in temporary sign-in (admin / password).
    $useDefaultLogin = -not $Username -and -not $PasswordHash
    if ($useDefaultLogin) {
      Write-Warning 'No -Username/-PasswordHash: the app will use the built-in default sign-in (admin / password). Replace it before production use.'
    } else {
      Require $Username '-Username'
      Require $PasswordHash '-PasswordHash (or env ARMBACKUP_AUTH_PASSWORD_HASH)'
    }
  } else {
    foreach ($pair in @(@('-TenantId', $TenantId), @('-OperatorObjectId', $OperatorObjectId), @('-ClientId', $ClientId),
        @('-ClientSecret (or env ARMBACKUP_ENTRA_CLIENT_SECRET)', $ClientSecret))) { Require $pair[1] $pair[0] }
  }
  if (-not $SkipRoles -or -not $SkipCode) {
    Require $WorkspaceId '-WorkspaceId (the Log Analytics workspace resource ID; the DCR is created in it unless -DcrId is given)'
  }
  if (-not $SkipRoles) {
    Require $StorageAccountId '-StorageAccountId (or -SkipRoles)'
  }
  if (-not $SkipCode -and -not $PackagePath) { Require $DeployConfigFile '-DeployConfigFile or -PackagePath (or -SkipCode)' }
  $packagedCapture = $null
  if ($PackagePath -and -not $SkipCode) {
    # A prebuilt package lets a PC without the source, git or Python deploy; check it before touching Azure.
    if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw "-PackagePath not found: $PackagePath" }
    $PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
      $names = @($archive.Entries | ForEach-Object { $_.FullName })
      foreach ($required in 'requirements.txt', 'src/armbackup/webui.py', 'hosted/console.json', 'hosted/capture.json') {
        if ($names -notcontains $required) { throw "-PackagePath is not an armbackup deploy package: $required is missing" }
      }
      $captureReader = New-Object IO.StreamReader($archive.GetEntry('hosted/capture.json').Open())
      try { $packagedCapture = $captureReader.ReadToEnd() | ConvertFrom-Json } finally { $captureReader.Dispose() }
      $marker = $archive.Entries | Where-Object { $_.FullName -eq 'hosted/build.json' }
      if ($marker) {
        $reader = New-Object IO.StreamReader($marker.Open())
        try { $packagedCommit = ($reader.ReadToEnd() | ConvertFrom-Json).commit } finally { $reader.Dispose() }
        if ($packagedCommit -match '^[0-9a-f]{7,40}$') { $sha = $packagedCommit }
      }
    } finally { $archive.Dispose() }
  } elseif ($DeployConfigFile -and -not $SkipCode) {
    if (-not (Test-Path -LiteralPath $DeployConfigFile -PathType Leaf)) { throw "-DeployConfigFile not found: $DeployConfigFile" }
    $packagedCapture = (Get-Content -Raw -LiteralPath $DeployConfigFile | ConvertFrom-Json).capture
  }
  if ($packagedCapture) {
    $cfgSub = @($packagedCapture.subscriptions)[0]
    if ($cfgSub -and $cfgSub -ine $SubscriptionId) {
      throw "The deploy config's subscriptions[0] is '$cfgSub' but -SubscriptionId is '$SubscriptionId'. Rebuild the package for this subscription."
    }
    if ($StorageAccountId -match '^/subscriptions/[^/]+/resourceGroups/([^/]+)/providers/Microsoft\.Storage/storageAccounts/([^/]+)$') {
      $storageRgFromId, $storageNameFromId = $Matches[1], $Matches[2]
      $expectedUrl = "https://$storageNameFromId.blob.core.windows.net"
      if ($packagedCapture.storage.account_url -and ($packagedCapture.storage.account_url.TrimEnd('/') -ine $expectedUrl)) {
        throw "The deploy config's storage.account_url is '$($packagedCapture.storage.account_url)' but -StorageAccountId points to '$storageNameFromId' ($expectedUrl)."
      }
      $cfgRg = @($packagedCapture.resource_groups)[0]
      if ($cfgRg -and $cfgRg -ine $storageRgFromId) {
        throw "The storage account is in resource group '$storageRgFromId' but the deploy config's resource_groups[0] is '$cfgRg'. Storage, Workspace and DCR must all be in '$cfgRg'."
      }
    }
  }
  $kvRefs = @(@($PasswordHash, $ClientSecret) | Where-Object { $_ -like '@Microsoft.KeyVault(*' })
  if ($kvRefs.Count -gt 0) {
    if (-not $SkipRoles -and -not $KeyVaultId) {
      Write-Warning "A @Microsoft.KeyVault(...) reference was supplied without -KeyVaultId; 'Key Vault Secrets User' will not be granted by this script."
    }
    if ($KeyVaultId -match '/providers/Microsoft\.KeyVault/vaults/([^/]+)$') {
      $kvNameFromId = $Matches[1]
      foreach ($ref in $kvRefs) {
        if ($ref -match 'https://([^./]+)\.vault\.azure\.net/' -and $Matches[1] -ine $kvNameFromId) {
          throw "Key Vault reference points to vault '$($Matches[1])' but -KeyVaultId is '$kvNameFromId'."
        }
      }
    }
  }
  if ($AllowCurrentIp) {
    # Best-effort initial lookup; split-tunnel VPNs and corporate SNAT pools are reconciled against x-ms-forbidden-ip below.
    $current = $null
    foreach ($service in 'https://api.ipify.org', 'https://checkip.amazonaws.com') {
      try { $current = (Invoke-RestMethod -Uri $service -TimeoutSec 10).ToString().Trim(); if ($current -match '^\d{1,3}(\.\d{1,3}){3}$') { break } } catch { $current = $null }
    }
    if ($current -match '^\d{1,3}(\.\d{1,3}){3}$') {
      if ($AllowedClientIps -notcontains "$current/32") { $AllowedClientIps = @($AllowedClientIps) + "$current/32" }
      Write-Host "Allowing this PC ($current) for the deployment. Remove it in the portal (Networking > Access restrictions, main site and SCM) when finished."
    } else {
      Write-Host 'Public IP echo service unreachable; will detect outbound IP directly from Azure App Service before deployment.'
    }
  }
  if ($AllowedClientIps) {
    Write-Host "IP rules will be REPLACED with: $($AllowedClientIps -join ', ')"
  } else {
    Write-Host 'No -AllowedClientIps: existing IP rules are kept (a new app starts with none = deny all). Add IPs in the portal: Networking > Access restrictions.'
  }

  Step 'Checking Azure CLI context'
  Invoke-Az account set --subscription $SubscriptionId
  Invoke-Az group show --name $ResourceGroup --query name -o tsv | Out-Null
  $site = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AppName"
  & az webapp show --resource-group $ResourceGroup --name $AppName --query name -o tsv 2>$null | Out-Null
  $exists = $LASTEXITCODE -eq 0

  Step 'Checking the network prerequisites'
  $plan = Invoke-Az resource show --ids $AppServicePlanId --query '{location:location,linux:properties.reserved,sku:sku.name}' -o json | ConvertFrom-Json
  if (-not $plan.linux) { throw "App Service Plan $AppServicePlanId is not a Linux plan" }
  $location = ($plan.location -replace '\s', '').ToLowerInvariant()
  if ($VnetSubnetId -ieq $PrivateEndpointSubnetId) {
    throw '-VnetSubnetId and -PrivateEndpointSubnetId must be different subnets: the integration subnet is delegated to App Service and cannot host a Private Endpoint.'
  }
  foreach ($check in @(@('VnetSubnetId', $VnetSubnetId, $true), @('PrivateEndpointSubnetId', $PrivateEndpointSubnetId, $false))) {
    $name, $id, $mustBeDelegated = $check
    if ($id -notmatch '^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.Network/virtualNetworks/[^/]+/subnets/[^/]+$') {
      throw "-$name must be a subnet resource ID (/subscriptions/.../virtualNetworks/<vnet>/subnets/<subnet>)"
    }
    $found = & az network vnet subnet show --ids $id --query '{delegations:delegations[].serviceName}' -o json 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not read subnet $id (no permission?); skipping its checks."; continue }
    $delegations = @(($found | ConvertFrom-Json).delegations)
    $delegated = $delegations -contains 'Microsoft.Web/serverFarms'
    if ($mustBeDelegated -and -not $delegated) { throw "-$name must be delegated to Microsoft.Web/serverFarms (Subnet delegation). Delegate it first, then re-run." }
    if (-not $mustBeDelegated -and $delegations.Count -gt 0) { throw "-$name has a delegation ($($delegations -join ', ')) and cannot host a Private Endpoint." }
    $vnet = $id -replace '/subnets/[^/]+$', ''
    $vnetRegion = & az network vnet show --ids $vnet --query location -o tsv 2>$null
    # The plan reports "Korea Central", the VNet "koreacentral".
    $sameRegion = ("$vnetRegion" -replace '\s', '') -ieq ("$location" -replace '\s', '')
    if ($LASTEXITCODE -eq 0 -and $mustBeDelegated -and -not $sameRegion) {
      throw "-$name is in $vnetRegion but the App Service Plan is in $location; VNet Integration needs the same region."
    }
  }

  Step 'Web App (networking is applied in the same request that creates it)'
  $restrictions = @()
  for ($index = 0; $index -lt $AllowedClientIps.Count; $index++) {
    $restrictions += @{ name = "allow-$index"; ipAddress = $AllowedClientIps[$index]; action = 'Allow'; priority = 100 + $index }
  }
  if (-not $exists) {
    # SCM gets its own explicit deny-default: with "use main site rules" and an empty main list the platform
    # leaves the deployment endpoint (SCM) open, which was observed on a live app.
    $siteConfig = @{
      linuxFxVersion = 'PYTHON|3.12'; alwaysOn = $true; minTlsVersion = '1.2'; ftpsState = 'Disabled'
      ipSecurityRestrictions = @($restrictions); ipSecurityRestrictionsDefaultAction = 'Deny'
      scmIpSecurityRestrictions = @($restrictions); scmIpSecurityRestrictionsDefaultAction = 'Deny'
      scmIpSecurityRestrictionsUseMain = $false }
    Invoke-Change "Create Web App on $AppServicePlanId with VNet Integration and select-networks access" {
      Invoke-Rest 'PUT' $site @{
        location = $location; kind = 'app,linux'; identity = @{ type = 'SystemAssigned' }
        properties = @{ serverFarmId = $AppServicePlanId; httpsOnly = $true; publicNetworkAccess = 'Enabled'
          virtualNetworkSubnetId = $VnetSubnetId; siteConfig = $siteConfig } }
    }
  } else {
    # Read first and write only on drift. The KT policy rejects every write to the site resource whose request lacks
    # siteConfig.ipSecurityRestrictionsDefaultAction, and a GET of the site never returns that value (it lives in
    # config/web). So nothing here reads and rewrites the whole site (az webapp identity assign, az webapp update);
    # the one write below always carries the value.
    $current = Invoke-Az rest --method get --url "https://management.azure.com$site`?api-version=$api" -o json | ConvertFrom-Json
    $identityType = "$($current.identity.type)"
    $needsIdentity = $identityType -notmatch 'SystemAssigned'
    $drift = ($current.properties.httpsOnly -ne $true) -or ($current.properties.publicNetworkAccess -ne 'Enabled') -or
      ($current.properties.virtualNetworkSubnetId -ine $VnetSubnetId) -or $needsIdentity
    if ($drift) {
      $change = @{ properties = @{ httpsOnly = $true; publicNetworkAccess = 'Enabled'; virtualNetworkSubnetId = $VnetSubnetId
          siteConfig = @{ ipSecurityRestrictionsDefaultAction = 'Deny' } } }
      if ($needsIdentity) {
        $change.identity = @{ type = 'SystemAssigned' }
        if ($identityType -match 'UserAssigned') {
          # Keep the user-assigned identities the app already has.
          $change.identity.type = 'SystemAssigned,UserAssigned'
          $change.identity.userAssignedIdentities = @{}
          foreach ($identity in $current.identity.userAssignedIdentities.PSObject.Properties.Name) { $change.identity.userAssignedIdentities[$identity] = @{} }
        }
      }
      Invoke-Change 'Enforce HTTPS, VNet Integration, system-assigned identity and public access from select networks' {
        Invoke-Rest 'PATCH' $site $change
      }
    } else {
      Write-Host 'Web App already has HTTPS, VNet Integration, a system-assigned identity and select-networks access.'
    }
  }
  $principalId = '<new identity>'
  if ($exists -or -not $WhatIfPreference) {
    # The identity is read here, never assigned with "az webapp identity assign" (a whole-site write, see above).
    $attempts = if ($WhatIfPreference) { 1 } else { 12 }
    $found = $null
    for ($try = 0; $try -lt $attempts -and -not $found; $try++) {
      if ($try -gt 0) { Start-Sleep -Seconds 5 }
      $value = "$(& az webapp show --resource-group $ResourceGroup --name $AppName --query identity.principalId -o tsv 2>$null)".Trim()
      if ($LASTEXITCODE -eq 0 -and $value -match '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { $found = $value }
    }
    if ($found) { $principalId = $found }
    elseif (-not $WhatIfPreference) {
      throw "Web App $AppName did not report a system-assigned identity within 60 seconds. Check Identity > System assigned in the portal, then run the same command again."
    }
  }
  $hostName = if ($exists -or -not $WhatIfPreference) {
    Invoke-Az webapp show --resource-group $ResourceGroup --name $AppName --query defaultHostName -o tsv
  } else { "$AppName.azurewebsites.net" }

  Step 'Site configuration, SCM/FTP basic authentication'
  $webConfig = @{
    linuxFxVersion = 'PYTHON|3.12'; alwaysOn = $true; minTlsVersion = '1.2'; ftpsState = 'Disabled'
    healthCheckPath = '/health'; appCommandLine = $startup
    ipSecurityRestrictionsDefaultAction = 'Deny' }
  if ($AllowedClientIps) {
    # An explicit list replaces the rules on the app and on SCM, so IPs the operator added in the portal
    # survive a re-run that does not pass -AllowedClientIps.
    $webConfig.ipSecurityRestrictions = @($restrictions)
    $webConfig.scmIpSecurityRestrictions = @($restrictions)
    $webConfig.scmIpSecurityRestrictionsUseMain = $false
    $webConfig.scmIpSecurityRestrictionsDefaultAction = 'Deny'
  } elseif ($exists) {
    $current = Invoke-Az rest --method get --url "https://management.azure.com$site/config/web?api-version=$api" -o json | ConvertFrom-Json
    $mainAllows = @($current.properties.ipSecurityRestrictions | Where-Object { $_.action -eq 'Allow' }).Count
    $useMain = [bool]$current.properties.scmIpSecurityRestrictionsUseMain
    $scmOpen = if ($useMain) { $mainAllows -eq 0 } else { $current.properties.scmIpSecurityRestrictionsDefaultAction -ne 'Deny' }
    if ($scmOpen) {
      $webConfig.scmIpSecurityRestrictionsUseMain = $false
      $webConfig.scmIpSecurityRestrictionsDefaultAction = 'Deny'
    }
  }
  Invoke-Change 'Apply site configuration' { Invoke-Rest 'PATCH' "$site/config/web" @{ properties = $webConfig } }
  foreach ($policy in 'scm', 'ftp') {
    Invoke-Change "Disable $policy basic authentication" {
      Invoke-Rest 'PUT' "$site/basicPublishingCredentialsPolicies/$policy" @{ properties = @{ allow = $false } }
    }
  }

  Step 'Private Endpoint and DNS integration'
  $peName = if ($PrivateEndpointName) { $PrivateEndpointName } else { "pe-$AppName" }
  $zoneId = $PrivateDnsZoneId
  if (-not $zoneId) {
    # No central zone given: use (or create) privatelink.azurewebsites.net next to the app and link the PE's VNet.
    $zoneName = 'privatelink.azurewebsites.net'
    $zoneId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Network/privateDnsZones/$zoneName"
    & az network private-dns zone show --resource-group $ResourceGroup --name $zoneName -o none 2>$null
    if ($LASTEXITCODE -ne 0) {
      Invoke-Change "Create Private DNS zone $zoneName" { Invoke-Az network private-dns zone create --resource-group $ResourceGroup --name $zoneName -o none }
    }
    $peVnetId = $PrivateEndpointSubnetId -replace '/subnets/[^/]+$', ''
    $linksRaw = & az network private-dns link vnet list --resource-group $ResourceGroup --zone-name $zoneName -o json 2>$null
    $linked = if ($LASTEXITCODE -eq 0 -and $linksRaw) {
      @($linksRaw | ConvertFrom-Json | Where-Object { $_.virtualNetwork.id -ieq $peVnetId })
    } else { @() }
    if (-not $linked) {
      $peVnetName = $peVnetId.Split('/')[-1]
      Invoke-Change "Link $zoneName to VNet $peVnetName" {
        Invoke-Az network private-dns link vnet create --resource-group $ResourceGroup --zone-name $zoneName --name "$peVnetName-link" --virtual-network $peVnetId --registration-enabled false -o none
      }
    }
  } else {
    Write-Host "Using the given Private DNS zone; its VNet links are managed outside this script."
  }
  & az network private-endpoint show --resource-group $ResourceGroup --name $peName -o none 2>$null
  $peExists = $LASTEXITCODE -eq 0
  if (-not $peExists) {
    Invoke-Change "Create Private Endpoint $peName (sites) in $PrivateEndpointSubnetId" {
      Invoke-Az network private-endpoint create --resource-group $ResourceGroup --name $peName --location $location `
        --subnet $PrivateEndpointSubnetId --private-connection-resource-id $site --group-id sites --connection-name "$peName-connection" -o none
    }
  }
  $zoneGroup = $false
  if ($peExists) {
    & az network private-endpoint dns-zone-group show --resource-group $ResourceGroup --endpoint-name $peName --name default -o none 2>$null
    $zoneGroup = $LASTEXITCODE -eq 0
  }
  if (-not $zoneGroup) {
    Invoke-Change "Enable DNS integration (zone group) on $peName" {
      Invoke-Az network private-endpoint dns-zone-group create --resource-group $ResourceGroup --endpoint-name $peName --name default `
        --private-dns-zone $zoneId --zone-name sites -o none
    }
  }

  if ($packagedCapture -and $StorageAccountId -and $packagedCapture.storage.container) {
    $containerName = $packagedCapture.storage.container
    $containerUrl = "https://management.azure.com$StorageAccountId/blobServices/default/containers/$containerName`?api-version=2023-05-01"
    & az rest --method get --url $containerUrl -o none 2>$null
    if ($LASTEXITCODE -ne 0) {
      Invoke-Change "Create Blob container '$containerName' in storage account" {
        Invoke-Rest 'PUT' "$StorageAccountId/blobServices/default/containers/$containerName" @{ properties = @{ publicAccess = 'None' } } '2023-05-01'
      }
    }
  }

  $logging = $null
  if ($WorkspaceId) {
    Step 'Log Analytics table and Data Collection Rule'
    if ($WorkspaceId -notmatch '^/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/Microsoft\.OperationalInsights/workspaces/([^/]+)$') {
      throw '-WorkspaceId must be a Log Analytics workspace resource ID (/subscriptions/.../providers/Microsoft.OperationalInsights/workspaces/<name>)'
    }
    $workspaceSub, $workspaceGroup, $workspaceName = $Matches[1], $Matches[2], $Matches[3]
    $workspaceRaw = Invoke-Az resource show --ids $WorkspaceId -o json | ConvertFrom-Json
    $workspace = @{ location = $workspaceRaw.location; guid = $workspaceRaw.properties.customerId }
    $dcrGroup = $workspaceGroup
    if ($DcrId) {
      if ($DcrId -notmatch '^/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/Microsoft\.Insights/dataCollectionRules/([^/]+)$') { throw '-DcrId must be a Data Collection Rule resource ID' }
      $dcrGroup, $dcrNameResolved = $Matches[2], $Matches[3]
    } else {
      $dcrNameResolved = $DcrName
      $DcrId = "/subscriptions/$workspaceSub/resourceGroups/$workspaceGroup/providers/Microsoft.Insights/dataCollectionRules/$dcrNameResolved"
    }
    # The console requires the DCR to sit in the one configured storage/logging resource group.
    $configuredGroup = if ($packagedCapture) { @($packagedCapture.resource_groups)[0] } else { $null }
    if ($configuredGroup -and $configuredGroup -ine $dcrGroup) {
      throw "The deploy config's resource_groups[0] is '$configuredGroup' but the DCR lives in '$dcrGroup'. The console needs the DCR and the configured resource group to match; fix the config (or -DcrId)."
    }
    # The console reads the storage account inside the configured resource group, so it must live there too.
    if ($configuredGroup -and $StorageAccountId -match '/resourceGroups/([^/]+)/providers/Microsoft\.Storage/storageAccounts/' -and $Matches[1] -ine $configuredGroup) {
      throw "The storage account is in resource group '$($Matches[1])' but the deploy config's resource_groups[0] is '$configuredGroup'. The console looks the storage account up in that group, so Storage, Workspace and DCR must all be in it."
    }
    $dcrPath = "https://management.azure.com$DcrId`?api-version=2023-03-11"
    $tablePath = "https://management.azure.com$WorkspaceId/tables/ArmBackup_CL?api-version=2022-10-01"
    $columns = @(
      @{ name = 'TimeGenerated'; type = 'datetime' }, @{ name = 'RunId'; type = 'string' }, @{ name = 'Level'; type = 'string' },
      @{ name = 'Event'; type = 'string' }, @{ name = 'ResourceId'; type = 'string' }, @{ name = 'Status'; type = 'string' },
      @{ name = 'ErrorCode'; type = 'string' }, @{ name = 'Details'; type = 'dynamic' })

    & az rest --method get --url $tablePath -o none 2>$null
    if ($LASTEXITCODE -ne 0) {
      Invoke-Change "Create the custom table ArmBackup_CL in $workspaceName" {
        Invoke-Rest 'PUT' "$WorkspaceId/tables/ArmBackup_CL" @{ properties = @{ schema = @{ name = 'ArmBackup_CL'; columns = $columns } } } '2022-10-01'
      }
    } else { Write-Host "Table ArmBackup_CL already exists in $workspaceName; leaving it unchanged." }

    & az rest --method get --url $dcrPath -o none 2>$null
    $dcrExists = $LASTEXITCODE -eq 0
    if (-not $dcrExists) {
      Invoke-Change "Create Data Collection Rule $dcrNameResolved (Direct, stream Custom-ArmBackup) in $dcrGroup" {
        # The table can need a moment before a rule may write to it.
        for ($try = 0; $try -lt 12; $try++) {
          $state = & az rest --method get --url $tablePath --query properties.provisioningState -o tsv 2>$null
          if ($LASTEXITCODE -eq 0 -and $state -eq 'Succeeded') { break }
          Start-Sleep -Seconds 10
        }
        Invoke-Rest 'PUT' $DcrId @{
          location = $workspace.location; kind = 'Direct'
          properties = @{
            streamDeclarations = @{ 'Custom-ArmBackup' = @{ columns = $columns } }
            destinations = @{ logAnalytics = @(@{ name = 'workspace'; workspaceResourceId = $WorkspaceId }) }
            dataFlows = @(@{ streams = @('Custom-ArmBackup'); destinations = @('workspace'); transformKql = 'source'; outputStream = 'Custom-ArmBackup_CL' }) } } '2023-03-11'
      }
    } else { Write-Host "Data Collection Rule $dcrNameResolved already exists; using it as it is." }

    if (-not $WhatIfPreference) {
      $dcrObj = Invoke-Az rest --method get --url $dcrPath -o json | ConvertFrom-Json
      $foundRule = $dcrObj.properties.immutableId
      $foundEndpoint = $dcrObj.properties.endpoints.logsIngestion
      $foundStream = @(@($dcrObj.properties.dataFlows)[0].streams)[0]
      if (-not $foundRule -or -not $foundEndpoint -or -not $foundStream) {
        throw "Data Collection Rule $DcrId has no logsIngestion endpoint or input stream. It must be a Direct rule (kind Direct) or be linked to an endpoint (DCE); set the values in the deploy config by hand."
      }
      $logging = @{ dcr_resource_id = $DcrId; endpoint = $foundEndpoint; rule_id = $foundRule; stream = $foundStream }
      Write-Host "Rule $foundRule at $foundEndpoint"
    }
  }

  # Grant roles BEFORE writing Key Vault reference app settings so RBAC propagates first instead of caching AccessToKeyVaultDenied.
  Step 'Roles for the app identity'
  if ($SkipRoles) {
    Write-Warning "Roles skipped: identity $principalId needs the roles in docs/deployment.md section 3 before the app works."
  } else {
    if (-not $SkipSubscriptionRoles) {
      Grant "/subscriptions/$SubscriptionId" 'Reader' 'the subscription'
      Grant "/subscriptions/$SubscriptionId" 'Contributor' 'the subscription'
    }
    Grant $StorageAccountId 'Storage Blob Data Contributor' 'the storage account'
    Grant $WorkspaceId 'Log Analytics Reader' 'the workspace'
    Grant $DcrId 'Monitoring Metrics Publisher' 'the DCR'
    if ($KeyVaultId) { Grant $KeyVaultId 'Key Vault Secrets User' 'the Key Vault' }
    Write-Host 'Role assignments can take a few minutes to take effect.'
  }

  Step "App settings and sign-in mode ($AuthMode)"
  $settings = [ordered]@{
    SCM_DO_BUILD_DURING_DEPLOYMENT      = 'true'
    ENABLE_ORYX_BUILD                   = 'true'
    ORYX_DISABLE_COMPRESSION            = 'true'
    WEBSITES_CONTAINER_START_TIME_LIMIT = '1800'
    ARMBACKUP_AUTH_MODE                 = $AuthMode
  }
  $expectedKvSettingNames = @()
  if ($AuthMode -eq 'password') {
    $stale = 'ARMBACKUP_OPERATOR_ID', 'ARMBACKUP_TENANT_ID', 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
    if ($useDefaultLogin) {
      # Removing both settings is what selects the built-in default; stale custom credentials must not survive.
      $stale += 'ARMBACKUP_AUTH_USERNAME', 'ARMBACKUP_AUTH_PASSWORD_HASH'
    } else {
      $settings.ARMBACKUP_AUTH_USERNAME = $Username
      $settings.ARMBACKUP_AUTH_PASSWORD_HASH = $PasswordHash
      if ($PasswordHash -like '@Microsoft.KeyVault(*') { $expectedKvSettingNames += 'ARMBACKUP_AUTH_PASSWORD_HASH' }
    }
    # The platform sign-in must be off, otherwise it would demand an Entra login before the app's own page.
    $auth = @{ properties = @{ platform = @{ enabled = $false } } }
  } else {
    $settings.ARMBACKUP_OPERATOR_ID = $OperatorObjectId
    $settings.ARMBACKUP_TENANT_ID = $TenantId
    $settings.MICROSOFT_PROVIDER_AUTHENTICATION_SECRET = $ClientSecret
    if ($ClientSecret -like '@Microsoft.KeyVault(*') { $expectedKvSettingNames += 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' }
    $stale = 'ARMBACKUP_AUTH_USERNAME', 'ARMBACKUP_AUTH_PASSWORD_HASH'
    $auth = @{ properties = @{
        platform = @{ enabled = $true }
        globalValidation = @{ requireAuthentication = $true; unauthenticatedClientAction = 'RedirectToLoginPage'
          redirectToProvider = 'azureactivedirectory'; excludedPaths = @('/health') }
        identityProviders = @{ azureActiveDirectory = @{ enabled = $true
            registration = @{ clientId = $ClientId; clientSecretSettingName = 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
              openIdIssuer = "https://login.microsoftonline.com/$TenantId/v2.0" }
            validation = @{ allowedAudiences = @("api://$ClientId", $ClientId)
              defaultAuthorizationPolicy = @{ allowedPrincipals = @{ identities = @($OperatorObjectId) } } } } }
        login = @{ allowedExternalRedirectUrls = @("https://$hostName"); tokenStore = @{ enabled = $true } } } }
  }
  Invoke-Change 'Apply app settings' {
    $existingListRaw = & az webapp config appsettings list --resource-group $ResourceGroup --name $AppName -o json 2>$null
    $existingMap = @{}
    if ($LASTEXITCODE -eq 0 -and $existingListRaw) {
      foreach ($item in ($existingListRaw | ConvertFrom-Json)) { $existingMap[$item.name] = [string]$item.value }
    }
    $needsSet = $false
    foreach ($k in $settings.Keys) {
      if (-not $existingMap.ContainsKey($k) -or $existingMap[$k] -cne [string]$settings[$k]) { $needsSet = $true; break }
    }
    if ($needsSet -or $existingMap.Count -eq 0) {
      $file = Write-TemporaryJson @($settings.Keys | ForEach-Object { @{ name = $_; value = $settings[$_]; slotSetting = $false } })
      Invoke-Az webapp config appsettings set --resource-group $ResourceGroup --name $AppName --settings "@$file" -o none
    }
    $presentStale = @($stale | Where-Object { $existingMap.ContainsKey($_) })
    if ($presentStale.Count -gt 0) {
      Invoke-Az webapp config appsettings delete --resource-group $ResourceGroup --name $AppName --setting-names @presentStale -o none
    }
  }
  Invoke-Change "Apply platform sign-in settings ($AuthMode)" { Invoke-Rest 'PUT' "$site/config/authsettingsV2" $auth }

  if (-not $WhatIfPreference -and $expectedKvSettingNames.Count -gt 0) {
    Step 'Waiting for Key Vault references to resolve'
    # A role assignment takes minutes to propagate. Deploying code before the references resolve makes the
    # app read the reference text as its secret, exit, and the platform then stops the site for good.
    # Calling the configreferences/appsettings/refresh endpoint asks App Service to re-fetch immediately
    # instead of holding a cached AccessToKeyVaultDenied error for 10+ minutes.
    $deadline = (Get-Date).AddMinutes(30)
    $unresolved = @()
    $poll = 0
    do {
      if ($poll -gt 0 -and ($poll % 2 -eq 0)) {
        & az rest --method post --url "https://management.azure.com$site/config/configreferences/appsettings/refresh?api-version=$api" -o none 2>$null
      }
      $rawRefs = & az rest --method get --url "https://management.azure.com$site/config/configreferences/appsettings?api-version=$api" -o json 2>$null
      if ($LASTEXITCODE -ne 0 -or -not $rawRefs) {
        # Right after VNet Integration or app settings changes, App Service can answer 503 ServiceUnavailable (51007) while probing the vault.
        Write-Host '  waiting: App Service is still probing Key Vault references (transient error, retrying)...'
        $poll++
        Start-Sleep -Seconds 15
        continue
      }
      $refsDoc = $rawRefs | ConvertFrom-Json
      $byName = @{}
      foreach ($entry in @($refsDoc.value)) {
        if ($entry.name) { $byName[$entry.name] = $entry.properties }
      }
      $unresolved = @()
      foreach ($reqName in $expectedKvSettingNames) {
        $prop = $byName[$reqName]
        if (-not $prop) {
          $unresolved += [pscustomobject]@{ name = $reqName; status = 'Pending'; details = 'Not reported by App Service yet' }
        } elseif ($prop.status -ne 'Resolved') {
          $unresolved += [pscustomobject]@{ name = $reqName; status = $prop.status; details = $prop.details }
        }
      }
      if ($unresolved.Count -eq 0) { break }
      Write-Host ("  waiting: " + (($unresolved | ForEach-Object { "$($_.name)=$($_.status)" }) -join ', '))
      $poll++
      Start-Sleep -Seconds 15
    } while ((Get-Date) -lt $deadline)
    if ($unresolved.Count -gt 0) {
      throw ("Key Vault reference not resolved: " + (($unresolved | ForEach-Object { "$($_.name): $($_.status) $($_.details)" }) -join '; ') +
        ". Check that the identity $principalId has 'Key Vault Secrets User' (Azure RBAC vault), the vault is reachable from the app's VNet (private endpoint + DNS), and the secret URI exists.")
    }
    Write-Host 'Key Vault references resolved.'
  }
  function Sync-CurrentIpRules($scmTarget, $mainTarget) {
    $seenIps = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    for ($s = 0; $s -lt 4; $s++) {
      foreach ($probeTarget in $scmTarget, $mainTarget) {
        $fip = Get-ForbiddenIp $probeTarget
        if ($fip -match '^\d{1,3}(\.\d{1,3}){3}$') { [void]$seenIps.Add($fip) }
      }
    }
    if ($seenIps.Count -eq 0) { return $false }
    $byPrefix = @{}
    foreach ($ip in $seenIps) {
      $prefix = ($ip -split '\.')[0..2] -join '.'
      if (-not $byPrefix.ContainsKey($prefix)) { $byPrefix[$prefix] = @() }
      $byPrefix[$prefix] += $ip
    }
    $updatedIps = [System.Collections.Generic.List[string]]::new()
    foreach ($existingRule in $script:AllowedClientIps) { [void]$updatedIps.Add($existingRule) }
    $changed = $false
    foreach ($prefix in $byPrefix.Keys) {
      $poolIps = $byPrefix[$prefix]
      $sameSubnetAlready = @($updatedIps | Where-Object { $_ -like "$prefix.*" }).Count -gt 0
      $cidr = if ($poolIps.Count -gt 1 -or $sameSubnetAlready) { "$prefix.0/24" } else { "$($poolIps[0])/32" }
      if ($cidr.EndsWith('/24')) {
        for ($idx = $updatedIps.Count - 1; $idx -ge 0; $idx--) {
          if ($updatedIps[$idx] -like "$prefix.*/32") { $updatedIps.RemoveAt($idx); $changed = $true }
        }
      }
      if ($updatedIps -notcontains $cidr) { [void]$updatedIps.Add($cidr); $changed = $true }
    }
    if (-not $changed) { return $false }
    $script:AllowedClientIps = @($updatedIps)
    Write-Host "Azure App Service saw outbound IP(s) $(($seenIps | Sort-Object) -join ', '); updating IP rules to: $($script:AllowedClientIps -join ', ')"
    $newRules = @()
    for ($index = 0; $index -lt $script:AllowedClientIps.Count; $index++) {
      $newRules += @{ name = "allow-$index"; ipAddress = $script:AllowedClientIps[$index]; action = 'Allow'; priority = 100 + $index }
    }
    Invoke-Rest 'PATCH' "$site/config/web" @{ properties = @{
        ipSecurityRestrictions = @($newRules); ipSecurityRestrictionsDefaultAction = 'Deny'
        scmIpSecurityRestrictions = @($newRules); scmIpSecurityRestrictionsDefaultAction = 'Deny'
        scmIpSecurityRestrictionsUseMain = $false } }
    return $true
  }

  function Wait-ScmReachable($scmTarget, $mainTarget, [bool]$rulesJustChanged) {
    if ($AllowCurrentIp -and (Http-Status $scmTarget) -eq '403') {
      if (Sync-CurrentIpRules $scmTarget $mainTarget) { $rulesJustChanged = $true }
    }
    # When IP rules were just changed, require 5 consecutive non-403 responses across front-end instances;
    # when existing rules were kept untouched, 2 consecutive checks are enough.
    $targetOk = if ($rulesJustChanged) { 5 } else { 2 }
    $maxRounds = if ($rulesJustChanged) { 30 } else { 6 }
    $consecutiveOk = 0
    for ($round = 0; $round -lt $maxRounds -and $consecutiveOk -lt $targetOk; $round++) {
      $code = Http-Status $scmTarget
      if ($code -ne '403' -and $code -ne '000') {
        $consecutiveOk++
        if ($consecutiveOk -lt $targetOk) { Start-Sleep -Seconds 3 }
      } else {
        $consecutiveOk = 0
        if ($AllowCurrentIp -and $code -eq '403') {
          if (Sync-CurrentIpRules $scmTarget $mainTarget) { $rulesJustChanged = $true; $targetOk = 5; $maxRounds = [Math]::Max($maxRounds, $round + 25) }
        }
        Start-Sleep -Seconds 8
      }
    }
    return ($consecutiveOk -ge $targetOk)
  }

  function Invoke-ZipDeployWithRetry($zipFile, $scmTarget, $mainTarget) {
    for ($deployTry = 0; $deployTry -lt 2; $deployTry++) {
      & az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $zipFile --type zip --restart true --track-status false --timeout 1800000 -o none
      if ($LASTEXITCODE -eq 0) { return }
      if ($deployTry -eq 0) {
        Write-Warning 'First zip-deploy attempt failed; re-checking SCM reachability across front-ends and retrying once...'
        Start-Sleep -Seconds 15
        [void](Wait-ScmReachable $scmTarget $mainTarget $true)
      }
    }
    throw "az webapp deploy failed (exit $LASTEXITCODE)"
  }

  if (-not $SkipCode -and -not $WhatIfPreference) {
    $labels = $hostName.Split('.', 2)
    $scmUrl = "https://$($labels[0]).scm.$($labels[1])/"
    $mainProbeUrl = "https://$hostName/health"
    if (-not (Wait-ScmReachable $scmUrl $mainProbeUrl ([bool]$AllowedClientIps))) {
      $blockedIp = Get-ForbiddenIp $scmUrl
      $seenDetail = if ($blockedIp) { "; Azure saw outbound IP $blockedIp" } else { '' }
      throw ("The app (created with public access limited to selected networks) rejects this PC for code deployment (HTTP 403 from $scmUrl$seenDetail). " +
        "Add this PC's outbound IP/CIDR in the portal (Networking > Access restrictions, main site and SCM) or pass -AllowCurrentIp, " +
        "or run from a PC on the VNet, then run the same command again (every step is idempotent).")
    }
  }
  if (-not $SkipCode -and $PackagePath) {
    Step 'Deploying the prebuilt package (the Oryx build can take several minutes)'
    $deployZip = $PackagePath
    if ($logging) {
      # Complete a copy; the delivered zip (and its SHA-256) stays untouched.
      $deployZip = Join-Path ([IO.Path]::GetTempPath()) ('armbackup-' + [guid]::NewGuid().ToString('N') + '.zip')
      Copy-Item -LiteralPath $PackagePath -Destination $deployZip
      $temporary.Add($deployZip)
      Set-PackageLogging $deployZip
    }
    Invoke-Change "Zip-deploy $PackagePath" {
      Invoke-ZipDeployWithRetry $deployZip $scmUrl $mainProbeUrl
    }
  } elseif (-not $SkipCode) {
    Step 'Packaging and deploying code (the Oryx build can take several minutes)'
    $deployConfig = (Resolve-Path $DeployConfigFile).Path
    $git = (& git -C $root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $git -match '^[0-9a-f]{40}$') { $sha = $git }
    $python = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path $python)) { $python = 'python' }
    $zip = Join-Path $root ('dist\deploy-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.zip')
    Invoke-Change "Package and zip-deploy $zip" {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'dist') | Out-Null
      $env:ARMBACKUP_DEPLOY_CONFIG = Get-Content -Raw -Path $deployConfig
      if ($sha) { $env:GITHUB_SHA = $sha } else { Remove-Item Env:GITHUB_SHA -ErrorAction SilentlyContinue }
      & $python (Join-Path $root 'scripts\package_appservice.py') --output $zip
      if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
      Set-PackageLogging $zip
      # The CLI's own startup tracking gives up after 10 minutes and reports failure even for an app that is
      # healthy shortly after (the first Oryx start is slow); the /health wait below is the real check.
      Invoke-ZipDeployWithRetry $zip $scmUrl $mainProbeUrl
    }
  } elseif (-not $SkipRoles) {
    # Key Vault references are resolved on restart; roles were granted after the app first started.
    Invoke-Change 'Restart so Key Vault references are re-read' { Invoke-Az webapp restart --resource-group $ResourceGroup --name $AppName }
  }

  if (-not $SkipVerify -and -not $WhatIfPreference) {
    Step 'Verifying'
    $base = "https://$hostName"
    $blocked = 0
    $healthy = $false
    for ($attempt = 0; $attempt -lt 120 -and -not $healthy; $attempt++) {
      $status = Http-Status "$base/health"
      if ($status -eq '403') {
        if (++$blocked -ge 6) {
          Write-Warning ("Verification skipped: this PC cannot reach $base (HTTP 403, access limited to selected networks). " +
            "Check /health and the sign-in from an allowed IP or a PC on the VNet.")
          return
        }
        Start-Sleep -Seconds 10
        continue
      }
      $blocked = 0
      $body = & $curl -s --max-time 20 "$base/health"
      try {
        $health = $body | ConvertFrom-Json
        $healthy = $health.status -eq 'ok' -and ((-not $sha) -or $health.build -eq $sha.Substring(0, 12))
      } catch { $healthy = $false }
      if (-not $healthy) {
        # The platform stops a site whose first start failed and does not retry on its own.
        if ($attempt % 6 -eq 5 -and (& az webapp show --resource-group $ResourceGroup --name $AppName --query state -o tsv) -eq 'Stopped') {
          Write-Host '  site is stopped; starting it'
          Invoke-Az webapp start --resource-group $ResourceGroup --name $AppName -o none
        }
        Start-Sleep -Seconds 10
      }
    }
    if (-not $healthy) {
      throw "/health did not report a healthy app. Logs: az webapp log tail -g $ResourceGroup -n $AppName"
    }
    # Wait for the initial snapshot collector pass so Storage/Workspace/DCR RBAC or RG mismatches are caught here.
    # On a brand-new identity, subscription/DCR Reader propagation can lag behind Key Vault by ~1 minute, so retry once.
    for ($collectorPass = 0; $collectorPass -lt 2; $collectorPass++) {
      for ($cTry = 0; $cTry -lt 24 -and $health.collector -and $health.collector.state -in 'Starting', 'Running'; $cTry++) {
        Start-Sleep -Seconds 10
        $body = & $curl -s --max-time 20 "$base/health"
        try { $health = $body | ConvertFrom-Json } catch { break }
      }
      if (-not $health.collector -or $health.collector.state -ne 'Failed' -or $collectorPass -eq 1 -or $SkipRoles) { break }
      Write-Host "  initial snapshot collection returned $($health.collector.errorCode); waiting 45s for role propagation and retrying once"
      Start-Sleep -Seconds 45
      Invoke-Az webapp restart --resource-group $ResourceGroup --name $AppName -o none
      Start-Sleep -Seconds 15
      for ($rTry = 0; $rTry -lt 30; $rTry++) {
        $body = & $curl -s --max-time 20 "$base/health"
        try {
          $health = $body | ConvertFrom-Json
          if ($health.status -eq 'ok') { break }
        } catch {}
        Start-Sleep -Seconds 10
      }
    }
    if ($health.collector -and $health.collector.state -eq 'Failed') {
      throw "/health reported initial snapshot collection failure ($($health.collector.errorCode)). Verify Storage/Workspace/DCR permissions and logs (az webapp log download -g $ResourceGroup -n $AppName)."
    }
    $anonymous = Http-Status "$base/api/session"
    if ($anonymous -notin '302', '401', '403') { throw "Anonymous /api/session returned HTTP $anonymous; expected 302, 401 or 403" }
    Write-Host "Healthy. Anonymous API access is rejected (HTTP $anonymous)." -ForegroundColor Green
    Write-Host "Open $base/"
  }
}
finally {
  foreach ($path in $temporary) { Remove-Item -Force -ErrorAction SilentlyContinue $path }
  Remove-Item Env:ARMBACKUP_DEPLOY_CONFIG -ErrorAction SilentlyContinue
}
