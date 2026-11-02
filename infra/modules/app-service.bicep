param location string
param appServiceName string
param appServicePlanId string
param vnetIntegrationSubnetId string
param tenantId string
param operatorObjectId string
param authClientId string

@secure()
param authClientSecret string

param tags object

resource appService 'Microsoft.Web/sites@2026-08-01' = {
  name: appServiceName
  location: location
  kind: 'app,linux'
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlanId
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'PYTHON|3.12'
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/health'
      appCommandLine: 'PYTHONPATH=$PWD/src python -m armbackup.webui --hosted --port 8000 --live-config $PWD/hosted/console.json'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'ENABLE_ORYX_BUILD'
          value: 'true'
        }
        {
          name: 'ORYX_DISABLE_COMPRESSION'
          value: 'true'
        }
        {
          name: 'WEBSITES_CONTAINER_START_TIME_LIMIT'
          value: '1800'
        }
        {
          name: 'ARMBACKUP_OPERATOR_ID'
          value: operatorObjectId
        }
        {
          name: 'ARMBACKUP_TENANT_ID'
          value: tenantId
        }
        {
          name: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          value: authClientSecret
        }
      ]
    }
  }
}

resource scmAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2026-08-01' = {
  parent: appService
  name: 'scm'
  properties: {
    allow: false
  }
}

resource ftpAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2026-08-01' = {
  parent: appService
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource vnetConnection 'Microsoft.Web/sites/networkConfig@2026-08-01' = {
  parent: appService
  name: 'virtualNetwork'
  properties: {
    subnetResourceId: vnetIntegrationSubnetId
    swiftSupported: true
  }
}

resource authSettings 'Microsoft.Web/sites/config@2022-03-01' = {
  parent: appService
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [
        '/health'
      ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          openIdIssuer: 'https://login.microsoftonline.com/${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            'api://${authClientId}'
            authClientId
          ]
          defaultAuthorizationPolicy: {
            allowedPrincipals: {
              identities: [
                operatorObjectId
              ]
            }
          }
        }
      }
    }
    login: {
      allowedExternalRedirectUrls: [
        'https://${appService.properties.defaultHostName}'
      ]
      tokenStore: {
        enabled: true
      }
    }
  }
}

output appServiceId string = appService.id
output principalId string = appService.identity.principalId
