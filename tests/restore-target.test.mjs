import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backupItems, filterBackupItems, restoreItem, restoreTargetHtml } from "../src/armbackup/ui_static/restore-target.mjs";
import {
  buildNetworkHierarchyNodes,
  buildPickerNodes,
  buildTargetHierarchyNodes,
  filterPickerItems,
  openManagementGroupPicker,
  openNetworkBindingPicker,
  openPolicyScopePicker,
  openSubscriptionPicker,
  openTargetLocationPicker,
  pickerTriggerHtml,
  resourceHierarchy,
  resourcePickerModalHtml,
  targetLocationListHtml,
} from "../src/armbackup/ui_static/resource-picker.mjs";

const scopes = [
  { id: "mg-corp", kind: "managementGroup", name: "Corp", parentId: null },
  { id: "sub-prod", kind: "subscription", name: "Prod Subscription", subscriptionId: "11111111-1111-1111-1111-111111111111", parentId: "mg-corp" },
  { id: "rg-net", kind: "resourceGroup", name: "rg-network", parentId: "sub-prod" },
  { id: "rg-app", kind: "resourceGroup", name: "rg-application", parentId: "sub-prod" },
];
const resource = (id, name, groupId = "rg-net", tags = {}) => ({ id, name, groupId, type: "t", typeLabel: "NSG", tags });
const snapshot = (resourceId, capturedAt) => ({ resourceId, capturedAt });
const state = {
  scopes,
  resources: [
    resource("/b", "beta", "rg-app", { customer: "contoso" }),
    resource("/a", "alpha", "rg-net"),
    resource("/c", "gamma", "rg-net"),
  ],
  runs: [
    { id: "r1", status: "Captured", capturedAt: "2026-11-01T00:00:00Z", snapshots: [snapshot("/A", "2026-11-01T00:00:00Z"), snapshot("/b", "2026-11-01T00:00:00Z")] },
    { id: "r2", status: "Captured", capturedAt: "2026-11-02T00:00:00Z", snapshots: [snapshot("/a", "2026-11-02T00:00:00Z")] },
    { id: "r3", status: "Failed", capturedAt: "2026-11-03T00:00:00Z", snapshots: [snapshot("/c", "2026-11-03T00:00:00Z")] },
  ],
  current: { "/a": { status: "present" } },
};
const helpers = { esc: (v) => String(v), icon: () => "", relativeTime: (v) => `rel(${v})`, symbol: () => "" };

test("backup items list only resources with a verified backup, sorted by name, with counts", () => {
  const items = backupItems(state);
  assert.deepEqual(items.map((item) => [item.resource.name, item.count]), [["alpha", 2], ["beta", 1]]);
  assert.equal(items[0].latestAt, "2026-11-02T00:00:00Z");
});

test("item search matches name, id, type, customer tag and hierarchy scope", () => {
  const items = backupItems(state);
  assert.deepEqual(filterBackupItems(items, "CONTOSO").map((item) => item.resource.name), ["beta"]);
  assert.deepEqual(filterBackupItems(items, "rg-network", state).map((item) => item.resource.name), ["alpha"]);
  assert.equal(filterBackupItems(items, "").length, 2);
  assert.equal(filterBackupItems(items, "nothing").length, 0);
});

test("compact target bar displays management group, subscription, resource group and resource without raw resource ID block", () => {
  assert.equal(restoreItem(state, "/A").resource.name, "alpha");
  assert.equal(restoreItem(state, "/missing"), null);
  const unselected = restoreTargetHtml(state, "", helpers);
  assert.match(unselected, /선택된 리소스가 없습니다/);
  assert.match(unselected, /data-action="open-resource-picker"/);
  assert.match(unselected, /항목 변경/);
  const card = restoreTargetHtml(state, "/a", helpers);
  assert.match(card, /관리 그룹.*Corp/);
  assert.match(card, /구독.*Prod Subscription/);
  assert.match(card, /리소스 그룹.*rg-network/);
  assert.match(card, /리소스.*alpha/);
  assert.match(card, /백업<\/dt><dd>2회/);
  assert.match(card, /현재<\/dt><dd>있음/);
  assert.match(card, /data-action="open-resource-picker"/);
  assert.doesNotMatch(card, /<code class="resource-id">/);
  assert.equal(restoreTargetHtml(state, "/missing", helpers), unselected);
});

test("reusable resource picker modal browses management group, subscription and resource group hierarchy and filters items", () => {
  const items = backupItems(state);
  const hierarchy = resourceHierarchy(state, items[0].resource);
  assert.equal(hierarchy.managementGroup, "Corp");
  assert.equal(hierarchy.subscription, "Prod Subscription");
  assert.equal(hierarchy.resourceGroup, "rg-network");
  const nodes = buildPickerNodes(state, items);
  assert.deepEqual(nodes.map((n) => [n.kind, n.label, n.count]), [
    ["managementGroup", "Corp", 2],
    ["subscription", "Prod Subscription", 2],
    ["resourceGroup", "rg-network", 1],
    ["resourceGroup", "rg-application", 1],
  ]);
  assert.deepEqual(filterPickerItems(state, items, { scopeKey: "rg-app" }).map((i) => i.resource.name), ["beta"]);
  assert.deepEqual(filterPickerItems(state, items, { scopeKey: "mg-corp", query: "alpha" }).map((i) => i.resource.name), ["alpha"]);
  const cyclicState = {
    ...state,
    scopes: [
      ...scopes,
      { id: "sub-prod", kind: "subscription", name: "Dup Cycle", parentId: "rg-net" },
    ],
  };
  assert.equal(buildPickerNodes(cyclicState, items).length, 4);
  const modal = resourcePickerModalHtml({ state, items, selectedId: "/a", scopeKey: "rg-net", query: "" }, helpers);
  assert.match(modal, /role="tree"/);
  assert.match(modal, /data-picker-select="\/a"/);
  assert.match(modal, /선택됨/);
  assert.doesNotMatch(modal, /data-picker-select="\/b"/);
});

test("restore page keeps target header, backup calendar and bottom plan section on one page in both apps", () => {
  for (const file of ["live-app.mjs", "app.mjs"]) {
    const source = readFileSync(new URL(`../src/armbackup/ui_static/${file}`, import.meta.url), "utf8");
    const render = source.slice(source.indexOf("function renderRestore()"));
    assert.ok(render.indexOf("restoreTargetPanel()") < render.indexOf("renderRestoreCalendar("), file);
    assert.match(source, /id="restore-plan-section"/);
    assert.match(source, /openResourcePicker\(/);
    assert.match(source, /openPolicyScopePicker\(/);
    assert.match(source, /fixedItem: true/);
  }
});

function createFakeDialog() {
  const listeners = new Map();
  let titleText = "";
  let bodyHtml = "";
  let actionsHtml = "";
  const dialog = {
    open: false,
    dataset: {},
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    emit(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
    querySelector(sel) {
      if (sel === "#dialog-actions") {
        return {
          get innerHTML() { return actionsHtml; },
          set innerHTML(v) { actionsHtml = v; },
        };
      }
      if (sel === "#resource-picker-results") {
        return {
          scrollTop: 0,
          get innerHTML() { return bodyHtml; },
          set innerHTML(v) { bodyHtml = v; },
        };
      }
      return { focus() {}, value: "", textContent: "", innerHTML: "", scrollTop: 0 };
    },
    querySelectorAll() { return []; },
    get title() { return titleText; },
    get body() { return bodyHtml; },
    get actions() { return actionsHtml; },
  };
  const openDialog = (title, body, actions) => {
    titleText = title;
    bodyHtml = body;
    actionsHtml = actions;
    dialog.open = true;
  };
  const closeDialog = () => {
    dialog.open = false;
    dialog.emit("close");
  };
  return { dialog, openDialog, closeDialog };
}

test("resource picker supports type filter chips and multi-select locking for companion resources", () => {
  const mixedItems = [
    { resource: { id: "/r/agw", name: "agw-main", groupId: "rg-app", type: "microsoft.network/applicationgateways", typeLabel: "Application Gateway" } },
    { resource: { id: "/r/lb", name: "lb-int", groupId: "rg-net", type: "microsoft.network/loadbalancers", typeLabel: "Load Balancer" } },
    { resource: { id: "/r/pip", name: "pip-agw", groupId: "rg-app", type: "microsoft.network/publicipaddresses", typeLabel: "Public IP" } },
  ];
  assert.deepEqual(
    filterPickerItems(state, mixedItems, { typeFilter: "microsoft.network/loadbalancers" }).map((i) => i.resource.name),
    ["lb-int"],
  );
  const multiHtml = resourcePickerModalHtml({
    state,
    items: mixedItems,
    multiple: true,
    selectedIds: ["/r/agw"],
    disabledInfo: (_entry, res) => (res.id === "/r/pip" ? { disabled: true, checked: true, badge: "연관 자동 포함", reason: "자동 동반 포함" } : null),
  }, helpers);
  assert.match(multiHtml, /data-picker-type="microsoft\.network\/applicationgateways"/);
  assert.match(multiHtml, /data-picker-check="\/r\/agw"/);
  assert.match(multiHtml, /연관 자동 포함/);
  const trigger = pickerTriggerHtml({
    label: "대상 위치",
    segments: [{ kind: "구독", value: "Prod Subscription", icon: "cloud" }, { kind: "리소스 그룹", value: "rg-network", icon: "folder" }],
    buttonLabel: "대상 위치 선택",
    actionAttr: 'data-bundle="pick-target"',
  }, helpers);
  assert.match(trigger, /Prod Subscription/);
  assert.match(trigger, /rg-network/);
  assert.match(trigger, /data-bundle="pick-target"/);
});

test("unified modal pickers cover target RG/subscription/MG, VNet/subnet CIDR binding, and tri-state policy scopes", async () => {
  const hierarchyState = {
    scopes: [
      { id: "mg-root", kind: "managementGroup", name: "Tenant Root", parentId: null },
      { id: "mg-platform", kind: "managementGroup", name: "Platform MG", parentId: "mg-root" },
      { id: "/subscriptions/sub-1", kind: "subscription", name: "운영 구독", detail: "sub-1", parentId: "mg-platform" },
      { id: "/subscriptions/sub-2", kind: "subscription", name: "재해복구 구독", detail: "sub-2", parentId: "mg-platform" },
      { id: "/subscriptions/sub-1/resourceGroups/rg-prod", kind: "resourceGroup", name: "rg-prod", parentId: "/subscriptions/sub-1" },
    ],
  };
  const subs = [
    { subscriptionId: "sub-1", name: "운영 구독" },
    { subscriptionId: "sub-2", name: "재해복구 구독" },
  ];
  const targetNodes = buildTargetHierarchyNodes(hierarchyState, subs, { "sub-1": [{ name: "rg-prod", location: "koreacentral" }] });
  assert.deepEqual(targetNodes.map((n) => [n.kind, n.label]), [
    ["managementGroup", "Tenant Root"],
    ["managementGroup", "Platform MG"],
    ["subscription", "운영 구독"],
    ["subscription", "재해복구 구독"],
  ]);
  const rgCards = targetLocationListHtml({
    state: hierarchyState,
    subscriptions: subs,
    currentSubscription: "sub-1",
    groupsBySub: { "sub-1": [{ name: "rg-prod", location: "koreacentral" }] },
    keepSameOption: { subscriptionId: "sub-1", subscriptionName: "운영 구독", resourceGroup: "rg-prod", location: "koreacentral" },
  }, helpers);
  assert.match(rgCards, /data-target-keep-same="true"/);
  assert.match(rgCards, /Tenant Root › Platform MG › 운영 구독/);

  // Target location modal selection with region override
  const tModal = createFakeDialog();
  let chosenTarget = null;
  openTargetLocationPicker({
    dialogElement: tModal.dialog,
    openDialog: tModal.openDialog,
    closeDialog: tModal.closeDialog,
    state: hierarchyState,
    subscriptions: subs,
    currentSubscription: "sub-1",
    groupsBySub: { "sub-1": [{ name: "rg-prod", location: "koreacentral" }] },
    locations: ["koreacentral", "koreasouth"],
    helpers,
    onSelect: (res) => { chosenTarget = res; },
  });
  assert.equal(tModal.dialog.open, true);
  assert.match(tModal.dialog.body, /data-target-loc="koreasouth"/);
  tModal.dialog.emit("click", { target: { closest: (sel) => (sel === "[data-target-loc]" ? { dataset: { targetLoc: "koreasouth" } } : null) } });
  tModal.dialog.emit("click", { target: { closest: (sel) => (sel === "[data-target-rg]" ? { dataset: { targetRg: "rg-prod", targetSub: "sub-1" } } : null) } });
  assert.deepEqual(chosenTarget, { subscriptionId: "sub-1", resourceGroup: "rg-prod", location: "koreasouth" });
  assert.equal(tModal.dialog.open, false);

  // Network binding modal with RG > VNet > Subnet and CIDR pill
  const vnets = [{
    id: "/subscriptions/sub-1/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet-hub",
    name: "vnet-hub",
    resourceGroup: "rg-net",
    location: "koreacentral",
    subnets: [{ id: "/subscriptions/sub-1/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet-hub/subnets/snet-appgw", name: "snet-appgw", addressPrefixes: ["10.20.1.0/24"] }],
  }];
  assert.deepEqual(buildNetworkHierarchyNodes(vnets, "subnet").map((n) => [n.kind, n.label]), [
    ["resourceGroup", "rg-net"],
    ["virtualNetwork", "vnet-hub"],
  ]);
  const nModal = createFakeDialog();
  let chosenSubnet = null;
  openNetworkBindingPicker({
    dialogElement: nModal.dialog,
    openDialog: nModal.openDialog,
    closeDialog: nModal.closeDialog,
    mode: "subnet",
    vnets,
    subscriptionLabel: "운영 구독",
    allowKeepSource: true,
    sourceLabel: "vnet-old / snet-old",
    helpers,
    onSelect: (id) => { chosenSubnet = id; },
  });
  assert.match(nModal.dialog.body, /10\.20\.1\.0\/24/);
  assert.match(nModal.dialog.body, /원본 네트워크 그대로 공유/);
  nModal.dialog.emit("click", {
    target: {
      closest: (sel) => (sel === "[data-net-select]"
        ? { dataset: { netSelect: vnets[0].subnets[0].id } }
        : null),
    },
  });
  assert.equal(chosenSubnet, vnets[0].subnets[0].id);

  // Policy scope multi-select modal + standalone Subscription / Management Group pickers
  const pModal = createFakeDialog();
  let appliedDraft = null;
  openPolicyScopePicker({
    dialogElement: pModal.dialog,
    openDialog: pModal.openDialog,
    closeDialog: pModal.closeDialog,
    initialDraft: { ids: ["mg-platform"] },
    getNodes: (d) => hierarchyState.scopes.map((s) => ({ ...s, checked: d.ids.includes(s.id), indeterminate: false, resourceCount: 3 })),
    toggleNode: (d, id, checked) => ({ ids: checked ? [...d.ids, id] : d.ids.filter((x) => x !== id) }),
    countMatchedResources: (d) => d.ids.length * 3,
    helpers,
    onApply: (d) => { appliedDraft = d; },
  });
  assert.match(pModal.dialog.body, /관리 그룹/);
  assert.match(pModal.dialog.body, /구독/);
  assert.match(pModal.dialog.body, /리소스 그룹/);
  pModal.dialog.emit("change", { target: { closest: () => ({ dataset: { modalPolicyScope: "/subscriptions/sub-1" }, checked: true }) } });
  pModal.dialog.emit("click", { target: { closest: (sel) => (sel === "[data-picker-action]" ? { dataset: { pickerAction: "apply" } } : null) } });
  assert.deepEqual(appliedDraft, { ids: ["mg-platform", "/subscriptions/sub-1"] });

  const sModal = createFakeDialog();
  let pickedSub = null;
  openSubscriptionPicker({
    dialogElement: sModal.dialog,
    openDialog: sModal.openDialog,
    closeDialog: sModal.closeDialog,
    state: hierarchyState,
    items: subs,
    helpers,
    onSelect: (id) => { pickedSub = id; },
  });
  sModal.dialog.emit("click", { target: { closest: (sel) => (sel === "[data-entity-select]" ? { dataset: { entitySelect: "sub-2" } } : null) } });
  assert.equal(pickedSub, "sub-2");

  const mgModal = createFakeDialog();
  let pickedMg = null;
  openManagementGroupPicker({
    dialogElement: mgModal.dialog,
    openDialog: mgModal.openDialog,
    closeDialog: mgModal.closeDialog,
    state: hierarchyState,
    helpers,
    onSelect: (id) => { pickedMg = id; },
  });
  mgModal.dialog.emit("click", { target: { closest: (sel) => (sel === "[data-entity-select]" ? { dataset: { entitySelect: "mg-platform" } } : null) } });
  assert.equal(pickedMg, "mg-platform");
});
