<#
.SYNOPSIS
  Single-shot Azure App Service (Linux) provisioning & .ZIP deployment for Configuration Vault / armbackup
  (KT Landing Zone & Enterprise Shared Infra ready — shares space cleanly with azfirewallagent).

.DESCRIPTION
  Deploys Configuration Vault (armbackup) onto an existing shared Linux App Service Plan (with shared Storage Account,
  Key Vault, Log Analytics Workspace, and VNet/Private Endpoints) or provisions standalone resources in one idempotent run.

  Key enterprise & KT Azure Policy guarantees:
    1. Dedicated per-project Resource Group: deploys only project-owned resources (Linux Web App, inbound 'sites'
       Private Endpoint, Diagnostic Settings) into the project's dedicated Resource Group while connecting to shared
       App Service Plan, Storage Account, Log Analytics Workspace, and Key Vault in the common Resource Group.
    2. 3-Stage App Service Network Lifecycle:
       - Stage 1 (Create): App Service is ALWAYS created with Public Network Access = 'Disabled' on initial PUT.
       - Stage 2 (Configure Select Networks & Allowed IPs): Once created, switches App Service Public Network Access
         to 'Enabled' ('Enabled from select virtual networks and IP addresses') with allowed IPs (e.g. 211.47.20.25/32,
         211.47.20.26/32) and Unmatched rule action = 'Deny' on both main site and SCM, then verifies ARM & SCM state.
       - Stage 3 (Deploy): Starts direct Kudu .ZIP code deployment only after the allowed IP rules are verified active.
    3. Zero Deployer Storage Data-Plane Access & Disabled-Only Storage Policy:
       - Storage Account Public Network Access is strictly 'Disabled' (any non-Disabled Storage Account is rejected).
       - Never accesses Storage Data Plane from the deployer PC (zero deployer blob writes, no SAS tokens, no Storage IP rules).
       - App Service Startup code (startup.sh -> armbackup.webui -> bootstrap_storage) initializes the isolated Blob
         container (<namespace>-backups) and any startup seed blobs privately over VNet Integration -> Blob PE.

.EXAMPLE
  # Zero-flag execution using ./deploy.config.json in the extracted customer kit:
  .\Deploy-AppService.ps1

.EXAMPLE
  # Dry-run ARM what-if preview without modifying Azure resources:
  .\Deploy-AppService.ps1 -WhatIfPreview
#>
[CmdletBinding()]
param(
  [string]$ConfigFile,
  [string]$Name,
  [string]$ResourceGroup,
  [string]$Location,
  [string]$SubscriptionId,
  [string]$AppServicePlan,
  [string]$AppServicePlanResourceGroup,
  [string]$AppServicePlanSku = 'P0v3',
  [string]$KeyVaultName,
  [string]$KeyVaultResourceGroup,
  [string]$StorageAccountName,
  [string]$StorageAccountResourceGroup,
  [string]$LogAnalyticsWorkspace,
  [string]$LogAnalyticsWorkspaceResourceGroup,
  [string]$StorageNamespace,
  [string]$StorageContainerName = '',
  [string]$StorageBlobPrefix = 'armbackup',
  [string]$WorkspaceDisplayName = 'KT',
  [string]$TargetSubscriptionId = '',
  [string]$TargetSubscriptionName = '',
  [bool]$RestoreEnabled = $false,
  [int]$ActivityDays = 2,
  [ValidateSet('Disabled', 'Enabled')][string]$WebAppPublicNetworkAccess = 'Disabled',
  [string[]]$AllowedIpCidrs = @(),
  [switch]$AutoDiscoverShared,
  [switch]$ProvisionInfra,
  [switch]$WhatIfPreview,
  [string]$VnetIntegrationSubnetId,
  [string]$VnetIntegrationSubnetName = '',
  [string]$VnetIntegrationSubnetPrefix = '',
  [bool]$VnetRouteAllEnabled = $false,
  [string]$PrivateEndpointSubnetId,
  [string]$PrivateEndpointResourceGroup,
  [bool]$EnableWebAppPrivateEndpoint = $true,
  [switch]$CreateMissingStoragePrivateEndpoints,
  [bool]$CreateMissingSharedPrivateEndpoints = $true,
  [bool]$ResourceScopedDataPlaneRbac = $true,
  [ValidateSet('3.12', '3.13', '3.14')][string]$PythonVersion = '3.12',
  [ValidateSet('password')][string]$AuthProvider = 'password',
  [string]$AdminUsername = 'admin',
  [securestring]$AdminPassword,
  [switch]$RotateAdminPassword,
  [string]$LogWorkspaceGuid = '',
  [string]$LogDcrId = '',
  [string]$LogRuleId = '',
  [string]$LogEndpoint = '',
  [string]$LogStream = '',
  [switch]$OryxBuild,
  [switch]$NoWaitHealth,
  [string]$PackagePath,
  [string]$PackageUri,
  [switch]$SkipBuild,
  [switch]$AssignRoleAssignments,
  [switch]$SkipRoleAssignments,
  [hashtable]$Tags = @{}
)

$ErrorActionPreference = 'Stop'
$parentDir = Split-Path -Parent $PSScriptRoot
$candidateRoot = if ($parentDir) { Split-Path -Parent $parentDir } else { $null }
$repoRoot = if ($candidateRoot -and (Test-Path $candidateRoot) -and (Test-Path (Join-Path $candidateRoot 'pyproject.toml'))) {
  (Resolve-Path $candidateRoot).Path
} else {
  $null
}
$roles = @{
  Reader      = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  Contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
  BlobData    = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  SecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
  LogReader   = '73c42c96-874c-492b-b04d-ab87d138a893'
  MetricsPub  = '3913510d-42f4-4e42-8a64-420c390055eb'
}
$tempFiles = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

function New-TempFile([string]$Content) {
  $path = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllText($path, $Content, (New-Object Text.UTF8Encoding($false)))
  $tempFiles.Add($path)
  return $path
}

function Invoke-Az {
  $allowFailure = $args -contains '-AllowFailure'
  $azArguments = @($args | Where-Object { $_ -ne '-AllowFailure' })
  $errFile = [IO.Path]::GetTempFileName()
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $stdout = & az @azArguments 2>$errFile
    $code = $LASTEXITCODE
    $stderr = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
  } finally {
    $ErrorActionPreference = $previousPreference
    Remove-Item $errFile -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) {
    if ($allowFailure) { return $null }
    throw "az $($azArguments -join ' ') failed (exit $code): $stderr"
  }
  return ($stdout -join "`n")
}

function Invoke-AzJson {
  $text = Invoke-Az @args -o json
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return ($text | ConvertFrom-Json) | ForEach-Object { $_ }
}

function Get-StableApiVersion([string]$TypeOrId) {
  $lower = $TypeOrId.ToLowerInvariant()
  if ($lower -match 'microsoft\.storage/storageaccounts') { return '2025-06-01' }
  if ($lower -match 'microsoft\.keyvault/vaults') { return '2023-07-01' }
  if ($lower -match 'microsoft\.web/') { return '2023-12-01' }
  if ($lower -match 'microsoft\.network/privateendpoints') { return '2024-05-01' }
  if ($lower -match 'microsoft\.operationalinsights/workspaces') { return '2023-09-01' }
  return ''
}

function Resolve-ResourceId([string]$Value, [string]$Type, [string]$Group) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  if ($Value -like '/subscriptions/*') { return $Value.Trim() }
  if ($Group) {
    $apiVer = Get-StableApiVersion $Type
    $extra = if ($apiVer) { @('--api-version', $apiVer) } else { @() }
    $id = Invoke-Az resource show -g $Group -n $Value --resource-type $Type @extra --query id -o tsv -AllowFailure
    if ($id) { return $id.Trim() }
    throw "$Type '$Value' was not found in resource group '$Group'."
  }
  $found = @(Invoke-AzJson resource list --name $Value --resource-type $Type | Where-Object { $_.name -eq $Value })
  if ($found.Count -eq 0) { throw "$Type '$Value' was not found in subscription '$subscription'." }
  if ($found.Count -gt 1) { throw "$Type '$Value' exists in multiple resource groups. Specify its resource group or full ARM ID." }
  return $found[0].id
}

function Grant-Role([string]$PrincipalId, [string]$RoleId, [string]$Scope, [string]$Label, [string]$PrincipalType = 'ServicePrincipal') {
  $out = Invoke-Az role assignment create --assignee-object-id $PrincipalId --assignee-principal-type $PrincipalType `
    --role $RoleId --scope $Scope -o none -AllowFailure
  if ($null -eq $out) {
    $existing = @(Invoke-AzJson role assignment list --assignee $PrincipalId --scope $Scope --role $RoleId -AllowFailure)
    if ($existing.Count -eq 0) { throw "Role assignment failed: $Label on $Scope" }
  }
  Write-Host "    $Label"
}

function Wait-ActiveGroupDeployments([string]$GroupName, [string]$Prefix) {
  $exists = Invoke-Az group exists -n $GroupName -AllowFailure
  if (-not $exists -or $exists.Trim() -ne 'true') { return }
  for ($w = 1; $w -le 60; $w++) {
    $running = @(Invoke-AzJson deployment group list -g $GroupName -AllowFailure | Where-Object {
      $_.name -like "$Prefix*" -and $_.properties.provisioningState -in @('Running', 'Accepted', 'Deleting')
    })
    if ($running.Count -eq 0) { return }
    if ($w -eq 1) {
      Write-Host "    Waiting for previous in-progress ARM deployment(s) in '$GroupName' ($($running.name -join ', ')) to settle..." -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 10
  }
}

function Normalize-Location([string]$Value) { return ($Value -replace '\s', '').ToLowerInvariant() }

function Get-ConfigProp($Obj, [string]$PropName) {
  if ($null -eq $Obj) { return $null }
  $prop = $Obj.PSObject.Properties[$PropName]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Get-ScmHostName([string]$DefaultHost, [string]$SiteName) {
  if ($DefaultHost -and $DefaultHost.Contains('.')) {
    $parts = $DefaultHost.Split('.', 2)
    return "$($parts[0]).scm.$($parts[1])"
  }
  return "$SiteName.scm.azurewebsites.net"
}

try {
  # 1. Load deploy.config.json automatically if present (CLI parameters take precedence)
  if (-not $ConfigFile) {
    $defaultCfg = Join-Path $PSScriptRoot 'deploy.config.json'
    if (Test-Path $defaultCfg) { $ConfigFile = $defaultCfg }
  }
  if ($ConfigFile) {
    if (-not (Test-Path $ConfigFile)) { throw "Config file not found: $ConfigFile" }
    Write-Step "Loading configuration from '$ConfigFile'"
    $rawJson = (Get-Content -Path $ConfigFile -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
    $cfg = $rawJson | ConvertFrom-Json
    if (-not $PSBoundParameters.ContainsKey('SubscriptionId') -and (Get-ConfigProp $cfg 'subscriptionId')) { $SubscriptionId = [string](Get-ConfigProp $cfg 'subscriptionId') }
    if (-not $PSBoundParameters.ContainsKey('ResourceGroup') -and (Get-ConfigProp $cfg 'resourceGroup')) { $ResourceGroup = [string](Get-ConfigProp $cfg 'resourceGroup') }
    if (-not $PSBoundParameters.ContainsKey('Location') -and (Get-ConfigProp $cfg 'location')) { $Location = [string](Get-ConfigProp $cfg 'location') }
    if (-not $PSBoundParameters.ContainsKey('Name')) {
      $cfgName = Get-ConfigProp $cfg 'webAppName'
      if (-not $cfgName) { $cfgName = Get-ConfigProp $cfg 'name' }
      if ($cfgName) { $Name = [string]$cfgName }
    }
    if (-not $PSBoundParameters.ContainsKey('WebAppPublicNetworkAccess') -and (Get-ConfigProp $cfg 'webAppPublicNetworkAccess')) {
      $WebAppPublicNetworkAccess = [string](Get-ConfigProp $cfg 'webAppPublicNetworkAccess')
    }
    if (-not $PSBoundParameters.ContainsKey('AllowedIpCidrs') -and (Get-ConfigProp $cfg 'allowedIpCidrs')) {
      $AllowedIpCidrs = @((Get-ConfigProp $cfg 'allowedIpCidrs') | ForEach-Object { [string]$_ } | Where-Object { $_ })
    }
    if (-not $PSBoundParameters.ContainsKey('PythonVersion') -and (Get-ConfigProp $cfg 'pythonVersion')) { $PythonVersion = [string](Get-ConfigProp $cfg 'pythonVersion') }
    if (-not $PSBoundParameters.ContainsKey('AppServicePlanSku') -and (Get-ConfigProp $cfg 'appServicePlanSku')) { $AppServicePlanSku = [string](Get-ConfigProp $cfg 'appServicePlanSku') }
    if (-not $PSBoundParameters.ContainsKey('AutoDiscoverShared') -and $null -ne (Get-ConfigProp $cfg 'autoDiscoverShared')) {
      if ([bool](Get-ConfigProp $cfg 'autoDiscoverShared')) { $AutoDiscoverShared = [switch]::Present }
    }
    $sharedRgCfg = Get-ConfigProp $cfg 'sharedResourceGroup'
    if (-not $PSBoundParameters.ContainsKey('AppServicePlan')) {
      $aspVal = Get-ConfigProp $cfg 'appServicePlan'
      if (-not $aspVal) { $aspVal = Get-ConfigProp $cfg 'appServicePlanId' }
      if ($aspVal) { $AppServicePlan = [string]$aspVal }
    }
    if (-not $PSBoundParameters.ContainsKey('AppServicePlanResourceGroup')) {
      $aspRgVal = Get-ConfigProp $cfg 'appServicePlanResourceGroup'
      if (-not $aspRgVal) { $aspRgVal = $sharedRgCfg }
      if ($aspRgVal) { $AppServicePlanResourceGroup = [string]$aspRgVal }
    }
    if (-not $PSBoundParameters.ContainsKey('StorageAccountName')) {
      $stVal = Get-ConfigProp $cfg 'storageAccount'
      if (-not $stVal) { $stVal = Get-ConfigProp $cfg 'storageAccountName' }
      if ($stVal) { $StorageAccountName = [string]$stVal }
    }
    if (-not $PSBoundParameters.ContainsKey('StorageAccountResourceGroup')) {
      $stRgVal = Get-ConfigProp $cfg 'storageAccountResourceGroup'
      if (-not $stRgVal) { $stRgVal = $sharedRgCfg }
      if ($stRgVal) { $StorageAccountResourceGroup = [string]$stRgVal }
    }
    if (-not $PSBoundParameters.ContainsKey('KeyVaultName')) {
      $kvVal = Get-ConfigProp $cfg 'keyVault'
      if (-not $kvVal) { $kvVal = Get-ConfigProp $cfg 'keyVaultName' }
      if ($kvVal) { $KeyVaultName = [string]$kvVal }
    }
    if (-not $PSBoundParameters.ContainsKey('KeyVaultResourceGroup')) {
      $kvRgVal = Get-ConfigProp $cfg 'keyVaultResourceGroup'
      if (-not $kvRgVal) { $kvRgVal = $sharedRgCfg }
      if ($kvRgVal) { $KeyVaultResourceGroup = [string]$kvRgVal }
    }
    if (-not $PSBoundParameters.ContainsKey('LogAnalyticsWorkspace')) {
      $lawVal = Get-ConfigProp $cfg 'logAnalyticsWorkspace'
      if (-not $lawVal) { $lawVal = Get-ConfigProp $cfg 'logAnalyticsWorkspaceId' }
      if ($lawVal) { $LogAnalyticsWorkspace = [string]$lawVal }
    }
    if (-not $PSBoundParameters.ContainsKey('LogAnalyticsWorkspaceResourceGroup')) {
      $lawRgVal = Get-ConfigProp $cfg 'logAnalyticsWorkspaceResourceGroup'
      if (-not $lawRgVal) { $lawRgVal = $sharedRgCfg }
      if ($lawRgVal) { $LogAnalyticsWorkspaceResourceGroup = [string]$lawRgVal }
    }
    if (-not $PSBoundParameters.ContainsKey('StorageNamespace') -and (Get-ConfigProp $cfg 'storageNamespace')) { $StorageNamespace = [string](Get-ConfigProp $cfg 'storageNamespace') }
    if (-not $PSBoundParameters.ContainsKey('StorageContainerName') -and (Get-ConfigProp $cfg 'storageContainerName')) { $StorageContainerName = [string](Get-ConfigProp $cfg 'storageContainerName') }
    if (-not $PSBoundParameters.ContainsKey('StorageBlobPrefix') -and (Get-ConfigProp $cfg 'storageBlobPrefix')) { $StorageBlobPrefix = [string](Get-ConfigProp $cfg 'storageBlobPrefix') }
    if (-not $PSBoundParameters.ContainsKey('WorkspaceDisplayName') -and (Get-ConfigProp $cfg 'workspaceDisplayName')) { $WorkspaceDisplayName = [string](Get-ConfigProp $cfg 'workspaceDisplayName') }
    if (-not $PSBoundParameters.ContainsKey('TargetSubscriptionId') -and (Get-ConfigProp $cfg 'targetSubscriptionId')) { $TargetSubscriptionId = [string](Get-ConfigProp $cfg 'targetSubscriptionId') }
    if (-not $PSBoundParameters.ContainsKey('TargetSubscriptionName') -and (Get-ConfigProp $cfg 'targetSubscriptionName')) { $TargetSubscriptionName = [string](Get-ConfigProp $cfg 'targetSubscriptionName') }
    if (-not $PSBoundParameters.ContainsKey('RestoreEnabled') -and $null -ne (Get-ConfigProp $cfg 'restoreEnabled')) { $RestoreEnabled = [bool](Get-ConfigProp $cfg 'restoreEnabled') }
    if (-not $PSBoundParameters.ContainsKey('ActivityDays') -and $null -ne (Get-ConfigProp $cfg 'activityDays')) { $ActivityDays = [int](Get-ConfigProp $cfg 'activityDays') }
    if (-not $PSBoundParameters.ContainsKey('VnetIntegrationSubnetId') -and (Get-ConfigProp $cfg 'vnetIntegrationSubnetId')) { $VnetIntegrationSubnetId = [string](Get-ConfigProp $cfg 'vnetIntegrationSubnetId') }
    if (-not $PSBoundParameters.ContainsKey('VnetIntegrationSubnetName') -and (Get-ConfigProp $cfg 'vnetIntegrationSubnetName')) { $VnetIntegrationSubnetName = [string](Get-ConfigProp $cfg 'vnetIntegrationSubnetName') }
    if (-not $PSBoundParameters.ContainsKey('VnetIntegrationSubnetPrefix') -and (Get-ConfigProp $cfg 'vnetIntegrationSubnetPrefix')) { $VnetIntegrationSubnetPrefix = [string](Get-ConfigProp $cfg 'vnetIntegrationSubnetPrefix') }
    if (-not $PSBoundParameters.ContainsKey('VnetRouteAllEnabled') -and $null -ne (Get-ConfigProp $cfg 'vnetRouteAllEnabled')) { $VnetRouteAllEnabled = [bool](Get-ConfigProp $cfg 'vnetRouteAllEnabled') }
    if (-not $PSBoundParameters.ContainsKey('PrivateEndpointSubnetId') -and (Get-ConfigProp $cfg 'privateEndpointSubnetId')) { $PrivateEndpointSubnetId = [string](Get-ConfigProp $cfg 'privateEndpointSubnetId') }
    if (-not $PSBoundParameters.ContainsKey('PrivateEndpointResourceGroup') -and (Get-ConfigProp $cfg 'privateEndpointResourceGroup')) { $PrivateEndpointResourceGroup = [string](Get-ConfigProp $cfg 'privateEndpointResourceGroup') }
    if (-not $PSBoundParameters.ContainsKey('EnableWebAppPrivateEndpoint') -and $null -ne (Get-ConfigProp $cfg 'enableWebAppPrivateEndpoint')) { $EnableWebAppPrivateEndpoint = [bool](Get-ConfigProp $cfg 'enableWebAppPrivateEndpoint') }
    if (-not $PSBoundParameters.ContainsKey('CreateMissingSharedPrivateEndpoints') -and $null -ne (Get-ConfigProp $cfg 'createMissingSharedPrivateEndpoints')) { $CreateMissingSharedPrivateEndpoints = [bool](Get-ConfigProp $cfg 'createMissingSharedPrivateEndpoints') }
    if (-not $PSBoundParameters.ContainsKey('ResourceScopedDataPlaneRbac') -and $null -ne (Get-ConfigProp $cfg 'resourceScopedDataPlaneRbac')) { $ResourceScopedDataPlaneRbac = [bool](Get-ConfigProp $cfg 'resourceScopedDataPlaneRbac') }
    if (-not $PSBoundParameters.ContainsKey('AuthProvider') -and (Get-ConfigProp $cfg 'authProvider')) { $AuthProvider = [string](Get-ConfigProp $cfg 'authProvider') }
    if (-not $PSBoundParameters.ContainsKey('AdminUsername') -and (Get-ConfigProp $cfg 'adminUsername')) { $AdminUsername = [string](Get-ConfigProp $cfg 'adminUsername') }
    if (-not $PSBoundParameters.ContainsKey('LogWorkspaceGuid') -and (Get-ConfigProp $cfg 'logWorkspaceGuid')) { $LogWorkspaceGuid = [string](Get-ConfigProp $cfg 'logWorkspaceGuid') }
    if (-not $PSBoundParameters.ContainsKey('LogDcrId') -and (Get-ConfigProp $cfg 'logDcrId')) { $LogDcrId = [string](Get-ConfigProp $cfg 'logDcrId') }
    if (-not $PSBoundParameters.ContainsKey('LogRuleId') -and (Get-ConfigProp $cfg 'logRuleId')) { $LogRuleId = [string](Get-ConfigProp $cfg 'logRuleId') }
    if (-not $PSBoundParameters.ContainsKey('LogEndpoint') -and (Get-ConfigProp $cfg 'logEndpoint')) { $LogEndpoint = [string](Get-ConfigProp $cfg 'logEndpoint') }
    if (-not $PSBoundParameters.ContainsKey('LogStream') -and (Get-ConfigProp $cfg 'logStream')) { $LogStream = [string](Get-ConfigProp $cfg 'logStream') }
    if (-not $PSBoundParameters.ContainsKey('AssignRoleAssignments') -and $null -ne (Get-ConfigProp $cfg 'assignRoleAssignments')) {
      if ([bool](Get-ConfigProp $cfg 'assignRoleAssignments')) { $AssignRoleAssignments = [switch]::Present }
    }
    if (-not $PSBoundParameters.ContainsKey('SkipRoleAssignments') -and $null -ne (Get-ConfigProp $cfg 'skipRoleAssignments')) {
      if ([bool](Get-ConfigProp $cfg 'skipRoleAssignments')) { $SkipRoleAssignments = [switch]::Present }
    }
    if (-not $PSBoundParameters.ContainsKey('PackagePath') -and (Get-ConfigProp $cfg 'packagePath')) { $PackagePath = [string](Get-ConfigProp $cfg 'packagePath') }
    if (-not $PSBoundParameters.ContainsKey('PackageUri') -and (Get-ConfigProp $cfg 'packageUri')) { $PackageUri = [string](Get-ConfigProp $cfg 'packageUri') }
    $cfgTags = Get-ConfigProp $cfg 'tags'
    if ($cfgTags) {
      $mergedCfgTags = @{}
      foreach ($p in $cfgTags.PSObject.Properties) {
        if (-not $p.Name.StartsWith('_')) { $mergedCfgTags[$p.Name] = [string]$p.Value }
      }
      foreach ($k in $Tags.Keys) { $mergedCfgTags[$k] = [string]$Tags[$k] }
      $Tags = $mergedCfgTags
    }
  }

  if ([string]::IsNullOrWhiteSpace($Name) -or $Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]{1,54}[a-zA-Z0-9]$') {
    throw 'Specify a valid Web App name (-Name or webAppName in deploy.config.json, 3-56 alphanumeric/hyphen chars).'
  }
  if ([string]::IsNullOrWhiteSpace($ResourceGroup)) {
    throw 'Specify -ResourceGroup (or resourceGroup in deploy.config.json).'
  }

  Write-Step 'Checking Azure CLI context'
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI (az) was not found.' }
  if ($SubscriptionId) { Invoke-Az account set --subscription $SubscriptionId | Out-Null }
  $account = Invoke-AzJson account show
  if (-not $account) { throw "Run 'az login' first." }
  $subscription = $account.id
  if (-not $TargetSubscriptionId) { $TargetSubscriptionId = $subscription }
  if (-not $TargetSubscriptionName) {
    $TargetSubscriptionName = if ($TargetSubscriptionId -eq $subscription) { [string]$account.name } else { $TargetSubscriptionId }
  }
  Write-Host "    Subscription: $($account.name) ($subscription)"

  # 2. Optional auto-discovery of shared subscription infrastructure
  if ($AutoDiscoverShared) {
    Write-Step "Auto-discovering shared resources in subscription '$subscription'"
    if (-not $AppServicePlan) {
      $plans = @(Invoke-AzJson appservice plan list | Where-Object { ($_.reserved -eq $true) -or ($_.kind -match 'linux') })
      if ($plans.Count -eq 1) {
        $AppServicePlan = $plans[0].id
        Write-Host "    Auto-discovered Linux App Service Plan: $($plans[0].name)"
      } elseif ($plans.Count -gt 1) {
        throw "Multiple Linux App Service Plans found ($($plans.name -join ', ')). Specify appServicePlan explicitly."
      }
    }
    if (-not $LogAnalyticsWorkspace) {
      $laws = @(Invoke-AzJson resource list --resource-type 'Microsoft.OperationalInsights/workspaces')
      if ($laws.Count -eq 1) {
        $LogAnalyticsWorkspace = $laws[0].id
        Write-Host "    Auto-discovered Log Analytics Workspace: $($laws[0].name)"
      }
    }
    if (-not $StorageAccountName) {
      $sts = @(Invoke-AzJson storage account list | Where-Object { $_.kind -in @('StorageV2', 'BlockBlobStorage') })
      if ($sts.Count -eq 1) {
        $StorageAccountName = $sts[0].id
        Write-Host "    Auto-discovered Storage Account: $($sts[0].name)"
      } elseif ($sts.Count -gt 1) {
        throw "Multiple Storage Accounts found ($($sts.name -join ', ')). Specify storageAccount explicitly."
      }
    }
    if (-not $KeyVaultName) {
      $kvs = @(Invoke-AzJson keyvault list)
      if ($kvs.Count -eq 1) {
        $KeyVaultName = $kvs[0].id
        Write-Host "    Auto-discovered Key Vault: $($kvs[0].name)"
      } elseif ($kvs.Count -gt 1) {
        throw "Multiple Key Vaults found ($($kvs.name -join ', ')). Specify keyVault explicitly."
      }
    }
    if (-not $VnetIntegrationSubnetId -or -not $PrivateEndpointSubnetId) {
      $vnets = @(Invoke-AzJson network vnet list)
      if ($vnets.Count -eq 1) {
        $vnetObj = Invoke-AzJson network vnet show --ids $vnets[0].id
        if (-not $VnetIntegrationSubnetId) {
          $delegatedSub = @($vnetObj.subnets | Where-Object {
            $_.delegations | Where-Object { $_.serviceName -eq 'Microsoft.Web/serverFarms' }
          }) | Select-Object -First 1
          $emptySub = @($vnetObj.subnets | Where-Object {
            (@($_.delegations).Count -eq 0) -and (@($_.ipConfigurations).Count -eq 0) -and (@($_.privateEndpoints).Count -eq 0) -and ($_.name -notmatch '^(AzureBastionSubnet|GatewaySubnet|AzureFirewallSubnet|RouteServerSubnet)$')
          }) | Select-Object -First 1
          $appSub = if ($delegatedSub) { $delegatedSub } else { $emptySub }
          if ($appSub) {
            $VnetIntegrationSubnetId = $appSub.id
            Write-Host "    Auto-discovered App Service VNet integration subnet: $($appSub.name)"
          }
        }
        if (-not $PrivateEndpointSubnetId) {
          $peSub = @($vnetObj.subnets | Where-Object { $_.name -match '(^|-)(pe|privatelink|endpoint)($|-)' }) | Select-Object -First 1
          if ($peSub) {
            $PrivateEndpointSubnetId = $peSub.id
            Write-Host "    Auto-discovered Private Endpoint subnet: $($peSub.name)"
          }
        }
      }
    }
  }

  # 3. Resolve & validate shared resources + inspect any pre-existing Web App state for safe resume
  $existingPlanId = Resolve-ResourceId $AppServicePlan 'Microsoft.Web/serverfarms' $AppServicePlanResourceGroup
  $existingKvId = Resolve-ResourceId $KeyVaultName 'Microsoft.KeyVault/vaults' $KeyVaultResourceGroup
  $existingStId = Resolve-ResourceId $StorageAccountName 'Microsoft.Storage/storageAccounts' $StorageAccountResourceGroup
  $existingLawId = Resolve-ResourceId $LogAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces' $LogAnalyticsWorkspaceResourceGroup

  Wait-ActiveGroupDeployments $ResourceGroup 'armbackup-appservice-'
  if ($existingStId) { Wait-ActiveGroupDeployments (($existingStId -split '/')[4]) 'ab-' }
  if ($existingKvId) { Wait-ActiveGroupDeployments (($existingKvId -split '/')[4]) 'ab-' }

  $webAppId = "/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$Name"
  $rgExists = ((Invoke-Az group exists -n $ResourceGroup).Trim() -eq 'true')
  $existingSite = if ($rgExists) { Invoke-AzJson resource show --ids $webAppId --api-version 2023-12-01 -AllowFailure } else { $null }
  if ($existingSite) {
    Write-Host "    Existing Web App '$Name' detected (state=$($existingSite.properties.state)); resuming idempotently."
    if (-not $existingPlanId -and $existingSite.properties.serverFarmId) {
      $existingPlanId = [string]$existingSite.properties.serverFarmId
      Write-Host "    Reusing existing App Service Plan on '$Name': $existingPlanId"
    }
    if (-not $VnetIntegrationSubnetId -and $existingSite.properties.virtualNetworkSubnetId) {
      $VnetIntegrationSubnetId = [string]$existingSite.properties.virtualNetworkSubnetId
      Write-Host "    Reusing existing VNet integration subnet on '$Name': $VnetIntegrationSubnetId"
    }
    if ($WebAppPublicNetworkAccess -eq 'Enabled' -and (-not $AllowedIpCidrs -or $AllowedIpCidrs.Count -eq 0)) {
      $existingWebCfg = Invoke-AzJson rest --method get --url "https://management.azure.com$webAppId/config/web?api-version=2023-12-01" -AllowFailure
      if ($existingWebCfg -and $existingWebCfg.properties -and $existingWebCfg.properties.ipSecurityRestrictions) {
        $preservedIps = @($existingWebCfg.properties.ipSecurityRestrictions | Where-Object {
          $_.action -eq 'Allow' -and $_.ipAddress -and $_.ipAddress -ne 'Any' -and $_.ipAddress -notlike '*:*'
        } | ForEach-Object { [string]$_.ipAddress })
        if ($preservedIps.Count -gt 0) {
          $AllowedIpCidrs = $preservedIps
          Write-Host "    Preserving $($preservedIps.Count) existing IP allow rule(s) on '$Name'."
        }
      }
    }
  }

  $enableAlwaysOn = $true
  if ($existingPlanId) {
    $plan = Invoke-AzJson resource show --ids $existingPlanId --api-version 2023-12-01
    $isLinuxPlan = ($plan.properties.reserved -eq $true) -or ($plan.kind -match 'linux')
    if (-not $isLinuxPlan) {
      throw "App Service Plan '$($plan.name)' (kind=$($plan.kind)) is not a Linux plan."
    }
    if (-not $Location) {
      $Location = Normalize-Location $plan.location
    } elseif ((Normalize-Location $plan.location) -ne (Normalize-Location $Location)) {
      throw "Location '$Location' does not match shared App Service Plan region '$($plan.location)'."
    }
    if ($plan.sku -and $plan.sku.tier -in @('Free', 'Shared')) {
      $enableAlwaysOn = $false
    }
    Write-Host "    Shared App Service Plan: $($plan.name) ($($plan.sku.name), $($plan.location))"
    if (-not $VnetIntegrationSubnetId) {
      $rawConns = Invoke-AzJson rest --method get --url "https://management.azure.com$existingPlanId/virtualNetworkConnections?api-version=2023-12-01" -AllowFailure
      $planVnetConns = if ($rawConns -and $rawConns.PSObject.Properties['value']) { @($rawConns.value) } else { @($rawConns) }
      $validPlanConns = @($planVnetConns | Where-Object { $_ -and $_.properties -and $_.properties.vnetResourceId })
      if ($validPlanConns.Count -ge 1) {
        $peVnetPrefix = if ($PrivateEndpointSubnetId) { (($PrivateEndpointSubnetId -split '/subnets/')[0]).ToLowerInvariant() } else { '' }
        $matchedConn = if ($peVnetPrefix) { @($validPlanConns | Where-Object { ([string]$_.properties.vnetResourceId).ToLowerInvariant().StartsWith($peVnetPrefix) }) | Select-Object -First 1 } else { $null }
        $chosenConn = if ($matchedConn) { $matchedConn } else { $validPlanConns[0] }
        $VnetIntegrationSubnetId = [string]$chosenConn.properties.vnetResourceId
        Write-Host "    Auto-detected existing VNet integration on shared App Service Plan: $VnetIntegrationSubnetId"
      }
    }
  }
  if (-not $Location) { $Location = 'koreacentral' }

  if (-not $VnetIntegrationSubnetId -and $PrivateEndpointSubnetId) {
    $peVnetId = ($PrivateEndpointSubnetId -split '/subnets/')[0]
    $peVnetObj = Invoke-AzJson network vnet show --ids $peVnetId -AllowFailure
    if ($peVnetObj) {
      $delegatedSubs = @($peVnetObj.subnets | Where-Object {
        $_.delegations | Where-Object { $_.serviceName -eq 'Microsoft.Web/serverFarms' }
      })
      $freeDelegatedSubs = @($delegatedSubs | Where-Object {
        (@($_.serviceAssociationLinks).Count -eq 0) -and (@($_.ipConfigurations).Count -eq 0)
      } | Sort-Object name)
      $preferredFree = @($freeDelegatedSubs | Where-Object { $_.name -notmatch 'logic' })
      $preferredAny = @($delegatedSubs | Where-Object { $_.name -notmatch 'logic' })
      if ($VnetIntegrationSubnetName -and $VnetIntegrationSubnetPrefix) {
        $existingNamedSub = @($peVnetObj.subnets | Where-Object { $_.name -eq $VnetIntegrationSubnetName }) | Select-Object -First 1
        if ($existingNamedSub) {
          $VnetIntegrationSubnetId = [string]$existingNamedSub.id
          Write-Host "    Reusing existing VNet integration subnet: $($existingNamedSub.name)"
        } else {
          Write-Step "Creating VNet integration subnet '$VnetIntegrationSubnetName' ($VnetIntegrationSubnetPrefix) in $($peVnetObj.name)"
          $vnetPartsArr = $peVnetId -split '/'
          $createdSub = Invoke-AzJson network vnet subnet create -g $vnetPartsArr[4] --vnet-name $vnetPartsArr[8] -n $VnetIntegrationSubnetName --address-prefixes $VnetIntegrationSubnetPrefix --delegations 'Microsoft.Web/serverFarms'
          $VnetIntegrationSubnetId = [string]$createdSub.id
        }
      } elseif ($preferredFree.Count -ge 1) {
        $VnetIntegrationSubnetId = [string]$preferredFree[0].id
        Write-Host "    Auto-detected available delegated VNet integration subnet in $($peVnetObj.name): $($preferredFree[0].name)"
      } elseif ($freeDelegatedSubs.Count -ge 1) {
        $VnetIntegrationSubnetId = [string]$freeDelegatedSubs[0].id
        Write-Host "    Auto-detected available delegated VNet integration subnet in $($peVnetObj.name): $($freeDelegatedSubs[0].name)"
      } elseif ($preferredAny.Count -ge 1) {
        $VnetIntegrationSubnetId = [string]$preferredAny[0].id
        Write-Host "    Auto-detected delegated VNet integration subnet in $($peVnetObj.name): $($preferredAny[0].name)"
      } elseif ($delegatedSubs.Count -eq 1) {
        $VnetIntegrationSubnetId = [string]$delegatedSubs[0].id
        Write-Host "    Auto-detected delegated VNet integration subnet in $($peVnetObj.name): $($delegatedSubs[0].name)"
      }
    }
  }

  if ($VnetIntegrationSubnetId) {
    $vnetParts = $VnetIntegrationSubnetId -split '/subnets/'
    if ($vnetParts.Count -eq 2) {
      $subnetObj = Invoke-AzJson network vnet subnet show --ids $VnetIntegrationSubnetId
      $addrPrefix = if ($subnetObj.addressPrefix) { [string]$subnetObj.addressPrefix } elseif ($subnetObj.addressPrefixes) { [string]$subnetObj.addressPrefixes[0] } else { '' }
      if ($addrPrefix -match '/(\d+)$') {
        $prefixLen = [int]$Matches[1]
        if ($prefixLen -gt 28) {
          throw "App Service regional VNet integration requires at least a /28 subnet, got '$addrPrefix' on '$($subnetObj.name)'."
        }
      }
      $delegations = @($subnetObj.delegations | ForEach-Object { $_.serviceName })
      if ($delegations -notcontains 'Microsoft.Web/serverFarms') {
        $usedIpConfigs = @($subnetObj.ipConfigurations).Count
        $otherDelegations = @($delegations | Where-Object { $_ })
        if ($usedIpConfigs -gt 0 -or $otherDelegations.Count -gt 0) {
          throw "Subnet '$($subnetObj.name)' cannot be delegated to Microsoft.Web/serverFarms because it already contains $usedIpConfigs IP configurations/NICs or other delegations ($($otherDelegations -join ', '))."
        }
        Write-Step "Delegating empty subnet '$($subnetObj.name)' ($addrPrefix) to Microsoft.Web/serverFarms"
        Invoke-Az network vnet subnet update --ids $VnetIntegrationSubnetId --delegations 'Microsoft.Web/serverFarms' -o none | Out-Null
      } else {
        Write-Host "    VNet integration subnet verified: $($subnetObj.name) ($addrPrefix, delegated to Microsoft.Web/serverFarms)"
      }
    }
  }

  if ($PrivateEndpointSubnetId) {
    $peSubId = ($PrivateEndpointSubnetId -split '/')[2]
    if ($peSubId.ToLowerInvariant() -ne $subscription.ToLowerInvariant()) {
      throw "Private Endpoint subnet '$PrivateEndpointSubnetId' is in subscription '$peSubId', which violates Cross-Subscription Private Endpoint Deny policies against subscription '$subscription'."
    }
  }

  # Inspect shared Storage (blob only) & Key Vault Private Endpoint coverage and RBAC vs Access Policy mode
  $missingStorageGroups = @()
  $createKvPe = $false
  $kvUsesRbac = $true
  $stBlocksPublic = $false
  $kvBlocksPublic = $false
  $allPes = if ($existingStId -or $existingKvId -or $PrivateEndpointSubnetId) { @(Invoke-AzJson network private-endpoint list) } else { @() }

  if ($existingStId) {
    $stObj = Invoke-AzJson resource show --ids $existingStId --api-version 2025-06-01
    Write-Host "    Shared Storage Account: $($stObj.name) (publicNetworkAccess=$($stObj.properties.publicNetworkAccess))"
    if ($stObj.properties.publicNetworkAccess -ne 'Disabled') {
      throw "Storage Account '$($stObj.name)' has publicNetworkAccess='$($stObj.properties.publicNetworkAccess)'. Governance requires Storage Account Public Network Access to be 'Disabled' only."
    }
    $stBlocksPublic = $true
    if ($stBlocksPublic) {
      $haveGroups = @()
      foreach ($pe in $allPes) {
        if ($pe.provisioningState -and $pe.provisioningState -ne 'Succeeded') { continue }
        foreach ($conn in (@($pe.privateLinkServiceConnections) + @($pe.manualPrivateLinkServiceConnections))) {
          if ($conn -and $conn.privateLinkServiceId -and ($conn.privateLinkServiceId.ToLowerInvariant() -eq $existingStId.ToLowerInvariant())) {
            $haveGroups += @($conn.groupIds | ForEach-Object { ([string]$_).ToLowerInvariant() })
          }
        }
      }
      $missingStorageGroups = @('blob' | Where-Object { $haveGroups -notcontains $_ })
      if ($missingStorageGroups.Count -gt 0) {
        if ($PrivateEndpointSubnetId -and ($CreateMissingSharedPrivateEndpoints -or $CreateMissingStoragePrivateEndpoints)) {
          Write-Host "    Will create/repair missing Storage Private Endpoint: $($missingStorageGroups -join ', ')"
        } else {
          Write-Warning "Shared Storage '$($stObj.name)' blocks public access and is missing Private Endpoint for: $($missingStorageGroups -join ', '). Specify -PrivateEndpointSubnetId to create it automatically."
          $missingStorageGroups = @()
        }
      } else {
        Write-Host '    Shared Storage Private Endpoint (blob) already present.'
      }
    }
  }

  if ($existingKvId) {
    $kvObj = Invoke-AzJson resource show --ids $existingKvId --api-version 2023-07-01
    $kvUsesRbac = [bool]$kvObj.properties.enableRbacAuthorization
    Write-Host "    Shared Key Vault: $($kvObj.name) (publicNetworkAccess=$($kvObj.properties.publicNetworkAccess), rbac=$kvUsesRbac)"
    $kvBlocksPublic = ($kvObj.properties.publicNetworkAccess -eq 'Disabled') -or ($kvObj.properties.networkAcls.defaultAction -eq 'Deny')
    if ($kvBlocksPublic) {
      $hasKvPe = $false
      foreach ($pe in $allPes) {
        if ($pe.provisioningState -and $pe.provisioningState -ne 'Succeeded') { continue }
        foreach ($conn in (@($pe.privateLinkServiceConnections) + @($pe.manualPrivateLinkServiceConnections))) {
          if ($conn -and $conn.privateLinkServiceId -and ($conn.privateLinkServiceId.ToLowerInvariant() -eq $existingKvId.ToLowerInvariant()) -and (@($conn.groupIds | ForEach-Object { ([string]$_).ToLowerInvariant() }) -contains 'vault')) {
            $hasKvPe = $true
          }
        }
      }
      if (-not $hasKvPe -and $PrivateEndpointSubnetId -and $CreateMissingSharedPrivateEndpoints) {
        $createKvPe = $true
        Write-Host "    Will create/repair missing Key Vault 'vault' Private Endpoint."
      }
    }
  }

  $skipDiagSettings = $false
  if ($existingLawId) {
    Write-Host "    Shared Log Analytics Workspace: $($existingLawId.Split('/')[-1])"
    if ($existingSite) {
      $existingDiagsRaw = Invoke-AzJson rest --method get --url "https://management.azure.com$webAppId/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview" -AllowFailure
      $existingDiags = if ($existingDiagsRaw -and $existingDiagsRaw.PSObject.Properties['value']) { @($existingDiagsRaw.value) } else { @($existingDiagsRaw) }
      foreach ($diag in $existingDiags) {
        if ($diag -and $diag.properties -and $diag.properties.workspaceId -and ($diag.properties.workspaceId.ToLowerInvariant() -eq $existingLawId.ToLowerInvariant()) -and ($diag.name.ToLowerInvariant() -ne "diag-$Name".ToLowerInvariant())) {
          $skipDiagSettings = $true
          Write-Host "    Existing diagnostic setting '$($diag.name)' already streams to '$($existingLawId.Split('/')[-1])'; preserving without duplicate sink."
          break
        }
      }
    }
  }

  $anySharedPrivate = ($existingStId -and $stBlocksPublic) -or ($existingKvId -and $kvBlocksPublic)
  if ($anySharedPrivate -and (-not $VnetIntegrationSubnetId) -and $PrivateEndpointSubnetId) {
    throw "Shared Storage or Key Vault has publicNetworkAccess=Disabled, so App Service regional VNet integration is required. Specify 'vnetIntegrationSubnetId' (a /28+ subnet delegated to Microsoft.Web/serverFarms in $(($PrivateEndpointSubnetId -split '/subnets/')[0].Split('/')[-1])) or 'vnetIntegrationSubnetName' + 'vnetIntegrationSubnetPrefix' in deploy.config.json."
  }

  # Discover any pre-linked Private DNS Zones in the current subscription (never creates new zones in shared mode, avoiding KT Deny Policy)
  $dnsZoneIds = @{
    sites = ''
    blob  = ''
    vault = ''
  }
  $targetVnetId = if ($PrivateEndpointSubnetId) { ($PrivateEndpointSubnetId -split '/subnets/')[0] } elseif ($VnetIntegrationSubnetId) { ($VnetIntegrationSubnetId -split '/subnets/')[0] } else { '' }
  if ($targetVnetId -and $PrivateEndpointSubnetId) {
    $subZones = @(Invoke-AzJson network private-dns zone list -AllowFailure)
    $zoneMap = @{
      sites = 'privatelink.azurewebsites.net'
      blob  = 'privatelink.blob.core.windows.net'
      vault = 'privatelink.vaultcore.azure.net'
    }
    foreach ($key in $zoneMap.Keys) {
      $zName = $zoneMap[$key]
      foreach ($z in @($subZones | Where-Object { $_.name -eq $zName })) {
        $links = @(Invoke-AzJson network private-dns link vnet list -g $z.resourceGroup -z $zName -AllowFailure)
        if ($links | Where-Object { $_.virtualNetwork.id -and ($_.virtualNetwork.id.ToLowerInvariant() -eq $targetVnetId.ToLowerInvariant()) }) {
          $dnsZoneIds[$key] = $z.id
          break
        }
      }
    }
  }

  # Inspect existing Web App 'sites' Private Endpoint so re-runs preserve Hub DINE DNS zone groups & never double-allocate IPs
  $deployWebAppPeInTemplate = $EnableWebAppPrivateEndpoint
  $preExistingWebAppPeId = ''
  $existingWebPeObj = $null
  foreach ($pe in $allPes) {
    foreach ($conn in (@($pe.privateLinkServiceConnections) + @($pe.manualPrivateLinkServiceConnections))) {
      if ($conn -and $conn.privateLinkServiceId -and ($conn.privateLinkServiceId.ToLowerInvariant() -eq $webAppId.ToLowerInvariant()) -and (@($conn.groupIds | ForEach-Object { ([string]$_).ToLowerInvariant() }) -contains 'sites')) {
        $existingWebPeObj = $pe
        break
      }
    }
    if ($existingWebPeObj) { break }
  }
  if ($existingWebPeObj -and $existingWebPeObj.provisioningState -eq 'Succeeded') {
    $preExistingWebAppPeId = [string]$existingWebPeObj.id
    $peDnsGroups = @(Invoke-AzJson network private-endpoint dns-zone-group list -g $existingWebPeObj.resourceGroup --endpoint-name $existingWebPeObj.name -AllowFailure)
    if ($peDnsGroups.Count -gt 0 -or [string]::IsNullOrEmpty($dnsZoneIds['sites'])) {
      $deployWebAppPeInTemplate = $false
      Write-Host "    Existing Web App Private Endpoint '$($existingWebPeObj.name)' is healthy; preserving as-is."
    }
  }

  # Pre-flight Private Endpoint subnet free-IP capacity check
  if ($PrivateEndpointSubnetId) {
    $peSubnetObj = Invoke-AzJson network vnet subnet show --ids $PrivateEndpointSubnetId -AllowFailure
    if ($peSubnetObj) {
      $pePrefix = if ($peSubnetObj.addressPrefix) { [string]$peSubnetObj.addressPrefix } elseif ($peSubnetObj.addressPrefixes) { [string]$peSubnetObj.addressPrefixes[0] } else { '' }
      if ($pePrefix -match '/(\d+)$') {
        $prefixLen = [int]$Matches[1]
        $usableIps = [math]::Max(0, [int][math]::Pow(2, (32 - $prefixLen)) - 5)
        $usedIps = @($peSubnetObj.ipConfigurations).Count
        $pesOnTargetSub = @($allPes | Where-Object { $_.subnet -and $_.subnet.id -and ($_.subnet.id.ToLowerInvariant() -eq $PrivateEndpointSubnetId.ToLowerInvariant()) })
        $netNewWebPe = if ($deployWebAppPeInTemplate -and (-not $existingWebPeObj)) { 1 } else { 0 }
        $netNewStPes = 0
        foreach ($grp in $missingStorageGroups) {
          $expectedStPeName = "pe-$grp-$($stObj.name)"
          if (@($pesOnTargetSub | Where-Object { $_.name -ieq $expectedStPeName }).Count -eq 0) { $netNewStPes++ }
        }
        $netNewKvPe = if ($createKvPe -and (@($pesOnTargetSub | Where-Object { $_.name -ieq "pe-vault-$($kvObj.name)" }).Count -eq 0)) { 1 } else { 0 }
        $requiredNewPes = $netNewWebPe + $netNewStPes + $netNewKvPe
        $freeIps = $usableIps - $usedIps
        if ($freeIps -lt $requiredNewPes) {
          throw "Private Endpoint subnet '$($peSubnetObj.name)' ($pePrefix) has only $freeIps free IPs ($usedIps/$usableIps used), but $requiredNewPes new Private Endpoint(s) are required."
        }
        Write-Host "    PE subnet capacity verified: $($peSubnetObj.name) ($pePrefix, $freeIps/$usableIps free IPs, $requiredNewPes net-new PE(s) needed)"
      }
    }
  }

  # 4. Prepare Resource Group & inherit governance tags (KT SPCType, Service, Environment, ServiceGrade)
  Write-Step "Preparing resource group '$ResourceGroup' in $Location"
  $effectiveTags = @{
    Application     = 'armbackup'
    HostingPlatform = 'app-service'
  }
  if ($rgExists) {
    $rgObj = Invoke-AzJson group show -n $ResourceGroup
    if ($rgObj.tags) {
      foreach ($p in $rgObj.tags.PSObject.Properties) {
        if (-not $p.Name.StartsWith('hidden-')) {
          $effectiveTags[$p.Name] = [string]$p.Value
        }
      }
    }
  }
  if ($existingSite -and $existingSite.tags) {
    foreach ($p in $existingSite.tags.PSObject.Properties) {
      if (-not $p.Name.StartsWith('hidden-') -and $p.Name -ne 'Name') {
        $effectiveTags[$p.Name] = [string]$p.Value
      }
    }
  }
  foreach ($k in $Tags.Keys) { $effectiveTags[$k] = [string]$Tags[$k] }
  if ($effectiveTags.ContainsKey('Service') -or $effectiveTags.ContainsKey('ServiceGrade') -or $effectiveTags.ContainsKey('Name')) {
    if (-not $Tags.ContainsKey('Name')) { $effectiveTags['Name'] = $Name }
  }
  if (-not $rgExists) {
    $tagArgs = @($effectiveTags.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    Invoke-Az group create -n $ResourceGroup -l $Location --tags @tagArgs -o none | Out-Null
  }

  # 5. Admin password resolution / preservation in Key Vault
  $generatedBicepPw = $false
  $bicepPw = ''
  if ($AuthProvider -eq 'password') {
    if ($AdminPassword) {
      $bicepPw = [Net.NetworkCredential]::new('', $AdminPassword).Password
    } else {
      $existingSecretFound = $false
      if (-not $RotateAdminPassword) {
        $candidateKvs = @()
        if ($existingKvId) {
          $candidateKvs += $existingKvId
        } elseif ($rgExists) {
          foreach ($kvItem in @(Invoke-AzJson keyvault list -g $ResourceGroup -AllowFailure)) {
            if ($kvItem.id) { $candidateKvs += $kvItem.id }
          }
        }
        foreach ($kvCandidate in $candidateKvs) {
          $chkUrl = "https://management.azure.com$kvCandidate/secrets/$Name-admin-password?api-version=2023-07-01"
          if ($null -ne (Invoke-Az rest --method get --url $chkUrl -o none -AllowFailure)) {
            $existingSecretFound = $true
            break
          }
        }
        if (-not $existingSecretFound -and $existingSite) {
          $curAppSettings = Invoke-AzJson rest --method post --url "https://management.azure.com$webAppId/config/appsettings/list?api-version=2023-12-01" -AllowFailure
          if ($curAppSettings -and $curAppSettings.properties -and $curAppSettings.properties.PSObject.Properties['ARMBACKUP_ADMIN_PASSWORD']) {
            $curPwVal = [string]$curAppSettings.properties.ARMBACKUP_ADMIN_PASSWORD
            if ($curPwVal -like "@Microsoft.KeyVault(*$Name-admin-password*") {
              $existingSecretFound = $true
            }
          }
        }
      }
      if ($existingSecretFound) {
        Write-Host "    Existing Key Vault secret '$Name-admin-password' found; keeping current password (pass -RotateAdminPassword to rotate)."
      } else {
        $bytes = New-Object byte[] 24
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        $bicepPw = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
        $generatedBicepPw = $true
        if ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_OS) { Write-Host "::add-mask::$bicepPw" }
      }
    }
  }

  # 6. Select pre-compiled azuredeploy.json (offline-safe, zero az bicep binary download needed)
  $compiledJson = Join-Path $PSScriptRoot 'azuredeploy.json'
  $bicepSource = Join-Path $PSScriptRoot 'main.bicep'
  if ($repoRoot -and (Test-Path $bicepSource)) {
    $needsCompile = (-not (Test-Path $compiledJson)) -or ((Get-Item $bicepSource).LastWriteTimeUtc -gt (Get-Item $compiledJson).LastWriteTimeUtc)
    if ($needsCompile) {
      Invoke-Az bicep build --file $bicepSource --outfile $compiledJson | Out-Null
    }
  }
  $templateFile = if (Test-Path $compiledJson) { $compiledJson } elseif (Test-Path $bicepSource) { $bicepSource } else { throw 'Neither azuredeploy.json nor main.bicep was found beside Deploy-AppService.ps1.' }

  # Auto-detect whether a prebuilt ZIP contains .python_packages/ vs Oryx source requirements.txt
  if (-not $PackageUri -and -not $PSBoundParameters.ContainsKey('OryxBuild')) {
    $probeZip = if ($PackagePath -and (Test-Path $PackagePath)) { $PackagePath } elseif (Test-Path (Join-Path $PSScriptRoot 'armbackup.zip')) { Join-Path $PSScriptRoot 'armbackup.zip' } else { '' }
    if ($probeZip) {
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zfProbe = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $probeZip).Path)
      try {
        $hasBundledWheels = @($zfProbe.Entries | Where-Object { $_.FullName -like '.python_packages/*' }).Count -gt 0
        if (-not $hasBundledWheels) {
          $OryxBuild = [switch]::Present
          Write-Host "    Detected source-only package '$probeZip' (no .python_packages); enabling Oryx build settings automatically."
        }
      } finally {
        $zfProbe.Dispose()
      }
    }
  }

  $normalizedAllowedCidrs = @()
  $inboundRulesForRestore = @()
  $idxRule = 0
  foreach ($cidrItem in @($AllowedIpCidrs | Where-Object { $_ })) {
    $trimmed = ([string]$cidrItem).Trim()
    if (-not $trimmed) { continue }
    $idxRule++
    $normCidr = if ($trimmed -match '/') { $trimmed } else { "$trimmed/32" }
    $normalizedAllowedCidrs += $normCidr
    $inboundRulesForRestore += @{
      name      = "allow-client-$idxRule"
      ipAddress = $normCidr
      action    = 'Allow'
      priority  = (100 + (($idxRule - 1) * 10))
    }
  }
  $finalPublicNetworkAccess = if ($inboundRulesForRestore.Count -gt 0) { 'Enabled' } else { $WebAppPublicNetworkAccess }
  # Stage 1 rule: App Service MUST be created with Public Network Access = 'Disabled' on initial PUT.
  # On idempotent re-runs where an existing site is already 'Enabled' with allowed IPs, keep 'Enabled' in ARM to avoid traffic blips.
  $armPublicNetworkAccess = if ($existingSite -and $existingSite.properties.publicNetworkAccess -eq 'Enabled' -and $inboundRulesForRestore.Count -gt 0) {
    'Enabled'
  } else {
    'Disabled'
  }
  $armAllowedIpCidrs = if ($armPublicNetworkAccess -eq 'Enabled') { $normalizedAllowedCidrs } else { @() }

  $doRoleAssignments = [bool]$AssignRoleAssignments -and (-not $SkipRoleAssignments)
  $paramObj = @{
    '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
    contentVersion = '1.0.0.0'
    parameters     = @{
      location                        = @{ value = $Location }
      webAppName                      = @{ value = $Name }
      pythonVersion                   = @{ value = $PythonVersion }
      appServicePlanSku               = @{ value = $AppServicePlanSku }
      enableAlwaysOn                  = @{ value = $enableAlwaysOn }
      existingAppServicePlanId        = @{ value = $existingPlanId }
      existingStorageAccountId        = @{ value = $existingStId }
      existingKeyVaultId              = @{ value = $existingKvId }
      existingLogAnalyticsWorkspaceId = @{ value = $existingLawId }
      skipDiagnosticSettings          = @{ value = $skipDiagSettings }
      storageNamespaceOverride        = @{ value = $(if ($StorageNamespace) { $StorageNamespace } else { '' }) }
      storageContainerOverride        = @{ value = $(if ($StorageContainerName) { $StorageContainerName } else { '' }) }
      storageBlobPrefix               = @{ value = $(if ($StorageBlobPrefix) { $StorageBlobPrefix } else { 'armbackup' }) }
      workspaceDisplayName            = @{ value = $(if ($WorkspaceDisplayName) { $WorkspaceDisplayName } else { 'KT' }) }
      targetSubscriptionId            = @{ value = $TargetSubscriptionId }
      targetSubscriptionName          = @{ value = $TargetSubscriptionName }
      restoreEnabled                  = @{ value = $RestoreEnabled }
      activityDays                    = @{ value = $ActivityDays }
      webAppPublicNetworkAccess       = @{ value = $armPublicNetworkAccess }
      allowedIpCidrs                  = @{ value = @($armAllowedIpCidrs) }
      useOryxBuild                    = @{ value = [bool]$OryxBuild }
      enablePrivateNetworking         = @{ value = $true }
      authProvider                    = @{ value = $AuthProvider }
      adminUsername                   = @{ value = $AdminUsername }
      adminPassword                   = @{ value = $bicepPw }
      logWorkspaceGuid                = @{ value = $LogWorkspaceGuid }
      logDcrId                        = @{ value = $LogDcrId }
      logRuleId                       = @{ value = $LogRuleId }
      logEndpoint                     = @{ value = $LogEndpoint }
      logStream                       = @{ value = $LogStream }
      vnetIntegrationSubnetId         = @{ value = $(if ($VnetIntegrationSubnetId) { $VnetIntegrationSubnetId } else { '' }) }
      vnetRouteAllEnabled             = @{ value = $VnetRouteAllEnabled }
      privateEndpointSubnetId         = @{ value = $(if ($PrivateEndpointSubnetId) { $PrivateEndpointSubnetId } else { '' }) }
      privateEndpointResourceGroup    = @{ value = $(if ($PrivateEndpointResourceGroup) { $PrivateEndpointResourceGroup } else { '' }) }
      enableWebAppPrivateEndpoint     = @{ value = $deployWebAppPeInTemplate }
      storagePrivateEndpointGroups    = @{ value = @($missingStorageGroups) }
      createKeyVaultPrivateEndpoint   = @{ value = $createKvPe }
      sitesPrivateDnsZoneId           = @{ value = $dnsZoneIds['sites'] }
      blobPrivateDnsZoneId            = @{ value = $dnsZoneIds['blob'] }
      vaultPrivateDnsZoneId           = @{ value = $dnsZoneIds['vault'] }
      assignDataPlaneRbac             = @{ value = $doRoleAssignments }
      resourceScopedDataPlaneRbac     = @{ value = $ResourceScopedDataPlaneRbac }
      tags                            = @{ value = $effectiveTags }
    }
  }
  $paramFile = New-TempFile ($paramObj | ConvertTo-Json -Depth 8)

  Write-Step "Validating infrastructure changes with ARM what-if ($(Split-Path $templateFile -Leaf))"
  $whatIfText = Invoke-Az deployment group what-if -g $ResourceGroup --name 'armbackup-appservice-preview' --template-file $templateFile --parameters "@$paramFile"
  Write-Host $whatIfText
  if ($WhatIfPreview) {
    if ($inboundRulesForRestore.Count -gt 0 -and $armPublicNetworkAccess -eq 'Disabled') {
      Write-Host "    [Post-Creation Plan] After creating '$Name' with Public Network Access = Disabled, the script will switch Public Network Access to 'Enabled from select virtual networks and IP addresses' (Unmatched=Deny) with allowed IPs ($($normalizedAllowedCidrs -join ', ')) and verify before starting ZIP deployment." -ForegroundColor Cyan
    }
    Write-Host 'What-if preview finished (-WhatIfPreview). Exiting without modifying resources.' -ForegroundColor Yellow
    return
  }

  Write-Step "Deploying App Service ARM template (initial PublicNetworkAccess=$armPublicNetworkAccess)"
  $deployName = "armbackup-appservice-$(Get-Date -Format 'yyyyMMddHHmmss')"
  $deployOutputs = Invoke-AzJson deployment group create -g $ResourceGroup --name $deployName --template-file $templateFile --parameters "@$paramFile" --query properties.outputs
  $principalId = $deployOutputs.principalId.value
  $hostName = $deployOutputs.webAppHostName.value
  $scmHost = Get-ScmHostName $hostName $Name
  $KeyVaultName = $deployOutputs.keyVaultName.value
  $StorageAccountName = $deployOutputs.storageAccountName.value
  $storageContainerOut = $deployOutputs.storageContainerName.value
  $secretName = $deployOutputs.keyVaultEntryName.value
  $webAppPeId = if ($deployOutputs.PSObject.Properties['webAppPrivateEndpointId'] -and $deployOutputs.webAppPrivateEndpointId.value) {
    $deployOutputs.webAppPrivateEndpointId.value
  } else {
    $preExistingWebAppPeId
  }

  # Stage 2: Once App Service is created, switch Public Network Access to 'Enabled from select virtual networks and IP addresses'
  # with the configured allowed IPs (e.g. 211.47.20.25/32, 211.47.20.26/32) and Unmatched rule action = 'Deny', then verify BEFORE code deployment.
  if ($inboundRulesForRestore.Count -gt 0) {
    Write-Step "Configuring App Service Public Network Access -> 'Enabled from select virtual networks and IP addresses' (Allowed: $($normalizedAllowedCidrs -join ', ') | Unmatched=Deny)"
    $selectNetSiteBody = New-TempFile (@{
      location   = $Location
      properties = @{
        publicNetworkAccess = 'Enabled'
        siteConfig          = @{
          publicNetworkAccess                    = 'Enabled'
          ipSecurityRestrictions                 = $inboundRulesForRestore
          ipSecurityRestrictionsDefaultAction    = 'Deny'
          scmIpSecurityRestrictions              = $inboundRulesForRestore
          scmIpSecurityRestrictionsDefaultAction = 'Deny'
          scmIpSecurityRestrictionsUseMain       = $false
        }
      }
    } | ConvertTo-Json -Depth 8 -Compress)
    Invoke-Az rest --method patch --url "https://management.azure.com$webAppId`?api-version=2023-12-01" --body "@$selectNetSiteBody" -o none | Out-Null

    $selectNetWebCfgBody = New-TempFile (@{
      properties = @{
        ipSecurityRestrictions                 = $inboundRulesForRestore
        ipSecurityRestrictionsDefaultAction    = 'Deny'
        scmIpSecurityRestrictions              = $inboundRulesForRestore
        scmIpSecurityRestrictionsDefaultAction = 'Deny'
        scmIpSecurityRestrictionsUseMain       = $false
      }
    } | ConvertTo-Json -Depth 8 -Compress)
    Invoke-Az rest --method patch --url "https://management.azure.com$webAppId/config/web?api-version=2023-12-01" --body "@$selectNetWebCfgBody" -o none | Out-Null

    $ipRulesVerified = $false
    for ($vAttempt = 1; $vAttempt -le 12 -and -not $ipRulesVerified; $vAttempt++) {
      $siteStateCheck = Invoke-AzJson rest --method get --url "https://management.azure.com$webAppId`?api-version=2023-12-01" -AllowFailure
      $webCfgCheck = Invoke-AzJson rest --method get --url "https://management.azure.com$webAppId/config/web?api-version=2023-12-01" -AllowFailure
      if ($siteStateCheck -and $webCfgCheck -and $siteStateCheck.properties.publicNetworkAccess -eq 'Enabled' -and
          $webCfgCheck.properties.ipSecurityRestrictionsDefaultAction -eq 'Deny' -and
          $webCfgCheck.properties.scmIpSecurityRestrictionsDefaultAction -eq 'Deny') {
        $mainIps = @($webCfgCheck.properties.ipSecurityRestrictions | Where-Object { $_.action -eq 'Allow' } | ForEach-Object { [string]$_.ipAddress })
        $scmIps = @($webCfgCheck.properties.scmIpSecurityRestrictions | Where-Object { $_.action -eq 'Allow' } | ForEach-Object { [string]$_.ipAddress })
        $missingMain = @($normalizedAllowedCidrs | Where-Object { $mainIps -notcontains $_ })
        $missingScm = @($normalizedAllowedCidrs | Where-Object { $scmIps -notcontains $_ })
        if ($missingMain.Count -eq 0 -and $missingScm.Count -eq 0) {
          $ipRulesVerified = $true
          break
        }
      }
      Start-Sleep -Seconds 5
    }
    if (-not $ipRulesVerified) {
      throw "App Service '$Name' did not confirm Allowed IPs ($($normalizedAllowedCidrs -join ', ')) with Unmatched=Deny within 60 seconds; aborting before code deployment."
    }
    Write-Host "    Verified App Service network rules: PublicNetworkAccess=Enabled (select networks & IPs), Allowed=$($normalizedAllowedCidrs -join ', '), Unmatched=Deny. Proceeding to deployment." -ForegroundColor Green
  }

  if ($generatedBicepPw) {
    if ($env:GITHUB_ACTIONS) {
      Write-Host "    Generated admin password stored in Key Vault '$KeyVaultName' secret '$secretName'." -ForegroundColor Yellow
    } else {
      Write-Host "    Generated admin password (stored in Key Vault '$KeyVaultName', shown once): $bicepPw" -ForegroundColor Yellow
    }
  }

  # Optional RBAC assignment (excluded by default so Contributor operators never trigger Microsoft.Authorization/*/write)
  if ($doRoleAssignments -and $existingKvId -and -not $kvUsesRbac -and $AuthProvider -eq 'password') {
    Write-Step "Granting Key Vault access policy (get, list) on non-RBAC vault '$KeyVaultName'"
    Invoke-Az keyvault set-policy -n $KeyVaultName --object-id $principalId --secret-permissions get list -o none | Out-Null
  }

  if ($doRoleAssignments) {
    Write-Step 'Assigning Subscription Reader (+ optional Restore / Log Analytics RBAC)'
    Grant-Role $principalId $roles.Reader "/subscriptions/$TargetSubscriptionId" "Reader on subscription $TargetSubscriptionId"
    if ($RestoreEnabled) {
      Grant-Role $principalId $roles.Contributor "/subscriptions/$TargetSubscriptionId" "Contributor on subscription $TargetSubscriptionId (restoreEnabled=true)"
    }
    if ($existingLawId -and $LogDcrId) {
      Invoke-Az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role $roles.LogReader --scope $existingLawId -o none -AllowFailure | Out-Null
      Invoke-Az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role $roles.MetricsPub --scope $LogDcrId -o none -AllowFailure | Out-Null
    }
  }

  Invoke-Az rest --method post --url "https://management.azure.com/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$Name/config/configreferences/appsettings/refresh?api-version=2023-12-01" -o none -AllowFailure | Out-Null

  # 7. Prepare ZIP package
  if (-not $PackageUri) {
    Write-Step 'Preparing the ZIP package'
    if (-not $PackagePath) {
      $bundledZip = Join-Path $PSScriptRoot 'armbackup.zip'
      if (Test-Path $bundledZip) {
        $PackagePath = $bundledZip
      } elseif ($repoRoot) {
        $PackagePath = Join-Path (Join-Path $repoRoot 'artifacts') (Join-Path 'appservice' 'armbackup.zip')
        if (-not $SkipBuild -or -not (Test-Path $PackagePath)) {
          $buildParams = @{ OutputPath = $PackagePath; PythonVersion = $PythonVersion }
          if ($OryxBuild) { $buildParams['OryxBuild'] = $true }
          & (Join-Path $PSScriptRoot 'Build-Package.ps1') @buildParams
        }
      } else {
        throw "No prebuilt armbackup.zip found beside Deploy-AppService.ps1. Pass -PackagePath <path-to-armbackup.zip>."
      }
    }
    if (-not (Test-Path $PackagePath)) { throw "Package not found: $PackagePath" }
    $shaPath = "$PackagePath.sha256"
    if (Test-Path $shaPath) {
      $expectedSha = ((Get-Content $shaPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
      $actualSha = (Get-FileHash -Path $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($expectedSha -and $expectedSha -ne $actualSha) {
        throw "Package SHA-256 mismatch for '$PackagePath': expected $expectedSha, got $actualSha."
      }
      Write-Host "    Verified SHA-256 checksum ($($actualSha.Substring(0, 12))...)"
    }
    Write-Host "    $PackagePath ($([math]::Round((Get-Item $PackagePath).Length / 1MB, 1)) MB)"
  }

  # 8. Resolve Web App Private Endpoint IP (if private) & select optimal ZIP deployment transport
  $webAppPeIp = ''
  if (-not $webAppPeId -and $WebAppPublicNetworkAccess -eq 'Disabled') {
    foreach ($pe in @(Invoke-AzJson network private-endpoint list)) {
      foreach ($conn in (@($pe.privateLinkServiceConnections) + @($pe.manualPrivateLinkServiceConnections))) {
        if ($conn -and $conn.privateLinkServiceId -and ($conn.privateLinkServiceId.ToLowerInvariant() -eq $webAppId.ToLowerInvariant()) -and ($conn.groupIds -contains 'sites')) {
          $webAppPeId = $pe.id
          break
        }
      }
      if ($webAppPeId) { break }
    }
  }
  if ($webAppPeId) {
    $peDetail = Invoke-AzJson resource show --ids $webAppPeId --api-version 2024-05-01 -AllowFailure
    if ($peDetail) {
      if ($peDetail.properties.customDnsConfigs -and $peDetail.properties.customDnsConfigs.Count -gt 0 -and $peDetail.properties.customDnsConfigs[0].ipAddresses.Count -gt 0) {
        $webAppPeIp = [string]$peDetail.properties.customDnsConfigs[0].ipAddresses[0]
      } elseif ($peDetail.properties.networkInterfaces -and $peDetail.properties.networkInterfaces.Count -gt 0) {
        $nicObj = Invoke-AzJson network nic show --ids $peDetail.properties.networkInterfaces[0].id -AllowFailure
        if ($nicObj -and $nicObj.ipConfigurations -and $nicObj.ipConfigurations.Count -gt 0) {
          $webAppPeIp = [string]$nicObj.ipConfigurations[0].privateIPAddress
        }
      }
    }
    if ($webAppPeIp) { Write-Host "    Web App Private Endpoint IP: $webAppPeIp" }
  }

  $curlCmd = if (Get-Command curl.exe -ErrorAction SilentlyContinue) { 'curl.exe' } elseif (Get-Command curl -ErrorAction SilentlyContinue) { 'curl' } else { $null }
  $nullDevice = if ($env:OS -eq 'Windows_NT') { 'NUL' } else { '/dev/null' }
  $deployMode = 'arm_onedeploy'
  $useCurlResolve = $false

  $preState = (Invoke-Az webapp show -g $ResourceGroup -n $Name --query state -o tsv -AllowFailure)
  if ($preState -and $preState.Trim() -eq 'Stopped') {
    Write-Step "Starting stopped Web App '$Name' before deployment"
    Invoke-Az webapp start -g $ResourceGroup -n $Name -o none | Out-Null
    Start-Sleep -Seconds 5
  }

  if (-not $PackageUri) {
    $maxProbeAttempts = if ($finalPublicNetworkAccess -eq 'Enabled') { 12 } else { 4 }
    $consecutiveDirectOk = 0
    for ($pAttempt = 1; $pAttempt -le $maxProbeAttempts; $pAttempt++) {
      $probeToken = (Invoke-Az account get-access-token --resource https://management.azure.com --query accessToken -o tsv).Trim()
      $directHttpCode = ''
      if ($curlCmd) {
        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          $directHttpCode = ((& $curlCmd -sS -o $nullDevice -w '%{http_code}' --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $probeToken" "https://$scmHost/api/deployments" 2>$null) -join '').Trim()
        } finally {
          $ErrorActionPreference = $previousPreference
        }
        if ($directHttpCode -eq '200') {
          $consecutiveDirectOk++
          if ($consecutiveDirectOk -ge 2 -or $finalPublicNetworkAccess -eq 'Disabled') {
            $deployMode = 'kudu_direct'
            break
          }
          Start-Sleep -Seconds 3
          continue
        }
        $consecutiveDirectOk = 0
      } else {
        try {
          $resp = Invoke-WebRequest -Uri "https://$scmHost/api/deployments" -Headers @{ Authorization = "Bearer $probeToken" } -UseBasicParsing -TimeoutSec 15
          if ($resp.StatusCode -eq 200) {
            $consecutiveDirectOk++
            if ($consecutiveDirectOk -ge 2 -or $finalPublicNetworkAccess -eq 'Disabled') {
              $deployMode = 'kudu_direct'
              break
            }
            Start-Sleep -Seconds 3
            continue
          }
        } catch { $consecutiveDirectOk = 0 }
      }

      $resolveHttpCode = ''
      if ($webAppPeIp -and $curlCmd) {
        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          $resolveHttpCode = ((& $curlCmd -sS -o $nullDevice -w '%{http_code}' --connect-timeout 4 --max-time 15 --resolve "${scmHost}:443:$webAppPeIp" -H "Authorization: Bearer $probeToken" "https://$scmHost/api/deployments" 2>$null) -join '').Trim()
        } finally {
          $ErrorActionPreference = $previousPreference
        }
        if ($resolveHttpCode -eq '200') {
          $deployMode = 'kudu_resolve'
          $useCurlResolve = $true
          break
        }
      }

      if ($finalPublicNetworkAccess -eq 'Disabled' -and $directHttpCode -eq '403' -and ($resolveHttpCode -in @('', '000'))) {
        break
      }
      if ($finalPublicNetworkAccess -eq 'Enabled' -and $directHttpCode -eq '403' -and $curlCmd -and $pAttempt -ge 2) {
        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          $hdrLines = @(& $curlCmd -sI --connect-timeout 5 --max-time 10 "https://$scmHost/api/deployments" 2>$null)
          $forbMatch = @($hdrLines | Where-Object { "$_" -match '(?i)^x-ms-forbidden-ip:\s*([0-9.]+)' }) | Select-Object -First 1
          if ($forbMatch -and "$forbMatch" -match '(?i)^x-ms-forbidden-ip:\s*([0-9.]+)') {
            $seenCallerIp = $Matches[1].Trim()
            if ($normalizedAllowedCidrs -notcontains "$seenCallerIp/32") {
              break
            }
          }
        } finally {
          $ErrorActionPreference = $previousPreference
        }
      }
      if ($pAttempt -lt $maxProbeAttempts) {
        Start-Sleep -Seconds 6
      }
    }
  }

  $tempScmOpened = $false

  try {
    if (-not $PackageUri -and $deployMode -notin @('kudu_direct', 'kudu_resolve')) {
      $callerPublicIp = ''
      foreach ($ipSvc in @('https://api.ipify.org', 'https://ifconfig.me/ip')) {
        if ($curlCmd) {
          $previousPreference = $ErrorActionPreference
          try {
            $ErrorActionPreference = 'Continue'
            $candidateIp = ((& $curlCmd -fsS --connect-timeout 4 --max-time 8 $ipSvc 2>$null) -join '').Trim()
            if ($candidateIp -match '^\d{1,3}(\.\d{1,3}){3}$') { $callerPublicIp = $candidateIp; break }
          } finally {
            $ErrorActionPreference = $previousPreference
          }
        } else {
          try {
            $candidateIp = ([string](Invoke-RestMethod -Uri $ipSvc -TimeoutSec 8)).Trim()
            if ($candidateIp -match '^\d{1,3}(\.\d{1,3}){3}$') { $callerPublicIp = $candidateIp; break }
          } catch { }
        }
      }
      if (-not $callerPublicIp) {
        $peHint = if ($webAppPeIp) { " (Private Endpoint IP: $webAppPeIp)" } else { '' }
        throw "Cannot reach Kudu SCM for '$Name'$peHint from this network and could not detect caller public IPv4. Run Deploy-AppService.ps1 from the internal VNet/Jumpbox or pass -PackageUri."
      }

      Write-Step "Temporarily allowing deployer IP ($callerPublicIp/32) on Kudu SCM only (DefaultAction=Deny) for direct ZIP upload"
      $scmTempRules = @(@{ name = 'temp-deployer-scm'; ipAddress = "$callerPublicIp/32"; action = 'Allow'; priority = 90 }) + $inboundRulesForRestore
      $openScmBody = New-TempFile (@{
        location   = $Location
        properties = @{
          publicNetworkAccess = 'Enabled'
          siteConfig          = @{
            publicNetworkAccess                    = 'Enabled'
            ipSecurityRestrictions                 = $inboundRulesForRestore
            ipSecurityRestrictionsDefaultAction    = 'Deny'
            scmIpSecurityRestrictions              = $scmTempRules
            scmIpSecurityRestrictionsDefaultAction = 'Deny'
            scmIpSecurityRestrictionsUseMain       = $false
          }
        }
      } | ConvertTo-Json -Depth 8 -Compress)
      Invoke-Az rest --method patch --url "https://management.azure.com$webAppId`?api-version=2023-12-01" --body "@$openScmBody" -o none | Out-Null
      $tempScmOpened = $true

      $scmReady = $false
      for ($scmWait = 1; $scmWait -le 15; $scmWait++) {
        $probeToken = (Invoke-Az account get-access-token --resource https://management.azure.com --query accessToken -o tsv).Trim()
        if ($curlCmd) {
          $previousPreference = $ErrorActionPreference
          try {
            $ErrorActionPreference = 'Continue'
            $c = ((& $curlCmd -sS -o $nullDevice -w '%{http_code}' --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $probeToken" "https://$scmHost/api/deployments" 2>$null) -join '').Trim()
            if ($c -eq '200') { $scmReady = $true; break }
          } finally {
            $ErrorActionPreference = $previousPreference
          }
        } else {
          try {
            $r = Invoke-WebRequest -Uri "https://$scmHost/api/deployments" -Headers @{ Authorization = "Bearer $probeToken" } -UseBasicParsing -TimeoutSec 15
            if ($r.StatusCode -eq 200) { $scmReady = $true; break }
          } catch { }
        }
        Start-Sleep -Seconds 6
      }
      if (-not $scmReady) {
        throw "Kudu SCM did not become reachable for $callerPublicIp/32 within 90 seconds."
      }
      $deployMode = 'kudu_temp_scm_ip'
    }

    if ($deployMode -in @('kudu_direct', 'kudu_resolve', 'kudu_temp_scm_ip')) {
      $kudu = "https://$scmHost/api/deployments"
      function Get-KuduDeployments {
        $tok = (Invoke-Az account get-access-token --resource https://management.azure.com --query accessToken -o tsv).Trim()
        $list = @()
        if ($useCurlResolve) {
          $rawJson = (& $curlCmd -fsS --connect-timeout 8 --max-time 25 --resolve "${scmHost}:443:$webAppPeIp" -H "Authorization: Bearer $tok" $kudu 2>$null) -join "`n"
          if ($rawJson) { foreach ($entry in @($rawJson | ConvertFrom-Json)) { $list += @($entry) } }
        } else {
          try {
            $raw = Invoke-RestMethod -Uri $kudu -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 25
            foreach ($entry in @($raw)) { $list += @($entry) }
          } catch { }
        }
        return ,$list
      }

      for ($lockWait = 1; $lockWait -le 24; $lockWait++) {
        $curDeps = Get-KuduDeployments
        $inProgress = @($curDeps | Where-Object { $_ -and ($_.complete -eq $false) })
        if ($inProgress.Count -eq 0) { break }
        if ($lockWait -eq 1) {
          Write-Host "    Waiting for previous in-progress Kudu deployment ($($inProgress[0].id)) to release lock..." -ForegroundColor Yellow
        }
        Start-Sleep -Seconds 8
      }

      $beforeDeployIds = @(Get-KuduDeployments | Where-Object { $_.id } | ForEach-Object { [string]$_.id })
      $uploadStartUtc = [DateTime]::UtcNow.AddSeconds(-5)

      Write-Step "Deploying the ZIP directly to App Service Kudu ($deployMode — zero Storage Account access)"
      $publishUrl = "https://$scmHost/api/publish?type=zip&clean=true&restart=true&async=true"
      $uploaded = $false
      for ($attempt = 1; $attempt -le 5 -and -not $uploaded; $attempt++) {
        $deployToken = (Invoke-Az account get-access-token --resource https://management.azure.com --query accessToken -o tsv).Trim()
        $httpCode = ''
        if ($curlCmd) {
          $curlArgs = @('-sS', '-o', $nullDevice, '-w', '%{http_code}', '--connect-timeout', '15', '--max-time', '900')
          if ($useCurlResolve) { $curlArgs += @('--resolve', "${scmHost}:443:$webAppPeIp") }
          $curlArgs += @('-X', 'POST', '-H', "Authorization: Bearer $deployToken", '-H', 'Content-Type: application/octet-stream', '--data-binary', "@$PackagePath", $publishUrl)
          $previousPreference = $ErrorActionPreference
          try {
            $ErrorActionPreference = 'Continue'
            $httpCode = ((& $curlCmd @curlArgs 2>$null) -join '').Trim()
            if ($LASTEXITCODE -eq 0 -and $httpCode -match '^20\d$') { $uploaded = $true }
          } finally {
            $ErrorActionPreference = $previousPreference
          }
        } else {
          try {
            Invoke-WebRequest -Uri $publishUrl -Method Post -InFile $PackagePath -ContentType 'application/octet-stream' `
              -Headers @{ Authorization = "Bearer $deployToken" } -UseBasicParsing -TimeoutSec 900 | Out-Null
            $uploaded = $true
          } catch { }
        }
        if (-not $uploaded) {
          if ($attempt -eq 5) { throw "ZIP upload to Kudu failed after 5 attempts ($deployMode, last HTTP status=$httpCode)." }
          Write-Host "    Upload attempt $attempt did not succeed yet (HTTP $(if ($httpCode) { $httpCode } else { 'timeout/reset' })); retrying in 15s..."
          Start-Sleep -Seconds 15
        }
      }

      Write-Step 'Waiting for Kudu extraction to finish'
      $deployed = $false
      for ($i = 1; $i -le 60 -and -not $deployed; $i++) {
        Start-Sleep -Seconds 8
        $items = Get-KuduDeployments
        if ($beforeDeployIds.Count -gt 0) {
          $items = @($items | Where-Object { $_.id -and ([string]$_.id -notin $beforeDeployIds) })
        } else {
          $items = @($items | Where-Object { $_.id -and $_.received_time -and ([DateTime]$_.received_time).ToUniversalTime() -ge $uploadStartUtc })
        }
        $latest = $items | Select-Object -First 1
        if ($latest -and $latest.complete) {
          if ($latest.status -ne 4) { throw "ZIP deployment $($latest.id) failed: $($latest.status_text)." }
          $deployed = $true
        }
      }
      if (-not $deployed) { throw 'The ZIP deployment did not finish within 8 minutes.' }
    } else {
      Write-Step 'Deploying external PackageUri via ARM Control-Plane OneDeploy'
      $armDepListUrl = "https://management.azure.com/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$Name/deployments?api-version=2023-12-01"
      $beforeArmDeps = @(Invoke-AzJson rest --method get --url $armDepListUrl --query value -AllowFailure | Where-Object { $_.name } | ForEach-Object { [string]$_.name })
      $armUploadStartUtc = [DateTime]::UtcNow.AddSeconds(-5)
      $oneDeployBody = New-TempFile (@{
        properties = @{
          packageUri = $PackageUri
          type       = 'zip'
          clean      = $true
        }
      } | ConvertTo-Json -Compress)
      $oneDeployUrl = "https://management.azure.com/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$Name/extensions/onedeploy?api-version=2023-12-01"
      Invoke-Az rest --method put --url $oneDeployUrl --body "@$oneDeployBody" -o none | Out-Null

      Write-Step 'Waiting for ARM OneDeploy extraction to complete'
      $armDeployed = $false
      for ($i = 1; $i -le 60 -and -not $armDeployed; $i++) {
        Start-Sleep -Seconds 8
        $armDeps = @(Invoke-AzJson rest --method get --url $armDepListUrl --query value -AllowFailure)
        $candidate = if ($beforeArmDeps.Count -gt 0) {
          @($armDeps | Where-Object { $_.name -and ([string]$_.name -notin $beforeArmDeps) }) | Select-Object -First 1
        } else {
          @($armDeps | Where-Object { $_.properties.start_time -and ([DateTime]$_.properties.start_time).ToUniversalTime() -ge $armUploadStartUtc }) | Select-Object -First 1
        }
        if ($candidate -and $candidate.properties.complete) {
          if ($candidate.properties.status -ne 4) {
            throw "ARM OneDeploy $($candidate.name) failed with status=$($candidate.properties.status): $($candidate.properties.message)"
          }
          $armDeployed = $true
          break
        }
        $extState = Invoke-AzJson rest --method get --url $oneDeployUrl -AllowFailure
        if ($extState -and $extState.properties -and $extState.properties.provisioningState -eq 'Succeeded' -and $i -ge 3) {
          $armDeployed = $true
          break
        }
        if ($extState -and $extState.properties -and $extState.properties.provisioningState -eq 'Failed') {
          throw "ARM OneDeploy failed: $($extState.properties | ConvertTo-Json -Compress)"
        }
      }
      if (-not $armDeployed) { throw 'ARM OneDeploy did not complete within 8 minutes.' }
    }
  } finally {
    if ($tempScmOpened) {
      Write-Step "Restoring Web App & SCM network lockdown (publicNetworkAccess=$finalPublicNetworkAccess, Unmatched=Deny)"
      $defaultAct = if ($finalPublicNetworkAccess -eq 'Disabled' -or $inboundRulesForRestore.Count -gt 0) { 'Deny' } else { 'Allow' }
      $closeScmBody = New-TempFile (@{
        location   = $Location
        properties = @{
          publicNetworkAccess = $finalPublicNetworkAccess
          siteConfig          = @{
            publicNetworkAccess                    = $finalPublicNetworkAccess
            ipSecurityRestrictions                 = $inboundRulesForRestore
            ipSecurityRestrictionsDefaultAction    = $defaultAct
            scmIpSecurityRestrictions              = $inboundRulesForRestore
            scmIpSecurityRestrictionsDefaultAction = $defaultAct
            scmIpSecurityRestrictionsUseMain       = $false
          }
        }
      } | ConvertTo-Json -Depth 8 -Compress)
      Invoke-Az rest --method patch --url "https://management.azure.com$webAppId`?api-version=2023-12-01" --body "@$closeScmBody" -o none -AllowFailure | Out-Null
    }
  }

  Write-Step 'Restarting Web App to load fresh Python runtime and static bundle'
  Invoke-Az webapp restart -g $ResourceGroup -n $Name -o none | Out-Null
  Invoke-Az rest --method post --url "https://management.azure.com/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$Name/config/configreferences/appsettings/refresh?api-version=2023-12-01" -o none -AllowFailure | Out-Null
  Start-Sleep -Seconds 10

  $url = "https://$hostName"
  if (-not $NoWaitHealth) {
    if ($deployMode -in @('kudu_direct', 'kudu_resolve')) {
      Write-Step 'Waiting for /health'
      $healthy = $false
      for ($i = 1; $i -le 40 -and -not $healthy; $i++) {
        if ($useCurlResolve) {
          $codeOut = (& $curlCmd -sS -o $nullDevice -w '%{http_code}' --connect-timeout 8 --max-time 15 --resolve "${hostName}:443:$webAppPeIp" "$url/health" 2>$null) -join ''
          if ($LASTEXITCODE -eq 0 -and $codeOut.Trim() -eq '200') { $healthy = $true; break }
        } else {
          try {
            $response = Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 15
            if ($response.StatusCode -eq 200) { $healthy = $true; break }
          } catch { }
        }
        Start-Sleep -Seconds 8
      }
      if (-not $healthy) {
        throw "The app did not become healthy on $url/health. Check logs in Log Analytics or App Service."
      }
    } else {
      Write-Step 'Verifying App Service control-plane state and Key Vault secret resolution (inbound HTTP is private)'
      $siteState = (Invoke-Az webapp show -g $ResourceGroup -n $Name --query state -o tsv).Trim()
      if ($siteState -ne 'Running') { throw "Web App '$Name' state is '$siteState' (expected 'Running')." }
      if ($AuthProvider -eq 'password' -and $doRoleAssignments) {
        $kvResolved = $false
        for ($i = 1; $i -le 12 -and -not $kvResolved; $i++) {
          $refs = @(Invoke-AzJson rest --method get --url "https://management.azure.com/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$Name/config/configreferences/appsettings?api-version=2023-12-01" --query value -AllowFailure)
          $pwRef = $refs | Where-Object { $_.name -eq 'ARMBACKUP_ADMIN_PASSWORD' } | Select-Object -First 1
          if ($pwRef -and $pwRef.properties.status -eq 'Resolved') {
            $kvResolved = $true
            Write-Host '    Key Vault reference ARMBACKUP_ADMIN_PASSWORD: Resolved'
            break
          }
          Invoke-Az rest --method post --url "https://management.azure.com/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$Name/config/configreferences/appsettings/refresh?api-version=2023-12-01" -o none -AllowFailure | Out-Null
          Start-Sleep -Seconds 8
        }
        if (-not $kvResolved) {
          Write-Warning 'ARMBACKUP_ADMIN_PASSWORD Key Vault reference is still initializing; RBAC propagation may take 1-2 minutes.'
        }
      }
      $peDisplay = if ($inboundRulesForRestore.Count -gt 0) {
        "Allowed IPs ($($normalizedAllowedCidrs -join ', ')) or $webAppPeIp"
      } elseif ($webAppPeIp) {
        $webAppPeIp
      } else {
        'VNet Private Endpoint'
      }
      Write-Host "    Web App state: $siteState (inbound publicNetworkAccess=$finalPublicNetworkAccess; reach $url via $peDisplay)."
    }
  }

  $publicAccessSummary = if ($inboundRulesForRestore.Count -gt 0) {
    "Enabled from select virtual networks and IP addresses (Allowed: $($normalizedAllowedCidrs -join ', ') | Unmatched: Deny)"
  } else {
    $finalPublicNetworkAccess
  }
  Write-Host "`nDeployment succeeded." -ForegroundColor Green
  Write-Host "  URL:             $url"
  if ($webAppPeIp) {
    Write-Host "  Private IP:      $webAppPeIp (groupIds: sites)"
  }
  Write-Host "  Public Access:   $publicAccessSummary"
  Write-Host "  Managed ID:      $principalId"
  Write-Host "  Storage:         $StorageAccountName (PublicNetworkAccess=Disabled; container='$storageContainerOut' initialized by App Service Startup code)"
  Write-Host "  Sign-in:         $AdminUsername / Key Vault secret '$secretName' in '$KeyVaultName'"
  if (-not $doRoleAssignments) {
    Write-Host "`n[Next Step for RBAC Administrator] Grant roles to Managed Identity '$principalId' then restart '$Name':" -ForegroundColor Yellow
    Write-Host "  1. Storage '$StorageAccountName': Storage Blob Data Contributor (App Service Startup code auto-creates isolated container '$storageContainerOut' & seeds state via VNet Integration -> Blob PE)"
    Write-Host "  2. Key Vault '$KeyVaultName': Key Vault Secrets User (scoped to secret '$secretName')"
    Write-Host "  3. Target Subscription '$TargetSubscriptionId': Reader$(if ($RestoreEnabled) { ' + Contributor' } else { ' (add Contributor only when restoreEnabled=true)' })"
    Write-Host "  4. Restart after RBAC propagation: az webapp restart -g $ResourceGroup -n $Name"
  }
} finally {
  foreach ($file in $tempFiles) { Remove-Item $file -ErrorAction SilentlyContinue }
}
