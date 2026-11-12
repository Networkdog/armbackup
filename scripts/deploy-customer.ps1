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

  1. Creates (or updates) the Web App on the existing Linux plan with a system-assigned identity.
  2. Applies site settings, app settings (ARMBACKUP_AUTH_MODE ...), sign-in mode, SCM/FTP basic-auth block,
     the Private Endpoint and DNS integration.
  3. Grants the identity its roles on the resources you pass in (skip with -SkipRoles).
  4. Packages the app, zip-deploys it, then checks /health and that anonymous access is rejected.

  Log Analytics: give -WorkspaceId only (no -DcrId) and the script creates what the console needs in the workspace
  resource group: the custom table ArmBackup_CL and a Direct Data Collection Rule (stream Custom-ArmBackup). An existing
  table/DCR with the expected shape is reused; a different one stops the script. The new DCR's rule_id and endpoint are
  written into a COPY of the package right before deployment, so the deploy config needs only the workspace. Pass
  -DcrId to use a DCR somebody else created (required when the workspace accepts private ingestion only).

  Every step is idempotent: running the script again converges the app to the values you pass.
  Use -WhatIf to see every change without making any.

  IP rules: -AllowedClientIps / -AllowCurrentIp REPLACE the app's IP rule list. Without them, existing rules
  (for example IPs the operator added in the portal) are kept and a new app starts with none (deny all).
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
    -StorageAccountId <id> -WorkspaceId <id> -KeyVaultId <id> `
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
  [Parameter(HelpMessage = 'Workspace resource ID. Required unless -SkipRoles and -DcrId are both given')]
  [string]$WorkspaceId,
  [Parameter(HelpMessage = 'Existing DCR. Omit it and the script creates the table and DCR in the workspace resource group')]
  [string]$DcrId,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')][string]$DcrName = 'dcr-armbackup',
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
function Invoke-Rest($method, $path, $body, $version = $api) {
  $file = Write-TemporaryJson $body
  Invoke-Az rest --method $method --url "https://management.azure.com$path`?api-version=$version" --body "@$file" -o none
}
function Get-RestOrNull($path, $version) {
  # $null only for "not found"; every other failure (for example no permission) must stop the deployment.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & az rest --method get --url "https://management.azure.com$path`?api-version=$version" -o json 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  $failure = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join ' '
  if ($code -eq 0) { return (($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n" | ConvertFrom-Json) }
  if ($failure -match 'ResourceNotFound|NotFound|could not be found') { return $null }
  throw "GET $path failed: $failure"
}
function Read-ZipEntryText($archive, $name) {
  $entry = $archive.GetEntry($name)
  if (-not $entry) { throw "The package has no $name" }
  $reader = New-Object IO.StreamReader($entry.Open())
  try { $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Set-PackageLogging([string]$source, [hashtable]$logging) {
  # Works on a copy: the delivered zip (and the SHA-256 the customer checked) stays untouched.
  $copy = Join-Path ([IO.Path]::GetTempPath()) ('armbackup-' + [guid]::NewGuid().ToString('N') + '.zip')
  $temporary.Add($copy)
  Copy-Item -LiteralPath $source -Destination $copy
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($copy, [IO.Compression.ZipArchiveMode]::Update)
  try {
    $node = [System.Text.Json.Nodes.JsonNode]::Parse((Read-ZipEntryText $zip 'hosted/capture.json'))
    $section = $node['logging']
    if (-not $section) { throw 'hosted/capture.json has no logging section' }
    foreach ($key in $logging.Keys) { $section[$key] = [System.Text.Json.Nodes.JsonValue]::Create([string]$logging[$key]) }
    $zip.GetEntry('hosted/capture.json').Delete()
    $writer = New-Object IO.StreamWriter(($zip.CreateEntry('hosted/capture.json')).Open(), (New-Object Text.UTF8Encoding($false)))
    try { $writer.Write($node.ToJsonString()) } finally { $writer.Dispose() }
  } finally { $zip.Dispose() }
  $copy
}
function Test-LogColumns($columns, [switch]$Exact) {
  $expected = [ordered]@{ TimeGenerated = 'datetime'; RunId = 'string'; Level = 'string'; Event = 'string'
    ResourceId = 'string'; Status = 'string'; ErrorCode = 'string'; Details = 'dynamic' }
  $found = @{}
  foreach ($column in @($columns)) { $found[$column.name] = $column.type }
  foreach ($name in $expected.Keys) { if ($found[$name] -ne $expected[$name]) { return $false } }
  # A DCR stream must match exactly (the app compares it); a table may carry extra columns.
  if ($Exact -and $found.Count -ne $expected.Count) { return $false }
  $true
}
$logColumns = @(
  @{ name = 'TimeGenerated'; type = 'datetime' }, @{ name = 'RunId'; type = 'string' }, @{ name = 'Level'; type = 'string' },
  @{ name = 'Event'; type = 'string' }, @{ name = 'ResourceId'; type = 'string' }, @{ name = 'Status'; type = 'string' },
  @{ name = 'ErrorCode'; type = 'string' }, @{ name = 'Details'; type = 'dynamic' })
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
function Http-Status($url) { (& curl.exe -s -o NUL -w '%{http_code}' --max-time 30 $url) }

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
  if (-not $SkipRoles) { Require $StorageAccountId '-StorageAccountId (or -SkipRoles)' }
  if (-not $SkipRoles -or -not $DcrId) { Require $WorkspaceId '-WorkspaceId (or -SkipRoles together with -DcrId)' }
  if (-not $SkipCode -and -not $PackagePath) { Require $DeployConfigFile '-DeployConfigFile or -PackagePath (or -SkipCode)' }
  $packageConsole = $null
  $packageCapture = $null
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
      $packageConsole = Read-ZipEntryText $archive 'hosted/console.json' | ConvertFrom-Json
      $packageCapture = Read-ZipEntryText $archive 'hosted/capture.json' | ConvertFrom-Json
      $marker = $archive.Entries | Where-Object { $_.FullName -eq 'hosted/build.json' }
      if ($marker) {
        $reader = New-Object IO.StreamReader($marker.Open())
        try { $packagedCommit = ($reader.ReadToEnd() | ConvertFrom-Json).commit } finally { $reader.Dispose() }
        if ($packagedCommit -match '^[0-9a-f]{7,40}$') { $sha = $packagedCommit }
      }
    } finally { $archive.Dispose() }
  } elseif (-not $SkipCode) {
    if (-not (Test-Path -LiteralPath $DeployConfigFile -PathType Leaf)) { throw "-DeployConfigFile not found: $DeployConfigFile" }
    $deployConfigObject = Get-Content -Raw -LiteralPath $DeployConfigFile | ConvertFrom-Json
    $packageConsole = $deployConfigObject.console
    $packageCapture = $deployConfigObject.capture
  }
  if ($AllowCurrentIp) {
    # Only this PC's public address is looked up; nothing about the deployment is sent.
    $current = $null
    foreach ($service in 'https://api.ipify.org', 'https://checkip.amazonaws.com') {
      try { $current = (Invoke-RestMethod -Uri $service -TimeoutSec 15).ToString().Trim(); if ($current -match '^\d{1,3}(\.\d{1,3}){3}$') { break } } catch { $current = $null }
    }
    if ($current -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Could not determine this PC''s public IP for -AllowCurrentIp; pass it in -AllowedClientIps instead' }
    if ($AllowedClientIps -notcontains "$current/32") { $AllowedClientIps = @($AllowedClientIps) + "$current/32" }
    Write-Host "Allowing this PC ($current) for the deployment. Re-run without -AllowCurrentIp (and with -SkipCode) to remove it."
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

  Step 'Log Analytics: workspace, table and DCR'
  $logging = $null
  $managedDcr = $false
  if ($WorkspaceId) {
    if ($WorkspaceId -notmatch '^/subscriptions/([^/]+)/resourcegroups/([^/]+)/providers/microsoft\.operationalinsights/workspaces/([^/]+)$') {
      throw '-WorkspaceId must be a Log Analytics workspace resource ID (/subscriptions/.../providers/Microsoft.OperationalInsights/workspaces/<name>)'
    }
    $workspaceSubscription, $workspaceGroup, $workspaceName = $Matches[1], $Matches[2], $Matches[3]
    if ($workspaceSubscription -ine $SubscriptionId) {
      throw "The workspace is in subscription $workspaceSubscription but -SubscriptionId is $SubscriptionId; the console reads the workspace and DCR from one subscription."
    }
    $workspace = Get-RestOrNull $WorkspaceId '2022-10-01'
    if (-not $workspace) { throw "Log Analytics workspace not found: $WorkspaceId" }
    $workspaceCanonical = $workspace.id
    $workspaceLocation = ($workspace.location -replace '\s', '').ToLowerInvariant()
    # What the settings say must describe this workspace; a mix-up here only shows when the app refuses to start.
    if ($packageConsole -and $packageConsole.workspace_guid -ine $workspace.properties.customerId) {
      throw "console.workspace_guid ($($packageConsole.workspace_guid)) is not the workspace GUID ($($workspace.properties.customerId)) of -WorkspaceId."
    }
    if ($packageCapture) {
      if (@($packageCapture.subscriptions).Count -ne 1 -or $packageCapture.subscriptions[0] -ine $SubscriptionId) {
        throw "capture.subscriptions must be exactly [$SubscriptionId]."
      }
      if (@($packageCapture.resource_groups).Count -ne 1 -or $packageCapture.resource_groups[0] -ine $workspaceGroup) {
        throw "capture.resource_groups must be exactly [$workspaceGroup]: the workspace and the DCR must be in the resource group the console is configured with."
      }
      if ($packageCapture.logging.workspace_resource_id -ine $workspaceCanonical) {
        throw "capture.logging.workspace_resource_id does not match -WorkspaceId."
      }
    }
    if ($DcrId) {
      if ($DcrId -notmatch "^/subscriptions/$SubscriptionId/resourcegroups/$([regex]::Escape($workspaceGroup))/providers/microsoft\.insights/datacollectionrules/[^/]+$") {
        throw "-DcrId must be a DCR in resource group $workspaceGroup (the same one as the workspace)."
      }
      Write-Host "Using the existing DCR $DcrId (its settings come from the package)."
    } else {
      $managedDcr = $true
      if ($workspace.properties.publicNetworkAccessForIngestion -ne 'Enabled') {
        throw ("The workspace does not accept public ingestion (publicNetworkAccessForIngestion = $($workspace.properties.publicNetworkAccessForIngestion)). " +
          "A Direct DCR cannot deliver logs then; a Data Collection Endpoint with Azure Monitor Private Link is needed. " +
          "Have that DCR created by the platform team and pass it with -DcrId (see docs/deployment.md section 4).")
      }
      $workspaceBase = $workspaceCanonical -replace '(?i)/providers/.*$', ''
      $DcrId = "$workspaceBase/providers/Microsoft.Insights/dataCollectionRules/$DcrName"
      $tablePath = "$workspaceCanonical/tables/ArmBackup_CL"
      $table = Get-RestOrNull $tablePath '2022-10-01'
      if ($table) {
        if (-not (Test-LogColumns (@($table.properties.schema.columns) + @($table.properties.schema.standardColumns)))) {
          throw "Table ArmBackup_CL exists in $workspaceName with a different schema. Remove it or use another workspace."
        }
        Write-Host 'Table ArmBackup_CL already exists with the expected schema; reusing it.'
      } else {
        Invoke-Change "Create custom table ArmBackup_CL in workspace $workspaceName" {
          Invoke-Rest 'PUT' $tablePath @{ properties = @{ schema = @{ name = 'ArmBackup_CL'; columns = $logColumns } } } '2022-10-01'
          # Table creation is asynchronous and the DCR below cannot be created before the table exists.
          $created = $null
          for ($attempt = 0; $attempt -lt 30 -and -not $created; $attempt++) {
            $state = Get-RestOrNull $tablePath '2022-10-01'
            if ($state -and $state.properties.provisioningState -eq 'Succeeded') { $created = $true } else { Start-Sleep -Seconds 10 }
          }
          if (-not $created) { throw 'Table ArmBackup_CL was not ready after 5 minutes.' }
        }
      }
      $dcr = Get-RestOrNull $DcrId '2023-03-11'
      if ($dcr) {
        $props = $dcr.properties
        $declared = $props.streamDeclarations.'Custom-ArmBackup'
        $names = @($props.destinations.logAnalytics | Where-Object { $_.workspaceResourceId -ieq $workspaceCanonical } | ForEach-Object { $_.name })
        $flows = @($props.dataFlows | Where-Object { $_.streams -contains 'Custom-ArmBackup' })
        $routed = $flows.Count -gt 0 -and -not (@($flows | Where-Object {
              -not $_.destinations -or @($_.destinations | Where-Object { $names -notcontains $_ }).Count -gt 0 -or
              ($_.transformKql -and $_.transformKql.Trim() -ne 'source') }))
        if (-not $declared -or -not (Test-LogColumns $declared.columns -Exact) -or -not $routed) {
          throw "DCR $DcrName already exists but is not an armbackup DCR (stream Custom-ArmBackup routed unchanged to this workspace). Use -DcrName for another name, or -DcrId to use it as is."
        }
        Write-Host "DCR $DcrName already exists with the expected stream and destination; reusing it."
      } else {
        Invoke-Change "Create Data Collection Rule $DcrName (Direct; stream Custom-ArmBackup to table ArmBackup_CL)" {
          $body = @{ location = $workspaceLocation; kind = 'Direct'; properties = @{
              streamDeclarations = @{ 'Custom-ArmBackup' = @{ columns = $logColumns } }
              destinations = @{ logAnalytics = @(@{ name = 'workspace'; workspaceResourceId = $workspaceCanonical }) }
              dataFlows = @(@{ streams = @('Custom-ArmBackup'); destinations = @('workspace'); transformKql = 'source'; outputStream = 'Custom-ArmBackup_CL' }) } }
          # A new table can take a short while to be visible to the DCR service.
          for ($attempt = 1; $attempt -le 6; $attempt++) {
            try { Invoke-Rest 'PUT' $DcrId $body '2023-03-11'; break }
            catch { if ($attempt -eq 6 -or "$_" -notmatch 'Table|OutputStream|InvalidPayload') { throw }; Start-Sleep -Seconds 20 }
          }
        }
        $dcr = Get-RestOrNull $DcrId '2023-03-11'
      }
      if ($dcr -and $dcr.properties.immutableId -and $dcr.properties.endpoints.logsIngestion) {
        $logging = @{ workspace_resource_id = $workspaceCanonical; dcr_resource_id = $DcrId
          endpoint = $dcr.properties.endpoints.logsIngestion.TrimEnd('/'); rule_id = $dcr.properties.immutableId; stream = 'Custom-ArmBackup' }
        Write-Host "DCR ready: rule_id $($logging.rule_id)"
      } elseif (-not $WhatIfPreference) {
        throw "DCR $DcrName was created but reports no immutableId/endpoint yet; run the same command again."
      } else {
        $logging = @{ workspace_resource_id = $workspaceCanonical; dcr_resource_id = $DcrId
          endpoint = '<set at deployment>'; rule_id = '<set at deployment>'; stream = 'Custom-ArmBackup' }
      }
    }
  } else {
    Write-Host 'No -WorkspaceId: the workspace and DCR from the package are used as they are.'
  }
  if ($packageCapture) {
    # Sample values left in the settings make the app refuse to start; stop before anything is created.
    $checked = $packageCapture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    if ($managedDcr) { foreach ($field in 'dcr_resource_id', 'endpoint', 'rule_id') { $checked.logging.PSObject.Properties.Remove($field) } }
    $placeholder = [regex]::Match((@($checked, $packageConsole) | ConvertTo-Json -Depth 10), '00000000-0000-0000-0000-[0-9a-f]+|xxxx|dcr-0{8,}')
    if ($placeholder.Success) { throw "The settings still contain a sample placeholder value ($($placeholder.Value)). Replace it in the deploy config and build the package again." }
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
    Invoke-Change 'Enforce HTTPS, VNet Integration and public access from select networks' {
      Invoke-Rest 'PATCH' $site @{ properties = @{ httpsOnly = $true; publicNetworkAccess = 'Enabled'; virtualNetworkSubnetId = $VnetSubnetId } }
    }
  }
  $principalId = '<new identity>'
  if ($exists -or -not $WhatIfPreference) {
    $principalId = Invoke-Az webapp identity assign --resource-group $ResourceGroup --name $AppName --query principalId -o tsv
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
    $linked = & az network private-dns link vnet list --resource-group $ResourceGroup --zone-name $zoneName --query "[?virtualNetwork.id=='$peVnetId' || virtualNetwork.id=='$($peVnetId.ToLower())'].name" -o tsv 2>$null
    if (-not $linked) {
      $peVnetName = $peVnetId.Split('/')[-1]
      Invoke-Change "Link $zoneName to VNet $peVnetName" {
        Invoke-Az network private-dns link vnet create --resource-group $ResourceGroup --zone-name $zoneName --name "$peVnetName-link" --virtual-network $peVnetId --registration-enabled false -o none
      }
    }
  } else {
    Write-Host "Using the given Private DNS zone; its VNet links are managed outside this script."
  }
  $peExists = $false
  if ($exists) {
    & az network private-endpoint show --resource-group $ResourceGroup --name $peName -o none 2>$null
    $peExists = $LASTEXITCODE -eq 0
  }
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

  Step "App settings and sign-in mode ($AuthMode)"
  $settings = [ordered]@{
    SCM_DO_BUILD_DURING_DEPLOYMENT      = 'true'
    ENABLE_ORYX_BUILD                   = 'true'
    ORYX_DISABLE_COMPRESSION            = 'true'
    WEBSITES_CONTAINER_START_TIME_LIMIT = '1800'
    ARMBACKUP_AUTH_MODE                 = $AuthMode
  }
  if ($AuthMode -eq 'password') {
    $stale = 'ARMBACKUP_OPERATOR_ID', 'ARMBACKUP_TENANT_ID', 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
    if ($useDefaultLogin) {
      # Removing both settings is what selects the built-in default; stale custom credentials must not survive.
      $stale += 'ARMBACKUP_AUTH_USERNAME', 'ARMBACKUP_AUTH_PASSWORD_HASH'
    } else {
      $settings.ARMBACKUP_AUTH_USERNAME = $Username
      $settings.ARMBACKUP_AUTH_PASSWORD_HASH = $PasswordHash
    }
    # The platform sign-in must be off, otherwise it would demand an Entra login before the app's own page.
    $auth = @{ properties = @{ platform = @{ enabled = $false } } }
  } else {
    $settings.ARMBACKUP_OPERATOR_ID = $OperatorObjectId
    $settings.ARMBACKUP_TENANT_ID = $TenantId
    $settings.MICROSOFT_PROVIDER_AUTHENTICATION_SECRET = $ClientSecret
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
    $file = Write-TemporaryJson @($settings.Keys | ForEach-Object { @{ name = $_; value = $settings[$_]; slotSetting = $false } })
    Invoke-Az webapp config appsettings set --resource-group $ResourceGroup --name $AppName --settings "@$file" -o none
    Invoke-Az webapp config appsettings delete --resource-group $ResourceGroup --name $AppName --setting-names @stale -o none
  }
  Invoke-Change "Apply platform sign-in settings ($AuthMode)" { Invoke-Rest 'PUT' "$site/config/authsettingsV2" $auth }

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

  if (-not $WhatIfPreference) {
    $references = @(@($PasswordHash, $ClientSecret) | Where-Object { $_ -like '@Microsoft.KeyVault(*' })
    if ($references.Count -gt 0) {
      Step 'Waiting for Key Vault references to resolve'
      # A role assignment takes minutes to propagate. Deploying code before the references resolve makes the
      # app read the reference text as its secret, exit, and the platform then stops the site for good.
      $deadline = (Get-Date).AddMinutes(30)
      $unresolved = @()
      do {
        $found = Invoke-Az rest --method get --url "https://management.azure.com$site/config/configreferences/appsettings?api-version=$api" --query 'value[].{name:name,status:properties.status,details:properties.details}' -o json | ConvertFrom-Json
        $unresolved = @($found | Where-Object { $_.status -ne 'Resolved' })
        if ($unresolved.Count -eq 0) { break }
        Write-Host ("  waiting: " + (($unresolved | ForEach-Object { "$($_.name)=$($_.status)" }) -join ', '))
        Start-Sleep -Seconds 20
      } while ((Get-Date) -lt $deadline)
      if ($unresolved.Count -gt 0) {
        throw ("Key Vault reference not resolved: " + (($unresolved | ForEach-Object { "$($_.name): $($_.status) $($_.details)" }) -join '; ') +
          ". Check that the identity $principalId has 'Key Vault Secrets User' (Azure RBAC vault), the vault is reachable from the app's VNet (private endpoint + DNS), and the secret URI exists.")
      }
      Write-Host 'Key Vault references resolved.'
    }
  }
  if (-not $SkipCode -and -not $WhatIfPreference) {
    # The app only accepts selected networks. A deployment PC that is neither in an IP rule nor on the VNet gets an
    # opaque HTTP 403 from the deployment service, so check the SCM site first and say what to do. IP rule changes
    # take about a minute to apply, so wait only when this run just changed them.
    $labels = $hostName.Split('.', 2)
    $scmUrl = "https://$($labels[0]).scm.$($labels[1])/"
    $reachable = $false
    $attempts = if ($AllowedClientIps) { 18 } else { 3 }
    for ($attempt = 0; $attempt -lt $attempts -and -not $reachable; $attempt++) {
      $code = (& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 $scmUrl)
      if ($code -ne '403') { $reachable = $true } else { Start-Sleep -Seconds 10 }
    }
    if (-not $reachable) {
      throw ("The app (created with public access limited to selected networks) rejects this PC for code deployment (HTTP 403 from $scmUrl). " +
        "Add this PC's public IP in the portal (Networking > Access restrictions, main site and SCM) or pass -AllowCurrentIp, " +
        "or run from a PC on the VNet, then run the same command again (every step is idempotent).")
    }
  }
  if (-not $SkipCode -and $PackagePath) {
    Step 'Deploying the prebuilt package (the Oryx build can take several minutes)'
    Invoke-Change "Zip-deploy $PackagePath" {
      $deployZip = $PackagePath
      if ($managedDcr) {
        # The DCR did not exist when the package was built: its identifiers go into a copy of the package.
        $deployZip = Set-PackageLogging $PackagePath $logging
        Write-Host 'Package settings completed with the DCR created above (the original zip is unchanged).'
      }
      Invoke-Az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $deployZip --type zip --restart true --track-status false --timeout 1800000 -o none
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
      $deployZip = $zip
      if ($managedDcr) {
        $deployZip = Set-PackageLogging $zip $logging
        Write-Host 'Package settings completed with the DCR created above.'
      }
      # The CLI's own startup tracking gives up after 10 minutes and reports failure even for an app that is
      # healthy shortly after (the first Oryx start is slow); the /health wait below is the real check.
      Invoke-Az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $deployZip --type zip --restart true --track-status false --timeout 1800000 -o none
    }
  } elseif (-not $SkipRoles) {
    if ($managedDcr) {
      Write-Warning ("-SkipCode: the DCR exists, but the deployed app does not know it yet. Deploy the code again without -SkipCode " +
        "(or set capture.logging to dcr_resource_id=$($logging.dcr_resource_id), rule_id=$($logging.rule_id), endpoint=$($logging.endpoint)).")
    }
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
      $body = & curl.exe -s --max-time 20 "$base/health"
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
