// Attaches Private Endpoints to an existing enterprise subnet (e.g. KT shared sbn-*-pe) without
// creating Private DNS Zones or VNet Links (which are denied in KT workload subscriptions where
// central Hub DNS / Azure Policy DeployIfNotExists manages privatelink.* zones).
//
// Optionally attaches privateDnsZoneGroups only when explicit Private DNS Zone resource IDs are supplied.

targetScope = 'resourceGroup'

param location string
param tags object = {}
param privateEndpointSubnetId string

param createWebAppPrivateEndpoint bool = false
param webAppId string = ''
param webAppName string = ''
param sitesPrivateDnsZoneId string = ''

@description('Subset of Storage sub-resources (blob) that still need Private Endpoints.')
param storageGroupsToCreate array = []
param storageAccountId string = ''
param storageAccountName string = ''
param blobPrivateDnsZoneId string = ''

param createKeyVaultPrivateEndpoint bool = false
param keyVaultId string = ''
param keyVaultName string = ''
param vaultPrivateDnsZoneId string = ''

var deployWebAppPe = createWebAppPrivateEndpoint && !empty(privateEndpointSubnetId) && !empty(webAppId) && !empty(webAppName)
var deployStoragePe = !empty(privateEndpointSubnetId) && !empty(storageAccountId) && !empty(storageAccountName) && !empty(storageGroupsToCreate)
var deployKeyVaultPe = createKeyVaultPrivateEndpoint && !empty(privateEndpointSubnetId) && !empty(keyVaultId) && !empty(keyVaultName)

var storageDnsZoneMap = {
  blob: blobPrivateDnsZoneId
}

var webAppPeName = take('pe-sites-${webAppName}', 80)
var webAppPeTags = contains(tags, 'Name') ? union(tags, { Name: webAppPeName }) : tags
var kvPeName = take('pe-vault-${keyVaultName}', 80)
var kvPeTags = contains(tags, 'Name') ? union(tags, { Name: kvPeName }) : tags

resource webAppPe 'Microsoft.Network/privateEndpoints@2024-05-01' = if (deployWebAppPe) {
  name: webAppPeName
  location: location
  tags: webAppPeTags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: take('${webAppPeName}-conn', 80)
        properties: {
          privateLinkServiceId: webAppId
          groupIds: [
            'sites'
          ]
        }
      }
    ]
  }
}

resource webAppPeDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (deployWebAppPe && !empty(sitesPrivateDnsZoneId)) {
  parent: webAppPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'sites'
        properties: {
          privateDnsZoneId: sitesPrivateDnsZoneId
        }
      }
    ]
  }
}

resource storagePes 'Microsoft.Network/privateEndpoints@2024-05-01' = [for group in storageGroupsToCreate: if (deployStoragePe) {
  name: take('pe-${group}-${storageAccountName}', 80)
  location: location
  tags: contains(tags, 'Name') ? union(tags, { Name: take('pe-${group}-${storageAccountName}', 80) }) : tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: take('pe-${group}-${storageAccountName}-conn', 80)
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: [
            group
          ]
        }
      }
    ]
  }
}]

resource storagePeDnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (group, idx) in storageGroupsToCreate: if (deployStoragePe && contains(storageDnsZoneMap, string(group)) && !empty(storageDnsZoneMap[string(group)])) {
  parent: storagePes[idx]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: string(group)
        properties: {
          privateDnsZoneId: storageDnsZoneMap[string(group)]
        }
      }
    ]
  }
}]

resource keyVaultPe 'Microsoft.Network/privateEndpoints@2024-05-01' = if (deployKeyVaultPe) {
  name: kvPeName
  location: location
  tags: kvPeTags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: take('${kvPeName}-conn', 80)
        properties: {
          privateLinkServiceId: keyVaultId
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource keyVaultPeDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (deployKeyVaultPe && !empty(vaultPrivateDnsZoneId)) {
  parent: keyVaultPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: vaultPrivateDnsZoneId
        }
      }
    ]
  }
}

output webAppPrivateEndpointId string = deployWebAppPe ? webAppPe!.id : ''
