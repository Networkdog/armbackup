targetScope = 'subscription'

@minLength(1)
@maxLength(64)
param environmentName string

@minLength(1)
param location string

param sessionId string
param deployedBy string
param createdAt string
param deployerObjectId string

@allowed(['entra', 'password'])
param authMode string = 'entra'
param authClientId string = ''

@secure()
param authClientSecret string = ''
param localAuthUsername string = ''

@secure()
param localAuthPasswordHash string = ''

var tags = {
  'app-onboard-skill': 'true'
  'app-onboard-session-id': sessionId
  'created-at': createdAt
  environment: environmentName
  'deployed-by': deployedBy
}

var resourceGroupName = 'rg-armbackup-dev-f4bc'
var appServiceName = 'app-armbackup-dev-f4bc'
var appServicePlanName = 'asp-armbackup-dev-f4bc'
var virtualNetworkName = 'vnet-armbackup-dev-f4bc'
var privateEndpointName = 'pe-armbackup-dev-f4bc'
var labResourceGroupName = 'rg-armbackup-msp-lab-20261031'
var storageAccountName = 'abmspec8a15ac641d5b7db'
var workspaceName = 'law-armbackup-msp-lab'
var dcrName = 'dcr-armbackup-msp-lab'
var operatorObjectId = 'af5c22a6-47b2-4ab5-add4-df042063208d'
var tenantId = 'f5dba041-0afe-4136-b859-9450eba31ec1'

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module network './modules/network.bicep' = {
  name: 'network'
  scope: rg
  params: {
    location: location
    virtualNetworkName: virtualNetworkName
    tags: tags
  }
}

module privateDns './modules/private-dns.bicep' = {
  name: 'private-dns'
  scope: rg
  params: {
    virtualNetworkId: network.outputs.virtualNetworkId
    virtualNetworkName: virtualNetworkName
    tags: tags
  }
}

module appServicePlan './modules/app-service-plan.bicep' = {
  name: 'app-service-plan'
  scope: rg
  params: {
    location: location
    appServicePlanName: appServicePlanName
    tags: tags
  }
}

module appService './modules/app-service.bicep' = {
  name: 'app-service'
  scope: rg
  params: {
    location: location
    appServiceName: appServiceName
    appServicePlanId: appServicePlan.outputs.appServicePlanId
    vnetIntegrationSubnetId: network.outputs.appServiceSubnetId
    tenantId: tenantId
    operatorObjectId: operatorObjectId
    authMode: authMode
    authClientId: authClientId
    authClientSecret: authClientSecret
    localAuthUsername: localAuthUsername
    localAuthPasswordHash: localAuthPasswordHash
    tags: tags
  }
}

module privateEndpoint './modules/private-endpoint.bicep' = {
  name: 'private-endpoint'
  scope: rg
  params: {
    location: location
    privateEndpointName: privateEndpointName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: privateDns.outputs.privateDnsZoneId
    storageAccountName: storageAccountName
    storageResourceGroupName: labResourceGroupName
    tags: tags
  }
}

module roleAssignments './modules/role-assignments.bicep' = {
  name: 'role-assignments'
  scope: subscription()
  params: {
    appPrincipalId: appService.outputs.principalId
  }
}

module labRoleAssignments './modules/lab-role-assignments.bicep' = {
  name: 'lab-role-assignments'
  scope: resourceGroup(labResourceGroupName)
  params: {
    appPrincipalId: appService.outputs.principalId
    storageAccountName: storageAccountName
    workspaceName: workspaceName
    dcrName: dcrName
  }
}
