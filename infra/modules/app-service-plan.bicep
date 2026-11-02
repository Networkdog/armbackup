param location string
param appServicePlanName string
param tags object

resource appServicePlan 'Microsoft.Web/serverFarms@2026-08-01' = {
  name: appServicePlanName
  location: location
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
    size: 'B1'
    family: 'B'
    capacity: 1
  }
  properties: {
    reserved: true
  }
  tags: tags
}

output appServicePlanId string = appServicePlan.id
