<#
.SYNOPSIS
  Deploys armbackup to an App Service Plan, Storage, Workspace/DCR and Key Vault that already exist.
  One file, Azure CLI only (no Bicep or parameter files).

.DESCRIPTION
  1. Creates (or updates) the Web App on the existing Linux plan with a system-assigned identity.
  2. Applies site settings, app settings (ARMBACKUP_AUTH_MODE ...), sign-in mode, IP restrictions,
     VNet Integration and blocks SCM/FTP basic authentication.
  3. Grants the identity its roles on the resources you pass in (skip with -SkipRoles).
  4. Packages the app, zip-deploys it, then checks /health and that anonymous access is rejected.

  Every step is idempotent: running the script again converges the app to the values you pass.
  Use -WhatIf to see every change without making any.

  Secrets: pass an @Microsoft.KeyVault(SecretUri=...) reference as -PasswordHash / -ClientSecret, or set the
  environment variables ARMBACKUP_AUTH_PASSWORD_HASH / ARMBACKUP_ENTRA_CLIENT_SECRET. Values are written only to a
  temporary file that is deleted at the end.

  Default sign-in: when both -Username and -PasswordHash are omitted, the script removes those two app settings
  and the app starts with its temporary built-in login admin / password. Pass both to use your own credentials.

.EXAMPLE
  # Password sign-in, only the customer office can reach the app
  .\scripts\deploy-customer.ps1 -SubscriptionId <id> -ResourceGroup rg-armbackup -AppName app-armbackup-acme `
    -AppServicePlanId <plan id> -VnetSubnetId <subnet id> -AuthMode password -Username ops.admin `
    -PasswordHash '@Microsoft.KeyVault(SecretUri=https://kv-acme.vault.azure.net/secrets/armbackup-hash/)' `
    -AllowedClientIps 203.0.113.10/32 `
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
  [string]$VnetSubnetId,
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
function Invoke-Rest($method, $path, $body) {
  $file = Write-TemporaryJson $body
  Invoke-Az rest --method $method --url "https://management.azure.com$path`?api-version=$api" --body "@$file" -o none
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
  if (-not $SkipRoles) {
    Require $StorageAccountId '-StorageAccountId (or -SkipRoles)'
    Require $WorkspaceId '-WorkspaceId (or -SkipRoles)'
    Require $DcrId '-DcrId (or -SkipRoles)'
  }
  if (-not $SkipCode -and -not $PackagePath) { Require $DeployConfigFile '-DeployConfigFile or -PackagePath (or -SkipCode)' }
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
      $marker = $archive.Entries | Where-Object { $_.FullName -eq 'hosted/build.json' }
      if ($marker) {
        $reader = New-Object IO.StreamReader($marker.Open())
        try { $packagedCommit = ($reader.ReadToEnd() | ConvertFrom-Json).commit } finally { $reader.Dispose() }
        if ($packagedCommit -match '^[0-9a-f]{7,40}$') { $sha = $packagedCommit }
      }
    } finally { $archive.Dispose() }
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
  if (-not $AllowedClientIps) {
    Write-Warning 'No -AllowedClientIps: the sign-in page is reachable from the whole internet.'
  }

  Step 'Checking Azure CLI context'
  Invoke-Az account set --subscription $SubscriptionId
  Invoke-Az group show --name $ResourceGroup --query name -o tsv | Out-Null
  $site = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AppName"
  & az webapp show --resource-group $ResourceGroup --name $AppName --query name -o tsv 2>$null | Out-Null
  $exists = $LASTEXITCODE -eq 0

  Step 'Web App'
  if (-not $exists) {
    Invoke-Change "Create Web App on $AppServicePlanId" {
      Invoke-Az webapp create --resource-group $ResourceGroup --name $AppName --plan $AppServicePlanId --runtime 'PYTHON:3.12' -o none
    }
  }
  Invoke-Change 'Require HTTPS' { Invoke-Az webapp update --resource-group $ResourceGroup --name $AppName --https-only true -o none }
  $principalId = '<new identity>'
  if ($exists -or -not $WhatIfPreference) {
    $principalId = Invoke-Az webapp identity assign --resource-group $ResourceGroup --name $AppName --query principalId -o tsv
  }
  $hostName = if ($exists -or -not $WhatIfPreference) {
    Invoke-Az webapp show --resource-group $ResourceGroup --name $AppName --query defaultHostName -o tsv
  } else { "$AppName.azurewebsites.net" }

  Step 'Site configuration, IP restrictions, SCM/FTP basic authentication'
  $restrictions = @()
  for ($index = 0; $index -lt $AllowedClientIps.Count; $index++) {
    $restrictions += @{ name = "allow-$index"; ipAddress = $AllowedClientIps[$index]; action = 'Allow'; priority = 100 + $index }
  }
  Invoke-Change 'Apply site configuration' {
    Invoke-Rest 'PATCH' "$site/config/web" @{ properties = @{
        linuxFxVersion = 'PYTHON|3.12'; alwaysOn = $true; minTlsVersion = '1.2'; ftpsState = 'Disabled'
        healthCheckPath = '/health'; appCommandLine = $startup
        ipSecurityRestrictions = $restrictions
        ipSecurityRestrictionsDefaultAction = $(if ($restrictions.Count) { 'Deny' } else { 'Allow' })
        scmIpSecurityRestrictionsUseMain = $true } }
  }
  foreach ($policy in 'scm', 'ftp') {
    Invoke-Change "Disable $policy basic authentication" {
      Invoke-Rest 'PUT' "$site/basicPublishingCredentialsPolicies/$policy" @{ properties = @{ allow = $false } }
    }
  }
  if ($VnetSubnetId) {
    Invoke-Change "VNet Integration into $VnetSubnetId" {
      Invoke-Rest 'PUT' "$site/networkConfig/virtualNetwork" @{ properties = @{ subnetResourceId = $VnetSubnetId; swiftSupported = $true } }
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
      $deadline = (Get-Date).AddMinutes(15)
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
  if (-not $SkipCode -and -not $WhatIfPreference -and $AllowedClientIps) {
    # Access restriction changes take a minute to apply. A blocked deployment PC gets an opaque HTTP 403 from the
    # deployment service, so check the SCM site first and say what to do.
    $labels = $hostName.Split('.', 2)
    $scmUrl = "https://$($labels[0]).scm.$($labels[1])/"
    $reachable = $false
    for ($attempt = 0; $attempt -lt 18 -and -not $reachable; $attempt++) {
      $code = (& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 $scmUrl)
      if ($code -ne '403') { $reachable = $true } else { Start-Sleep -Seconds 10 }
    }
    if (-not $reachable) {
      throw "The deployment site $scmUrl rejects this PC (HTTP 403): its public IP is not in -AllowedClientIps. Add it, or pass -AllowCurrentIp, or run from an allowed network."
    }
  }
  if (-not $SkipCode -and $PackagePath) {
    Step 'Deploying the prebuilt package (the Oryx build can take several minutes)'
    Invoke-Change "Zip-deploy $PackagePath" {
      Invoke-Az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $PackagePath --type zip --restart true --track-status false --timeout 1800000 -o none
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
      # The CLI's own startup tracking gives up after 10 minutes and reports failure even for an app that is
      # healthy shortly after (the first Oryx start is slow); the /health wait below is the real check.
      Invoke-Az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $zip --type zip --restart true --track-status false --timeout 1800000 -o none
    }
  } elseif (-not $SkipRoles) {
    # Key Vault references are resolved on restart; roles were granted after the app first started.
    Invoke-Change 'Restart so Key Vault references are re-read' { Invoke-Az webapp restart --resource-group $ResourceGroup --name $AppName }
  }

  if (-not $SkipVerify -and -not $WhatIfPreference) {
    Step 'Verifying'
    $base = "https://$hostName"
    $healthy = $false
    for ($attempt = 0; $attempt -lt 120 -and -not $healthy; $attempt++) {
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
      throw "/health did not report a healthy app. With -AllowedClientIps run this from an allowed IP. Logs: az webapp log tail -g $ResourceGroup -n $AppName"
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
