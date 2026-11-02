param location string
param privateEndpointName string
param privateEndpointSubnetId string
param privateDnsZoneId string
param storageAccountName string
param storageResourceGroupName string
param tags object

resource storageAccount 'Microsoft.Storage/storageAccounts@2026-09-01' existing = {
  name: storageAccountName
  scope: resourceGroup(storageResourceGroupName)
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2026-07-01' = {
  name: privateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: [
            'blob'
          ]
          requestMessage: 'Private Blob access for the armbackup App Service'
        }
      }
    ]
  }
}

resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2026-07-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}
