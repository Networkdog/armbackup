// Stores the built-in admin password in Key Vault (when password auth is selected) and optionally grants
// least-privilege Key Vault Secrets User RBAC to the App Service Managed Identity.
//
// When secretScopedRbac is true (default), RBAC is scoped strictly to the single app secret
// (<webAppName>-admin-password) rather than the entire shared Key Vault — preventing cross-project secret exposure.
targetScope = 'resourceGroup'

param keyVaultName string
param secretName string
@secure()
param adminPassword string = ''
param storeSecret bool = true
param principalId string
param assignRbac bool = false
param secretScopedRbac bool = true

var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource passwordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (storeSecret && !empty(adminPassword)) {
  parent: keyVault
  name: secretName
  properties: {
    value: adminPassword
    contentType: 'text/plain'
  }
}

resource passwordSecretRef 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: keyVault
  name: secretName
}

resource singleSecretUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignRbac && storeSecret && secretScopedRbac) {
  name: guid(keyVault.id, secretName, principalId, keyVaultSecretsUserRoleId)
  scope: passwordSecretRef
  dependsOn: [
    passwordSecret
  ]
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource vaultSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignRbac && (!secretScopedRbac || !storeSecret)) {
  name: guid(keyVault.id, principalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output vaultUri string = keyVault.properties.vaultUri
