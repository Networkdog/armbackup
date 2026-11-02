param location string
param virtualNetworkName string
param tags object

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2026-07-01' = {
  name: virtualNetworkName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.86.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'appservice'
        properties: {
          addressPrefix: '10.86.0.0/24'
          delegations: [
            {
              name: 'appservice'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.86.1.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

output virtualNetworkId string = virtualNetwork.id
output appServiceSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', virtualNetworkName, 'appservice')
output privateEndpointSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', virtualNetworkName, 'private-endpoints')
