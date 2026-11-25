// Dedicated Virtual Network, App Service integration subnet, and Private Endpoints + Private DNS Zones
// for Azure Blob Storage and Azure Key Vault (standalone provisioning mode).
//
// Keeps Storage Account and Key Vault completely off the public internet (publicNetworkAccess: Disabled)
// while allowing the Linux App Service to resolve Key Vault secret references and Blob Storage privately.

targetScope = 'resourceGroup'

param location string
param namePrefix string
param tags object = {}

param vnetAddressPrefix string = '10.244.0.0/24'
param appServiceSubnetPrefix string = '10.244.0.0/26'
param privateEndpointSubnetPrefix string = '10.244.0.64/26'

@description('Resource ID of the newly created Storage Account to attach a blob Private Endpoint to (empty skips).')
param storageAccountId string = ''
param storageAccountName string = ''

@description('Resource ID of the newly created Key Vault to attach a vault Private Endpoint to (empty skips).')
param keyVaultId string = ''
param keyVaultName string = ''

@description('Create privatelink.azurewebsites.net Private DNS Zone + VNet Link for inbound Web App Private Endpoint in standalone mode.')
param createSitesDnsZone bool = false

var attachStorage = !empty(storageAccountId) && !empty(storageAccountName)
var attachKeyVault = !empty(keyVaultId) && !empty(keyVaultName)

resource appServiceNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: take('nsg-${namePrefix}-appsvc', 80)
  location: location
  tags: tags
  properties: {
    securityRules: []
  }
}

resource privateEndpointNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: take('nsg-${namePrefix}-pe', 80)
  location: location
  tags: tags
  properties: {
    securityRules: []
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: take('vnet-${namePrefix}', 64)
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-appservice'
        properties: {
          addressPrefix: appServiceSubnetPrefix
          networkSecurityGroup: {
            id: appServiceNsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
          delegations: [
            {
              name: 'appservice-delegation'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          networkSecurityGroup: {
            id: privateEndpointNsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

var appServiceSubnetId = '${vnet.id}/subnets/snet-appservice'
var privateEndpointSubnetId = '${vnet.id}/subnets/snet-pe'

resource blobDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (attachStorage) {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
  tags: tags
}

resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (attachStorage) {
  parent: blobDnsZone
  name: take('link-${namePrefix}-blob', 80)
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource blobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (attachStorage) {
  name: take('pe-${storageAccountName}-blob', 80)
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: take('pe-${storageAccountName}-blob-conn', 80)
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource blobDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (attachStorage) {
  parent: blobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: blobDnsZone!.id
        }
      }
    ]
  }
  dependsOn: [
    blobDnsLink
  ]
}

var kvDnsSuffix = replace(environment().suffixes.keyvaultDns, '.vault.', '.privatelink.vaultcore.')
var kvDnsZoneName = startsWith(kvDnsSuffix, '.') ? substring(kvDnsSuffix, 1) : 'privatelink.vaultcore.azure.net'

resource keyVaultDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (attachKeyVault) {
  name: kvDnsZoneName
  location: 'global'
  tags: tags
}

resource keyVaultDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (attachKeyVault) {
  parent: keyVaultDnsZone
  name: take('link-${namePrefix}-kv', 80)
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (attachKeyVault) {
  name: take('pe-${keyVaultName}-vault', 80)
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: take('pe-${keyVaultName}-vault-conn', 80)
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

resource keyVaultDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (attachKeyVault) {
  parent: keyVaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: keyVaultDnsZone!.id
        }
      }
    ]
  }
  dependsOn: [
    keyVaultDnsLink
  ]
}

resource sitesDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createSitesDnsZone) {
  name: 'privatelink.azurewebsites.net'
  location: 'global'
  tags: tags
}

resource sitesDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createSitesDnsZone) {
  parent: sitesDnsZone
  name: take('link-${namePrefix}-sites', 80)
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output appServiceSubnetId string = appServiceSubnetId
output privateEndpointSubnetId string = privateEndpointSubnetId
output sitesDnsZoneId string = createSitesDnsZone ? sitesDnsZone!.id : ''
