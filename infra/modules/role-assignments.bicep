targetScope = 'subscription'

param appPrincipalId string

var readerRoleDefinitionId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource subscriptionReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, appPrincipalId, readerRoleDefinitionId)
  scope: subscription()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleDefinitionId)
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}
