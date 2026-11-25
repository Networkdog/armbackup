// Ensures per-app isolated Blob container exists on an Azure Storage Account and optionally grants
// least-privilege Storage Blob Data Contributor RBAC to the App Service Managed Identity.
//
// By default (resourceScopedRbac = true), RBAC is scoped strictly to this app's container
// rather than the entire Storage Account — isolating multiple projects (e.g. azfirewallagent + armbackup)
// sharing one enterprise Storage Account.
targetScope = 'resourceGroup'

param storageAccountName string
param containerName string
param principalId string
param assignRbac bool = false
param resourceScopedRbac bool = true

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' existing = {
  parent: storage
  name: 'default'
}

resource backupsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

resource containerBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignRbac && resourceScopedRbac) {
  name: guid(backupsContainer.id, principalId, blobDataContributorRoleId)
  scope: backupsContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource accountBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignRbac && !resourceScopedRbac) {
  name: guid(storage.id, containerName, principalId, blobDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
