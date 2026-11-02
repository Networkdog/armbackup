export const SUB_PROD = "11111111-1111-1111-1111-111111111111";
export const SUB_DEV = "22222222-2222-2222-2222-222222222222";

export function resourceId(subscription, group, type, name) {
  return `/subscriptions/${subscription}/resourceGroups/${group}/providers/${type}/${name}`;
}

export function createDemoState(now = new Date()) {
  const iso = (offset) => new Date(now.getTime() - offset).toISOString();
  const hour = 3_600_000;
  const kst = new Date(now.getTime() + 9 * hour);
  let latest = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 2) - 9 * hour;
  if (latest > now.getTime()) latest -= 24 * hour;
  const scopes = [
    { id: "mg-platform", kind: "managementGroup", name: "Platform", detail: "mg-platform", parentId: null },
    { id: "sub-prod", kind: "subscription", name: "Production", detail: SUB_PROD, parentId: "mg-platform", subscriptionId: SUB_PROD },
    { id: "rg-network", kind: "resourceGroup", name: "rg-prod-network", detail: "Korea Central", parentId: "sub-prod" },
    { id: "rg-app", kind: "resourceGroup", name: "rg-prod-app", detail: "Korea Central", parentId: "sub-prod" },
    { id: "sub-dev", kind: "subscription", name: "Development", detail: SUB_DEV, parentId: "mg-platform", subscriptionId: SUB_DEV },
    { id: "rg-dev", kind: "resourceGroup", name: "rg-dev-app", detail: "Korea Central", parentId: "sub-dev" },
  ];
  const definitions = [
    ["rg-network", "vnet-prod-hub", "Microsoft.Network/virtualNetworks", "Virtual network", { addressSpace: { addressPrefixes: ["10.20.0.0/16"] } }],
    ["rg-network", "nsg-prod-web", "Microsoft.Network/networkSecurityGroups", "Network security group", {
      securityRules: [{ name: "allow-https", properties: { access: "Allow", direction: "Inbound", priority: 100, protocol: "Tcp", sourceAddressPrefix: "10.20.0.0/16", destinationPortRange: "443" } }],
    }],
    ["rg-network", "rt-prod-egress", "Microsoft.Network/routeTables", "Route table", {
      routes: [{ name: "default-route", properties: { addressPrefix: "0.0.0.0/0", nextHopType: "VirtualAppliance", nextHopIpAddress: "10.20.1.4" } }],
    }],
    ["rg-network", "pip-prod-legacy", "Microsoft.Network/publicIPAddresses", "Public IP address", { publicIPAllocationMethod: "Static" }],
    ["rg-network", "dns-prod-internal", "Microsoft.Network/privateDnsZones", "Private DNS zone", { numberOfRecordSets: 8 }],
    ["rg-app", "app-prod-api", "Microsoft.Web/sites", "App Service", { httpsOnly: true, siteConfig: { alwaysOn: true, minTlsVersion: "1.2" } }],
    ["rg-app", "stprodconfig01", "Microsoft.Storage/storageAccounts", "Storage account", { minimumTlsVersion: "TLS1_2", publicNetworkAccess: "Disabled", allowBlobPublicAccess: false }],
    ["rg-app", "sql-prod-primary", "Microsoft.Sql/servers", "SQL server", { version: "12.0", publicNetworkAccess: "Disabled" }],
    ["rg-app", "kv-prod-platform", "Microsoft.KeyVault/vaults", "Key vault", { enablePurgeProtection: true, enableSoftDelete: true }],
    ["rg-dev", "nsg-dev-app", "Microsoft.Network/networkSecurityGroups", "Network security group", { securityRules: [] }],
    ["rg-dev", "app-dev-portal", "Microsoft.Web/sites", "App Service", { httpsOnly: true, siteConfig: { alwaysOn: true, minTlsVersion: "1.2" } }],
    ["rg-dev", "stdevconfig01", "Microsoft.Storage/storageAccounts", "Storage account", { minimumTlsVersion: "TLS1_2", publicNetworkAccess: "Disabled" }],
  ];
  const resources = definitions.map(([groupId, name, type, typeLabel]) => {
    const group = scopes.find((scope) => scope.id === groupId);
    const subscription = scopes.find((scope) => scope.id === group.parentId);
    return {
      id: resourceId(subscription.subscriptionId, group.name, type, name),
      name, type, typeLabel, groupId, location: "koreacentral", apiVersion: "2024-01-01",
    };
  });
  const base = definitions.map((definition, index) => ({
    id: resources[index].id, name: resources[index].name, type: resources[index].type,
    location: "koreacentral",
    tags: { environment: resources[index].groupId === "rg-dev" ? "dev" : "prod", owner: "platform" },
    properties: structuredClone(definition[4]),
  }));
  const runs = [0, 1, 2].map((day) => {
    const capturedAt = new Date(latest - day * 24 * hour).toISOString();
    return {
      id: `demo-daily-${capturedAt.slice(0, 10)}`, kind: "scheduled", capturedAt,
      status: "Captured", absences: [],
      snapshots: resources.map((resource, index) => ({
        resourceId: resource.id, apiVersion: resource.apiVersion, complete: true,
        capturedAt, raw: structuredClone(base[index]),
      })),
    };
  });
  const current = Object.fromEntries(resources.map((resource, index) => [
    resource.id.toLowerCase(), {
      status: "present", observedAt: iso(5 * 60_000), apiVersion: resource.apiVersion,
      raw: structuredClone(base[index]), actor: null,
    },
  ]));
  const at = (index) => current[resources[index].id.toLowerCase()];
  at(1).raw.properties.securityRules[0].properties.sourceAddressPrefix = "*";
  at(1).raw.properties.securityRules[0].properties.destinationPortRange = "*";
  at(1).actor = { caller: "Network Ops · 예시", at: iso(45 * 60_000), source: "Activity Log 예시" };
  at(2).raw.properties.routes[0].properties.nextHopIpAddress = "10.20.1.5";
  at(2).actor = { caller: "배포 파이프라인 · 예시", at: iso(70 * 60_000), source: "Activity Log 예시" };
  Object.assign(at(3), { status: "missing", raw: null, confirmed: true, actor: { caller: "Platform Ops · 예시", at: iso(2 * hour), source: "Activity Log 예시" } });
  at(5).raw.tags.owner = "application";
  at(5).actor = { caller: "App Ops · 예시", at: iso(30 * 60_000), source: "Activity Log 예시" };
  Object.assign(at(7), { status: "error", raw: null, code: "AuthorizationFailed", actor: null });
  at(10).raw.properties.siteConfig.alwaysOn = false;
  at(10).actor = { caller: "배포 파이프라인 · 예시", at: iso(90 * 60_000), source: "Activity Log 예시" };
  const extra = {
    id: resourceId(SUB_PROD, "rg-prod-app", "Microsoft.Insights/components", "appi-prod-api"),
    name: "appi-prod-api", type: "Microsoft.Insights/components", typeLabel: "Application Insights",
    groupId: "rg-app", location: "koreacentral", apiVersion: "2020-02-02",
  };
  resources.push(extra);
  current[extra.id.toLowerCase()] = {
    status: "present", observedAt: iso(5 * 60_000), apiVersion: extra.apiVersion,
    raw: { id: extra.id, name: extra.name, type: extra.type, location: extra.location, tags: { environment: "prod", owner: "platform" }, properties: { Application_Type: "web" } },
    actor: { caller: "배포 파이프라인 · 예시", at: iso(3 * hour), source: "Activity Log 예시" },
  };
  const logs = [
    { level: "Warning", event: "comparison_unconfirmed", resourceId: resources[7].id, message: "현재 형상 조회 권한이 없습니다. 형상 차이로 판정하지 않았습니다.", time: iso(5 * 60_000) },
    { level: "Information", event: "comparison_completed", resourceId: "", message: "백업 12개 자원의 예시 비교를 마쳤습니다. 1개는 미확인입니다.", time: iso(5 * 60_000 + 1000) },
    { level: "Information", event: "backup_completed", resourceId: "", message: "12개 리소스의 형상 백업을 보관했습니다. (예시)", time: runs[0].capturedAt },
    { level: "Information", event: "backup_started", resourceId: "", message: "일일 형상 백업을 시작했습니다. (예시)", time: new Date(latest - 65_000).toISOString() },
    { level: "Error", event: "log_query_failed", resourceId: "", message: "이전 예시 조회가 시간 초과로 중단됐습니다. 실제 Workspace 오류가 아닙니다.", time: iso(28 * hour) },
    { level: "Information", event: "backup_completed", resourceId: "", message: "전날 12개 리소스의 백업을 보관했습니다. (예시)", time: runs[1].capturedAt },
  ].map((entry, index) => ({
    ...entry, id: `demo-log-${index}`, runId: runs[0].id,
    correlationId: `demo-correlation-${index}`, source: "ArmBackup_CL · 예시",
  }));
  return {
    schemaVersion: 1, revision: 0, initializedAt: now.toISOString(), scopes, resources, runs, current, logs,
    policy: { scopeIds: ["mg-platform"], types: [...new Set(resources.map((resource) => resource.type))], tags: [] },
  };
}
