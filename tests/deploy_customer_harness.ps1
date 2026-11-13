# Runs scripts/deploy-customer.ps1 against a fake `az` that enforces a simulated KT policy
# "[KT] App Service apps should disable or restrict public network access":
#   DENY a PUT/PATCH of Microsoft.Web/sites when publicNetworkAccess is not Disabled and the request
#   has no properties.siteConfig.ipSecurityRestrictionsDefaultAction.
# A real site GET returns that default action as null (it lives in config/web), so commands that read the
# site and write it back (az webapp identity assign, az webapp update) are denied as well.
# Prints one RESULT_JSON line for tests/test_deploy_customer_script.py.
param(
  [Parameter(Mandatory)][string]$Script,
  [Parameter(Mandatory)][ValidateSet('new', 'converged', 'drifted', 'userassigned')][string]$Scenario
)
$ErrorActionPreference = 'Stop'
$subnetBase = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets'
$integrationSubnet = "$subnetBase/integration"
$endpointSubnet = "$subnetBase/endpoint"
$userIdentity = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami'
$principal = '11111111-2222-3333-4444-555555555555'
$state = @{ Site = $null; Writes = @(); Calls = @() }

switch ($Scenario) {
  'converged' {
    $state.Site = @{ https = $true; pna = 'Enabled'; vnet = $integrationSubnet
      identity = @{ type = 'SystemAssigned'; principalId = $principal } }
  }
  'drifted' { $state.Site = @{ https = $false; pna = $null; vnet = $null; identity = $null } }
  'userassigned' {
    $state.Site = @{ https = $true; pna = 'Enabled'; vnet = $integrationSubnet
      identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ $userIdentity = @{ principalId = 'a'; clientId = 'b' } } } }
  }
}

function Get-Option($arguments, $name) {
  $index = [array]::IndexOf($arguments, $name)
  if ($index -ge 0 -and ($index + 1) -lt $arguments.Count) { $arguments[$index + 1] }
}
function Get-SiteRepresentation {
  $site = $state.Site
  $representation = [ordered]@{ properties = [ordered]@{
      httpsOnly = $site.https; publicNetworkAccess = $site.pna; virtualNetworkSubnetId = $site.vnet
      siteConfig = [ordered]@{ ipSecurityRestrictionsDefaultAction = $null } } }
  if ($site.identity) { $representation.identity = $site.identity }
  $representation
}
function Write-Site($method, $body) {
  # Returns $true when the policy lets the write through.
  $default = $body.properties.siteConfig.ipSecurityRestrictionsDefaultAction
  $denied = $body.properties.publicNetworkAccess -ne 'Disabled' -and -not $default
  $state.Writes += [pscustomobject]@{
    method = $method; denied = $denied; defaultAction = $default; identityType = $body.identity.type
    userIdentities = @($body.identity.userAssignedIdentities.PSObject.Properties.Name)
    publicNetworkAccess = $body.properties.publicNetworkAccess }
  if ($denied) {
    [Console]::Error.WriteLine('ERROR: (RequestDisallowedByPolicy) Resource app-test was disallowed by policy.')
    $global:LASTEXITCODE = 1
  }
  -not $denied
}

function az {
  $a = [string[]]$args
  $global:LASTEXITCODE = 0
  $head = ($a | Select-Object -First 3) -join ' '
  $state.Calls += $head
  $site = $state.Site

  if ($a[0] -eq 'account') { return }
  if ($head -eq 'group show --name') { 'rg'; return }
  if ($head -eq 'resource show --ids') { '{"location":"koreacentral","linux":true,"sku":"B1"}'; return }
  if ($head -eq 'network vnet subnet') {
    if ((Get-Option $a '--ids') -ieq $integrationSubnet) { '{"delegations":["Microsoft.Web/serverFarms"]}' } else { '{"delegations":[]}' }
    return
  }
  if ($head -eq 'network vnet show') { 'koreacentral'; return }

  if ($head -eq 'webapp identity assign' -or $head -eq 'webapp update --resource-group') {
    # The CLI reads the site and PUTs the model back without the default action.
    [void](Write-Site 'PUT' ([pscustomobject]@{ properties = [pscustomobject]@{ publicNetworkAccess = $site.pna } }))
    return
  }
  if ($a[0] -eq 'webapp' -and $a[1] -eq 'show') {
    if (-not $site) { $global:LASTEXITCODE = 3; return }
    switch (Get-Option $a '--query') {
      'name' { 'app-test' }
      'defaultHostName' { 'app-test.azurewebsites.net' }
      'identity.principalId' { $site.identity.principalId }
    }
    return
  }
  if ($a[0] -eq 'network') {
    if (($a | Select-Object -First 5) -contains 'show') { $global:LASTEXITCODE = 3 }
    return
  }
  if ($a[0] -ne 'rest') { return }

  $method = (Get-Option $a '--method').ToUpper()
  $path = ((Get-Option $a '--url') -replace '^https://management\.azure\.com', '') -replace '\?.*$', ''
  $bodyFile = Get-Option $a '--body'
  $body = if ($bodyFile) { Get-Content -Raw -LiteralPath $bodyFile.Substring(1) | ConvertFrom-Json }
  if ($path -match '/Microsoft\.Web/sites/[^/]+$') {
    if ($method -eq 'GET') { Get-SiteRepresentation | ConvertTo-Json -Depth 10; return }
    if (-not (Write-Site $method $body)) { return }
    if ($method -eq 'PUT') {
      $state.Site = @{ https = $body.properties.httpsOnly; pna = $body.properties.publicNetworkAccess
        vnet = $body.properties.virtualNetworkSubnetId; identity = @{ type = 'SystemAssigned'; principalId = $principal } }
    } else {
      $site.https = $body.properties.httpsOnly
      $site.pna = $body.properties.publicNetworkAccess
      $site.vnet = $body.properties.virtualNetworkSubnetId
      if ($body.identity) { $site.identity = @{ type = $body.identity.type; principalId = $principal } }
    }
  } elseif ($path -match '/config/web$' -and $method -eq 'GET') {
    '{"properties":{"ipSecurityRestrictions":[],"scmIpSecurityRestrictionsUseMain":false,"scmIpSecurityRestrictionsDefaultAction":"Deny","ipSecurityRestrictionsDefaultAction":"Deny"}}'
  }
}

$parameters = @{
  SubscriptionId = 'sub'; ResourceGroup = 'rg'; AppName = 'app-test'
  AppServicePlanId = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/serverfarms/plan'
  VnetSubnetId = $integrationSubnet; PrivateEndpointSubnetId = $endpointSubnet
  SkipRoles = $true; SkipCode = $true; SkipVerify = $true }
$result = 'OK'
try { & $Script @parameters *> $null } catch { $result = $_.Exception.Message }
$outcome = @{ result = $result; writes = @($state.Writes); calls = @($state.Calls) }
"RESULT_JSON:" + ($outcome | ConvertTo-Json -Depth 6 -Compress)
