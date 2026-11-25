<#
.SYNOPSIS
  Bootstraps Azure OIDC authentication and GitHub Actions variables for automatic deployment to your developer Azure subscription.

.DESCRIPTION
  Configures passwordless GitHub Actions OIDC (no client secrets) so pushing to `main` can deploy Configuration Vault (armbackup)
  to your Azure App Service in your development subscription:
    1. Ensures the target Resource Group exists.
    2. Creates/reuses User-Assigned Managed Identity `id-<WebAppName>-github` with a Federated Identity Credential
       trusting `repo:<GitHubRepo>:ref:refs/heads/<Branch>`.
    3. Grants Contributor + User Access Administrator on the app Resource Group plus Reader on the subscription.
    4. Prints `gh variable set` commands — or sets them directly on your GitHub repository when `-ApplyGitHubVariables` is passed.

.EXAMPLE
  .\infra\appservice\Setup-GitHubActions.ps1 `
    -WebAppName app-armbackup-dev-001 `
    -ResourceGroup rg-armbackup-dev `
    -Location koreacentral `
    -GitHubRepository Networkdog/armbackup `
    -ApplyGitHubVariables
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{1,54}[a-zA-Z0-9]$')][string]$WebAppName,
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$Location,
  [Parameter(Mandatory)][ValidatePattern('^[^/\s]+/[^/\s]+$')][string]$GitHubRepository,
  [string]$Branch = 'main',
  [string]$AppServicePlanSku = 'P0v3',
  [string]$SubscriptionId,
  [string]$OidcSubjectPrefix,
  [switch]$ApplyGitHubVariables
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI (az) is required.'
}
if ($SubscriptionId) {
  & az account set --subscription $SubscriptionId
  if ($LASTEXITCODE -ne 0) { throw "Failed to select subscription $SubscriptionId" }
}
$account = (& az account show -o json) | ConvertFrom-Json
if (-not $account) { throw "Run 'az login' first." }
$subId = $account.id
$tenantId = $account.tenantId

$subject = if ($OidcSubjectPrefix) { "$OidcSubjectPrefix:ref:refs/heads/$Branch" } else { "repo:${GitHubRepository}:ref:refs/heads/$Branch" }
$identityName = "id-$WebAppName-github"

Write-Host "==> Ensuring Resource Group '$ResourceGroup' in $Location..." -ForegroundColor Cyan
& az group create --name $ResourceGroup --location $Location -o none

Write-Host "==> Creating/updating Managed Identity '$identityName'..." -ForegroundColor Cyan
$uami = (& az identity create --name $identityName --resource-group $ResourceGroup --location $Location -o json) | ConvertFrom-Json

Write-Host "==> Configuring GitHub OIDC Federated Credential ($subject)..." -ForegroundColor Cyan
& az identity federated-credential create `
  --name 'github-main' `
  --identity-name $identityName `
  --resource-group $ResourceGroup `
  --issuer 'https://token.actions.githubusercontent.com' `
  --subject $subject `
  --audiences 'api://AzureADTokenExchange' -o none 2>$null

$rgScope = "/subscriptions/$subId/resourceGroups/$ResourceGroup"
foreach ($role in @('Contributor', 'User Access Administrator')) {
  & az role assignment create --assignee-object-id $uami.principalId --assignee-principal-type ServicePrincipal --role $role --scope $rgScope -o none 2>$null
}
& az role assignment create --assignee-object-id $uami.principalId --assignee-principal-type ServicePrincipal --role 'Reader' --scope "/subscriptions/$subId" -o none 2>$null

$vars = [ordered]@{
  AZURE_CLIENT_ID       = $uami.clientId
  AZURE_TENANT_ID       = $tenantId
  AZURE_SUBSCRIPTION_ID = $subId
  AZURE_RESOURCE_GROUP  = $ResourceGroup
  AZURE_LOCATION        = $Location
  AZURE_WEBAPP_NAME     = $WebAppName
  AZURE_PLAN_SKU        = $AppServicePlanSku
}

Write-Host "`nGitHub Repository Variables:" -ForegroundColor Green
foreach ($k in $vars.Keys) {
  Write-Host "  gh variable set $k --body '$($vars[$k])' --repo $GitHubRepository"
  if ($ApplyGitHubVariables -and (Get-Command gh -ErrorAction SilentlyContinue)) {
    & gh variable set $k --body $vars[$k] --repo $GitHubRepository
  }
}
