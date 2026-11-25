// Azure App Service (Linux) Infrastructure as Code for Configuration Vault (armbackup).
//
// Supports two topologies in one unified declarative template (matching azfirewallagent):
//   1. Enterprise Shared Infrastructure (KT Landing Zone recommended):
//      Pass existingAppServicePlanId, existingStorageAccountId, existingKeyVaultId, existingLogAnalyticsWorkspaceId,
//      vnetIntegrationSubnetId, and privateEndpointSubnetId. Creates the Linux Web App atomically with
//      publicNetworkAccess: 'Disabled', HTTPS-only, TLS 1.2+, FTPS/BasicAuth disabled, Log Analytics diagnostic
//      settings, inbound 'sites' Private Endpoint (without creating forbidden Private DNS Zones), and per-resource
//      least-privilege RBAC (container/secret scope) for multi-project isolation alongside azfirewallagent.
//   2. Standalone Provisioning:
//      Creates a Linux App Service Plan (P0v3), OAuth-only Storage Account (Blob, shared key and cross-tenant
//      replication disabled), RBAC Key Vault (purge protection enabled), managed VNet + Private Endpoints,
//      and Linux Web App.
//
// Pre-compiled to azuredeploy.json in the customer delivery kit so customer jumpboxes need only `az` CLI (no Bicep download).

targetScope = 'resourceGroup'

@description('Deployment location for newly created resources. Must match the App Service Plan region.')
param location string = resourceGroup().location

@minLength(3)
@maxLength(56)
@description('Globally unique Azure App Service Web App name.')
param webAppName string

@description('Python runtime version on App Service Linux.')
@allowed([
  '3.12'
  '3.13'
  '3.14'
])
param pythonVersion string = '3.12'

@description('App Service Plan SKU when provisioning a new Linux plan.')
param appServicePlanSku string = 'P0v3'

@description('Enable AlwaysOn on the Linux Web App (disable only for Free/Shared test plans).')
param enableAlwaysOn bool = true

@description('Optional resource ID of an existing Linux App Service Plan. Empty creates a new plan.')
param existingAppServicePlanId string = ''

@description('Optional resource ID of an existing Storage Account. Empty creates a new OAuth-only Storage Account.')
param existingStorageAccountId string = ''

@description('Optional resource ID of an existing Key Vault. Empty creates a new RBAC Key Vault with purge protection.')
param existingKeyVaultId string = ''

@description('Optional resource ID of an existing Log Analytics Workspace for App Service Diagnostic Settings.')
param existingLogAnalyticsWorkspaceId string = ''

@description('Skip creating diag-<webAppName> when another diagnostic setting on the Web App (e.g. Azure Policy DeployIfNotExists) already streams to existingLogAnalyticsWorkspaceId.')
param skipDiagnosticSettings bool = false

@description('Optional explicit Storage namespace prefix for isolating this app on a shared Storage Account.')
param storageNamespaceOverride string = ''

@description('Optional explicit Blob container name override (3-63 lowercase chars, no double hyphens). Defaults to <namespace>-backups.')
param storageContainerOverride string = ''

@description('Blob path prefix inside the container.')
param storageBlobPrefix string = 'armbackup'

@description('Display name of the workspace shown in the console header.')
param workspaceDisplayName string = 'KT'

@description('Target Azure subscription ID whose resources are discovered and backed up. Defaults to the current deployment subscription.')
param targetSubscriptionId string = ''

@description('Display name of the target subscription shown in the console.')
param targetSubscriptionName string = ''

@description('Enable live ARM restore and clone execution in the console.')
param restoreEnabled bool = false

@description('Number of days (1..7) of Azure Activity Log change attribution to query.')
@minValue(1)
@maxValue(7)
param activityDays int = 2

@description('Inbound public network access on App Service and SCM/Kudu. Defaults to Disabled for KT Azure Policy compliance.')
@allowed([
  'Disabled'
  'Enabled'
])
param webAppPublicNetworkAccess string = 'Disabled'

@description('Optional allowed client IPv4 addresses or CIDRs when webAppPublicNetworkAccess is Enabled. Sets ipSecurityRestrictionsDefaultAction=Deny on both main site and SCM to satisfy KT Policy 1ecd1aa5e35f50d5ab9c6d0d.')
param allowedIpCidrs array = []

@description('True when deploying an Oryx source ZIP (SCM_DO_BUILD_DURING_DEPLOYMENT=true); false when deploying pre-bundled Linux wheels.')
param useOryxBuild bool = false

@description('Optional name for the dedicated User Assigned Managed Identity created in the project Resource Group when existingManagedIdentityId is empty (defaults to id-<slug>).')
param managedIdentityName string = ''

@description('Optional resource ID of an existing User Assigned Managed Identity to attach to the Web App and use for all ARM, Storage, and Monitor API calls. System Assigned Managed Identity is always disabled.')
param existingManagedIdentityId string = ''

@description('Optional additional User Assigned Managed Identity resource IDs already attached to the Web App to preserve on idempotent re-runs.')
param additionalUserAssignedIdentityIds array = []

@description('Optional pre-resolved Client ID (UUID) of existingManagedIdentityId.')
param userAssignedIdentityClientId string = ''

@description('Optional pre-resolved Principal/Object ID (UUID) of existingManagedIdentityId.')
param userAssignedIdentityPrincipalId string = ''

@description('Sign-in provider: password (direct scrypt hash in App Settings by default while Entra ID is pending).')
@allowed([
  'password'
])
param authProvider string = 'password'

@description('Use Azure Key Vault secret reference (@Microsoft.KeyVault) for admin password. Defaults to false so temporary ID/Password sign-in works directly via App Settings without Key Vault secrets or RBAC.')
param useKeyVaultSecret bool = false

@description('Built-in sign-in username when authProvider is password.')
param adminUsername string = 'admin'

@description('Salted scrypt password verifier hash (scrypt:N:r:p:salt:digest) set in ARMBACKUP_AUTH_PASSWORD_HASH when useKeyVaultSecret is false and adminPassword is empty.')
#disable-next-line secure-secrets-in-params
param adminPasswordHash string = 'scrypt:32768:8:3:GSmKwboJ-5FG3tKFeVx-lw:-O1V3rvEVr7CDF6hyT9mJz3U5LjAYcjjRqJyBVFxdds'

@secure()
@description('Optional sign-in password override (stored in Key Vault only when useKeyVaultSecret is true, otherwise passed via ARMBACKUP_ADMIN_PASSWORD when explicitly provided).')
param adminPassword string = ''

@description('Optional Log Analytics Workspace GUID (customerId) for custom ArmBackup_CL DCR/DCE event querying (fail-open).')
param logWorkspaceGuid string = ''

@description('Optional Data Collection Rule ARM resource ID for custom ArmBackup_CL ingestion (fail-open).')
param logDcrId string = ''

@description('Optional Data Collection Rule immutableId (dcr-...) for custom ArmBackup_CL ingestion (fail-open).')
param logRuleId string = ''

@description('Optional DCE/DCR logs ingestion endpoint URL (https://...ingest.monitor.azure.com) for custom ArmBackup_CL ingestion (fail-open).')
param logEndpoint string = ''

@description('Optional DCR stream name (e.g. Custom-ArmBackup_CL or Custom-ArmBackup).')
param logStream string = ''

@description('Optional VNet subnet resource ID for regional VNet integration (required when Storage or Key Vault is private).')
param vnetIntegrationSubnetId string = ''

@description('Route all outbound internet traffic through VNet integration. Defaults to false so RFC1918 Private Endpoints and VNet/Hub routes traverse VNet integration while Azure Resource Manager and Entra ID remain reachable even on defaultOutboundAccess=false subnets without NAT Gateway.')
param vnetRouteAllEnabled bool = false

@description('Optional existing subnet resource ID for Private Endpoints (App Service inbound sites PE and/or missing shared Storage/KeyVault PEs).')
param privateEndpointSubnetId string = ''

@description('Optional Resource Group name where Private Endpoints are placed (defaults to current deployment Resource Group).')
param privateEndpointResourceGroup string = ''

@description('Create inbound Private Endpoint (groupIds: [sites]) for the Web App when a Private Endpoint subnet is available.')
param enableWebAppPrivateEndpoint bool = true

@description('Subset of Storage sub-resources (blob) for which a missing Private Endpoint should be created on privateEndpointSubnetId.')
param storagePrivateEndpointGroups array = []

@description('Create a vault Private Endpoint on privateEndpointSubnetId for an existing shared Key Vault that lacks one.')
param createKeyVaultPrivateEndpoint bool = false

@description('Optional existing Private DNS Zone resource IDs. Leave empty in KT subscriptions where central Hub DNS / Azure Policy DINE manages privatelink.* zones.')
param sitesPrivateDnsZoneId string = ''
param blobPrivateDnsZoneId string = ''
param vaultPrivateDnsZoneId string = ''

@description('Provision a dedicated VNet, App Service subnet, and Private Endpoints + Private DNS Zones when vnetIntegrationSubnetId is empty.')
param enablePrivateNetworking bool = true

@description('CIDR block for the managed VNet when enablePrivateNetworking creates one.')
param vnetAddressPrefix string = '10.244.0.0/24'

@description('App Service regional VNet integration subnet CIDR inside vnetAddressPrefix.')
param appServiceSubnetPrefix string = '10.244.0.0/26'

@description('Private Endpoint subnet CIDR inside vnetAddressPrefix.')
param privateEndpointSubnetPrefix string = '10.244.0.64/26'

@description('Whether to create Storage/Key Vault data-plane RBAC assignments inside this deployment. Defaults to false so Contributor operators can deploy without Role Assignment permissions.')
param assignDataPlaneRbac bool = false

@description('Provision Blob container via ARM during deployment. Defaults to false when using a shared Storage Account without RBAC assignment because the Python runtime auto-creates the container via Managed Identity.')
param provisionStorageResources bool = false

@description('Scope Storage/Key Vault RBAC strictly to this app container/secret (true) vs whole account/vault (false).')
param resourceScopedDataPlaneRbac bool = true

param tags object = {
  Application: 'armbackup'
  HostingPlatform: 'app-service'
}

var cleanSlug = toLower(replace(replace(replace(webAppName, 'app-', ''), 'as-', ''), '-', ''))
var uniqueSuffix = take(uniqueString(resourceGroup().id, webAppName), 8)
var defaultStorageName = take('stab${cleanSlug}${uniqueSuffix}', 24)
var defaultKeyVaultName = take('kv-ab-${take(cleanSlug, 10)}-${uniqueSuffix}', 24)
var defaultPlanName = take('asp-${webAppName}', 40)

var createPlan = empty(existingAppServicePlanId)
var createStorage = empty(existingStorageAccountId)
var createKeyVault = useKeyVaultSecret && empty(existingKeyVaultId)
var needStandaloneVnet = enablePrivateNetworking && empty(vnetIntegrationSubnetId) && empty(privateEndpointSubnetId) && (createStorage || createKeyVault || webAppPublicNetworkAccess == 'Disabled')
var lockDownDataPlanes = needStandaloneVnet || !empty(vnetIntegrationSubnetId) || !empty(privateEndpointSubnetId)

var storageParts = split(existingStorageAccountId, '/')
var storageSubId = createStorage ? subscription().subscriptionId : storageParts[2]
var storageRgName = createStorage ? resourceGroup().name : storageParts[4]
var effectiveStorageName = createStorage ? defaultStorageName : last(storageParts)

var hasExistingKv = !empty(existingKeyVaultId)
var kvParts = split(existingKeyVaultId, '/')
var kvSubId = hasExistingKv ? kvParts[2] : subscription().subscriptionId
var kvRgName = hasExistingKv ? kvParts[4] : resourceGroup().name
var effectiveKeyVaultName = createKeyVault ? defaultKeyVaultName : (hasExistingKv ? last(kvParts) : '')

var hasExistingUami = !empty(existingManagedIdentityId)
var createUami = !hasExistingUami
var defaultUamiName = take(
  startsWith(toLower(webAppName), 'app-')
    ? 'id-${substring(webAppName, 4)}'
    : (startsWith(toLower(webAppName), 'as-') ? 'id-${substring(webAppName, 3)}' : 'id-${webAppName}'),
  128
)
var effectiveUamiName = !empty(managedIdentityName) ? managedIdentityName : defaultUamiName
var createdUamiId = resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', effectiveUamiName)
var effectiveUamiId = createUami ? createdUamiId : existingManagedIdentityId
var uamiParts = split(existingManagedIdentityId, '/')
var uamiSubId = hasExistingUami ? uamiParts[2] : subscription().subscriptionId
var uamiRgName = hasExistingUami ? uamiParts[4] : resourceGroup().name
var existingUamiName = hasExistingUami ? last(uamiParts) : effectiveUamiName
var uamiResourceTags = contains(tags, 'Name') ? union(tags, { Name: effectiveUamiName }) : tags

var strippedWebApp = toLower(startsWith(toLower(webAppName), 'app-') ? substring(webAppName, 4) : (startsWith(toLower(webAppName), 'as-') ? substring(webAppName, 3) : webAppName))
var normalizedSlug = replace(replace(strippedWebApp, '--', '-'), '_', '-')
var autoNamespace = (length(normalizedSlug) <= 44 && !endsWith(normalizedSlug, '-'))
  ? normalizedSlug
  : '${replace(take(normalizedSlug, 28), '-', '')}-${uniqueSuffix}'
var namespace = !empty(storageNamespaceOverride) ? toLower(storageNamespaceOverride) : autoNamespace
var containerName = !empty(storageContainerOverride) ? toLower(storageContainerOverride) : '${namespace}-backups'
var adminSecretName = '${webAppName}-admin-password'
var keyVaultSecretUri = 'https://${effectiveKeyVaultName}${environment().suffixes.keyvaultDns}/secrets/${adminSecretName}'

var effectiveTargetSubId = !empty(targetSubscriptionId) ? targetSubscriptionId : subscription().subscriptionId
var effectiveTargetSubName = !empty(targetSubscriptionName) ? targetSubscriptionName : effectiveTargetSubId
var effectiveWorkspaceLabel = !empty(workspaceDisplayName) ? workspaceDisplayName : webAppName

var freeOrSharedSkus = [
  'F1'
  'FREE'
  'D1'
  'SHARED'
]
var effectiveAlwaysOn = enableAlwaysOn && (!createPlan || !contains(freeOrSharedSkus, toUpper(appServicePlanSku)))

resource userIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (createUami) {
  name: effectiveUamiName
  location: location
  tags: uamiResourceTags
}

resource existingUserIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (hasExistingUami) {
  name: existingUamiName
  scope: resourceGroup(uamiSubId, uamiRgName)
}

var allUamiIds = union(
  [effectiveUamiId],
  additionalUserAssignedIdentityIds
)
var uamiIdentityMap = reduce(allUamiIds, {}, (cur, item) => union(cur, { '${string(item)}': {} }))

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = if (createPlan) {
  name: defaultPlanName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: appServicePlanSku
  }
  properties: {
    reserved: true
  }
}

// Storage Account publicNetworkAccess is strictly locked to 'Disabled' (no other value permitted by KT governance).
resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' = if (createStorage) {
  name: defaultStorageName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = if (createKeyVault) {
  name: defaultKeyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: lockDownDataPlanes ? 'Disabled' : 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: lockDownDataPlanes ? 'Deny' : 'Allow'
    }
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

var createStandaloneSitesDns = needStandaloneVnet && enableWebAppPrivateEndpoint && webAppPublicNetworkAccess == 'Disabled' && empty(sitesPrivateDnsZoneId)

module privateNetwork './private-network.bicep' = if (needStandaloneVnet) {
  name: 'ab-private-net-${uniqueSuffix}'
  params: {
    location: location
    namePrefix: webAppName
    tags: tags
    vnetAddressPrefix: vnetAddressPrefix
    appServiceSubnetPrefix: appServiceSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    storageAccountId: createStorage ? storage.id : ''
    storageAccountName: createStorage ? defaultStorageName : ''
    keyVaultId: createKeyVault ? keyVault.id : ''
    keyVaultName: createKeyVault ? defaultKeyVaultName : ''
    createSitesDnsZone: createStandaloneSitesDns
  }
}

var effectiveVnetSubnetId = needStandaloneVnet ? privateNetwork!.outputs.appServiceSubnetId : vnetIntegrationSubnetId
var effectivePeSubnetId = !empty(privateEndpointSubnetId) ? privateEndpointSubnetId : (needStandaloneVnet ? privateNetwork!.outputs.privateEndpointSubnetId : '')
var effectiveSitesDnsZoneId = !empty(sitesPrivateDnsZoneId) ? sitesPrivateDnsZoneId : (createStandaloneSitesDns ? privateNetwork!.outputs.sitesDnsZoneId : '')
var effectivePeRgName = !empty(privateEndpointResourceGroup) ? privateEndpointResourceGroup : resourceGroup().name

var baseAppSettings = [
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: useOryxBuild ? 'true' : 'false' }
  { name: 'ENABLE_ORYX_BUILD', value: useOryxBuild ? 'true' : 'false' }
  { name: 'WEBSITES_PORT', value: '8000' }
  { name: 'WEBSITES_CONTAINER_START_TIME_LIMIT', value: '1800' }
  { name: 'PYTHONUNBUFFERED', value: '1' }
  { name: 'ARMBACKUP_HOSTED_ENV_CONFIG', value: 'true' }
  { name: 'ARMBACKUP_WORKSPACE_NAME', value: effectiveWorkspaceLabel }
  { name: 'ARMBACKUP_SUBSCRIPTION_ID', value: effectiveTargetSubId }
  { name: 'ARMBACKUP_SUBSCRIPTION_NAME', value: effectiveTargetSubName }
  { name: 'ARMBACKUP_INVENTORY_SCOPE', value: 'subscription' }
  { name: 'ARMBACKUP_RESTORE_ENABLED', value: restoreEnabled ? 'true' : 'false' }
  { name: 'ARMBACKUP_ACTIVITY_DAYS', value: string(activityDays) }
  { name: 'ARMBACKUP_CREDENTIAL_MODE', value: 'managed_identity' }
  { name: 'ARMBACKUP_STORAGE_ACCOUNT', value: effectiveStorageName }
  { name: 'ARMBACKUP_STORAGE_SUBSCRIPTION_ID', value: storageSubId }
  { name: 'ARMBACKUP_STORAGE_RESOURCE_GROUP', value: storageRgName }
  { name: 'ARMBACKUP_STORAGE_CONTAINER', value: containerName }
  { name: 'ARMBACKUP_STORAGE_PREFIX', value: storageBlobPrefix }
  { name: 'ARMBACKUP_REQUIRE_PRIVATE_STORAGE', value: 'true' }
  { name: 'ARMBACKUP_AUTH_MODE', value: authProvider }
]

var authAppSettings = useKeyVaultSecret
  ? [
      { name: 'ARMBACKUP_AUTH_USERNAME', value: adminUsername }
      { name: 'ARMBACKUP_ADMIN_PASSWORD', value: '@Microsoft.KeyVault(SecretUri=${keyVaultSecretUri})' }
    ]
  : (!empty(adminPassword)
      ? [
          { name: 'ARMBACKUP_AUTH_USERNAME', value: adminUsername }
          { name: 'ARMBACKUP_ADMIN_PASSWORD', value: adminPassword }
        ]
      : [
          { name: 'ARMBACKUP_AUTH_USERNAME', value: adminUsername }
          { name: 'ARMBACKUP_AUTH_PASSWORD_HASH', value: adminPasswordHash }
        ])

var hasCustomDcrLogging = !empty(logDcrId) && !empty(logRuleId) && !empty(logEndpoint)
var logAppSettings = !hasCustomDcrLogging ? [] : concat(
  empty(existingLogAnalyticsWorkspaceId) ? [] : [ { name: 'ARMBACKUP_LOG_WORKSPACE_ID', value: existingLogAnalyticsWorkspaceId } ],
  empty(logWorkspaceGuid) ? [] : [ { name: 'ARMBACKUP_LOG_WORKSPACE_GUID', value: logWorkspaceGuid } ],
  [
    { name: 'ARMBACKUP_LOG_DCR_ID', value: logDcrId }
    { name: 'ARMBACKUP_LOG_RULE_ID', value: logRuleId }
    { name: 'ARMBACKUP_LOG_ENDPOINT', value: logEndpoint }
  ],
  empty(logStream) ? [] : [ { name: 'ARMBACKUP_LOG_STREAM', value: logStream } ]
)

var restrictInboundIps = webAppPublicNetworkAccess == 'Disabled' || !empty(allowedIpCidrs)
var inboundIpRules = [for (cidr, idx) in allowedIpCidrs: {
  name: 'allow-client-${idx + 1}'
  ipAddress: contains(string(cidr), '/') ? string(cidr) : '${string(cidr)}/32'
  action: 'Allow'
  priority: 100 + (idx * 10)
}]
var webAppResourceTags = contains(tags, 'Name') ? union(tags, { Name: webAppName }) : tags

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  tags: webAppResourceTags
  kind: 'app,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: uamiIdentityMap
  }
  properties: {
    serverFarmId: createPlan ? appServicePlan.id : existingAppServicePlanId
    httpsOnly: true
    publicNetworkAccess: webAppPublicNetworkAccess
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: effectiveUamiId
    virtualNetworkSubnetId: empty(effectiveVnetSubnetId) ? null : effectiveVnetSubnetId
    vnetRouteAllEnabled: !empty(effectiveVnetSubnetId) && vnetRouteAllEnabled
    siteConfig: {
      linuxFxVersion: 'PYTHON|${pythonVersion}'
      appCommandLine: 'bash /home/site/wwwroot/startup.sh'
      alwaysOn: effectiveAlwaysOn
      http20Enabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      publicNetworkAccess: webAppPublicNetworkAccess
      remoteDebuggingEnabled: false
      vnetRouteAllEnabled: !empty(effectiveVnetSubnetId) && vnetRouteAllEnabled
      ipSecurityRestrictions: inboundIpRules
      ipSecurityRestrictionsDefaultAction: restrictInboundIps ? 'Deny' : 'Allow'
      scmIpSecurityRestrictions: inboundIpRules
      scmIpSecurityRestrictionsDefaultAction: restrictInboundIps ? 'Deny' : 'Allow'
      scmIpSecurityRestrictionsUseMain: false
      healthCheckPath: '/health'
      appSettings: concat(
        baseAppSettings,
        [
          {
            name: 'ARMBACKUP_REQUIRE_USER_ASSIGNED_IDENTITY'
            value: 'true'
          }
          {
            name: 'ARMBACKUP_MANAGED_IDENTITY_CLIENT_ID'
            value: createUami
              ? userIdentity!.properties.clientId
              : (!empty(userAssignedIdentityClientId) ? userAssignedIdentityClientId : existingUserIdentity!.properties.clientId)
          }
          {
            name: 'ARMBACKUP_MANAGED_IDENTITY_RESOURCE_ID'
            value: effectiveUamiId
          }
          {
            name: 'AZURE_CLIENT_ID'
            value: createUami
              ? userIdentity!.properties.clientId
              : (!empty(userAssignedIdentityClientId) ? userAssignedIdentityClientId : existingUserIdentity!.properties.clientId)
          }
        ],
        authAppSettings,
        logAppSettings
      )
    }
  }
}

resource basicPublishingScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: webApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource basicPublishingFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: webApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource authSettings 'Microsoft.Web/sites/config@2022-03-01' = if (authProvider == 'password') {
  parent: webApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: false
    }
  }
}

resource webAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(existingLogAnalyticsWorkspaceId) && !skipDiagnosticSettings) {
  name: 'diag-${webAppName}'
  scope: webApp
  properties: {
    workspaceId: existingLogAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

var hasPeSubnet = !empty(privateEndpointSubnetId) || needStandaloneVnet
var shouldCreateWebAppPe = enableWebAppPrivateEndpoint && hasPeSubnet
var shouldCreateSharedStoragePes = !createStorage && !empty(storagePrivateEndpointGroups) && hasPeSubnet
var shouldCreateSharedKvPe = useKeyVaultSecret && !createKeyVault && hasExistingKv && createKeyVaultPrivateEndpoint && hasPeSubnet
// Non-shared project resources (including any newly provisioned Private Endpoints) live inside the project's dedicated Resource Group.
var sharedStoragePeRgName = effectivePeRgName
var sharedKvPeRgName = effectivePeRgName

module sharedPrivateEndpoints './shared-private-endpoints.bicep' = if (shouldCreateWebAppPe) {
  name: 'ab-webapp-pe-${uniqueSuffix}'
  scope: resourceGroup(subscription().subscriptionId, effectivePeRgName)
  params: {
    location: location
    tags: tags
    privateEndpointSubnetId: effectivePeSubnetId
    createWebAppPrivateEndpoint: true
    webAppId: webApp.id
    webAppName: webApp.name
    sitesPrivateDnsZoneId: effectiveSitesDnsZoneId
  }
}

module sharedStoragePrivateEndpoints './shared-private-endpoints.bicep' = if (shouldCreateSharedStoragePes) {
  name: 'ab-st-pe-${uniqueSuffix}'
  scope: resourceGroup(storageSubId, sharedStoragePeRgName)
  params: {
    location: location
    tags: tags
    privateEndpointSubnetId: effectivePeSubnetId
    storageGroupsToCreate: storagePrivateEndpointGroups
    storageAccountId: existingStorageAccountId
    storageAccountName: effectiveStorageName
    blobPrivateDnsZoneId: blobPrivateDnsZoneId
  }
}

module sharedKvPrivateEndpoint './shared-private-endpoints.bicep' = if (shouldCreateSharedKvPe) {
  name: 'ab-kv-pe-${uniqueSuffix}'
  scope: resourceGroup(kvSubId, sharedKvPeRgName)
  params: {
    location: location
    tags: tags
    privateEndpointSubnetId: effectivePeSubnetId
    createKeyVaultPrivateEndpoint: true
    keyVaultId: existingKeyVaultId
    keyVaultName: effectiveKeyVaultName
    vaultPrivateDnsZoneId: vaultPrivateDnsZoneId
  }
}

var shouldRunStorageSetup = createStorage || assignDataPlaneRbac || provisionStorageResources
var shouldRunKeyVaultSetup = useKeyVaultSecret && (createKeyVault || assignDataPlaneRbac || (authProvider == 'password' && !empty(adminPassword)))

module storageSetup './storage-setup.bicep' = if (shouldRunStorageSetup) {
  name: 'ab-storage-setup-${uniqueSuffix}'
  scope: resourceGroup(storageSubId, storageRgName)
  params: {
    storageAccountName: createStorage ? storage!.name : effectiveStorageName
    containerName: containerName
    principalId: createUami
      ? userIdentity!.properties.principalId
      : (!empty(userAssignedIdentityPrincipalId) ? userAssignedIdentityPrincipalId : existingUserIdentity!.properties.principalId)
    assignRbac: assignDataPlaneRbac
    resourceScopedRbac: resourceScopedDataPlaneRbac
  }
}

module keyVaultSetup './keyvault-setup.bicep' = if (shouldRunKeyVaultSetup) {
  name: 'ab-kv-setup-${uniqueSuffix}'
  scope: resourceGroup(kvSubId, kvRgName)
  params: {
    keyVaultName: createKeyVault ? keyVault!.name : effectiveKeyVaultName
    secretName: adminSecretName
    adminPassword: adminPassword
    storeSecret: authProvider == 'password'
    principalId: createUami
      ? userIdentity!.properties.principalId
      : (!empty(userAssignedIdentityPrincipalId) ? userAssignedIdentityPrincipalId : existingUserIdentity!.properties.principalId)
    assignRbac: assignDataPlaneRbac
    secretScopedRbac: resourceScopedDataPlaneRbac
  }
}

output webAppName string = webApp.name
output webAppHostName string = webApp.properties.defaultHostName
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output principalId string = createUami
  ? userIdentity!.properties.principalId
  : (!empty(userAssignedIdentityPrincipalId) ? userAssignedIdentityPrincipalId : existingUserIdentity!.properties.principalId)
output managedIdentityClientId string = createUami
  ? userIdentity!.properties.clientId
  : (!empty(userAssignedIdentityClientId) ? userAssignedIdentityClientId : existingUserIdentity!.properties.clientId)
output managedIdentityResourceId string = effectiveUamiId
output storageAccountId string = createStorage ? storage.id : existingStorageAccountId
output storageAccountName string = effectiveStorageName
output storageContainerName string = containerName
output storageNamespace string = namespace
output keyVaultId string = createKeyVault ? keyVault.id : (useKeyVaultSecret ? existingKeyVaultId : '')
output keyVaultName string = useKeyVaultSecret ? effectiveKeyVaultName : ''
output keyVaultEntryName string = useKeyVaultSecret ? adminSecretName : ''
output webAppPublicNetworkAccess string = webAppPublicNetworkAccess
output webAppPrivateEndpointId string = shouldCreateWebAppPe ? sharedPrivateEndpoints!.outputs.webAppPrivateEndpointId : ''
