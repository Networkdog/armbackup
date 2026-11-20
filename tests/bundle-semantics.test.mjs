import assert from "node:assert/strict";
import test from "node:test";
import { BundlePanel, adjustmentList, bundleReviewInput, bundleSelection, nonRestorableItems, parseOverrides, suggestDnsLabel, suggestSampleIp } from "../src/armbackup/ui_static/bundle-panel.mjs";
import { restoreAvailability } from "../src/armbackup/ui_static/live-client.mjs";

const graph = {
  nodes: [{ id: "/lb", name: "lb", restoreSupported: true }, { id: "/pip", name: "pip-web", restoreSupported: true },
    { id: "/nsg", name: "nsg", restoreSupported: true }],
  edges: [{ from: "/lb", to: "/pip", kind: "reference", relation: "required" },
    { from: "/lb", to: "/nsg", kind: "reference", relation: "optional" }],
  addresses: [],
};
const model = (extra = {}) => ({ runId: "run1", selected: ["/lb"], includeRelated: true, excludedRelated: [],
  mode: "clone", clonePrefix: "dr", ticket: "INC-1", reason: "dr rehearsal", ack: true, ...extra });

test("an unchecked related resource stays out of the selection and the review input", () => {
  assert.deepEqual(bundleSelection(graph, ["/lb"], true, ["/NSG"]).map((node) => node.id), ["/lb", "/pip"]);
  assert.deepEqual(bundleSelection(graph, ["/lb", "/nsg"], true, ["/nsg"]).map((node) => node.id), ["/lb", "/pip", "/nsg"]);
  const input = bundleReviewInput(model({ excludedRelated: ["/nsg"] }), graph);
  assert.deepEqual(input.excludedRelated, ["/nsg"]);
  assert.equal(bundleReviewInput(model(), graph).excludedRelated, undefined);
  assert.equal(bundleReviewInput(model({ includeRelated: false, excludedRelated: ["/nsg"] }), graph).excludedRelated, undefined);
});

test("override lines name a selected resource, a path and a JSON or plain value", () => {
  const nodes = graph.nodes;
  assert.deepEqual(parseOverrides("# comment\n\npip-web name=pip-web-dr\n/lb properties.idle=10\npip-web tags.tier = \"dr\"\npip-web x=[\"a\"]", nodes), [
    { resourceId: "/pip", path: "name", value: "pip-web-dr" },
    { resourceId: "/lb", path: "properties.idle", value: 10 },
    { resourceId: "/pip", path: "tags.tier", value: "dr" },
    { resourceId: "/pip", path: "x", value: ["a"] },
  ]);
  assert.deepEqual(parseOverrides("lb properties.subnets[name=app].properties.addressPrefix=10.0.9.0/24", nodes)[0].path,
    "properties.subnets[name=app].properties.addressPrefix");
  assert.throws(() => parseOverrides("pip-web", nodes), /1번째 줄/);
  assert.throws(() => parseOverrides("missing name=x", nodes), /없/);
  assert.throws(() => parseOverrides("lb a=1\nlb b=2", [...nodes, { id: "/lb2", name: "LB" }]), /여러 개/);
});

test("property overrides work across restore and clone while name overrides stay clone-only", () => {
  const text = "pip-web name=pip-web-dr";
  assert.deepEqual(bundleReviewInput(model({ overridesText: text }), graph).overrides,
    [{ resourceId: "/pip", path: "name", value: "pip-web-dr" }]);
  assert.throws(() => bundleReviewInput(model({ mode: "update", overridesText: text }), graph), /복제 모드에서만/);
  assert.deepEqual(bundleReviewInput(model({ mode: "update", overridesText: "pip-web tags.env=\"restored\"" }), graph).overrides,
    [{ resourceId: "/pip", path: "tags.env", value: "restored" }]);
  assert.throws(() => bundleReviewInput(model({ overridesText: "nonsense" }), graph), /형식/);
});

test("an update can ask to keep immutable live values or explicitly block", () => {
  assert.equal(bundleReviewInput(model({ mode: "update", immutableConflict: "keep-current" }), graph).immutableConflict, "keep-current");
  assert.equal(bundleReviewInput(model({ mode: "update", immutableConflict: "block" }), graph).immutableConflict, "block");
  assert.equal(bundleReviewInput(model({ mode: "update" }), graph).immutableConflict, undefined);
  assert.equal(bundleReviewInput(model({ immutableConflict: "keep-current" }), graph).immutableConflict, undefined);
});

test("the plan lists what changes, with the reason, and escapes server text", () => {
  const html = adjustmentList({ actions: [{ name: "pip", adjustments: [
    { path: "properties.dnsSettings.reverseFqdn", change: "dropped", reason: "<b>원본</b>" },
    { path: "properties.gatewayIPConfigurations[0].properties.subnet.id", change: "rebound", reason: "대상 서브넷 연결" }], warnings: ["주소 공간이 같음"] }] });
  assert.match(html, /제외/); assert.match(html, /대상 연결 변경/); assert.match(html, /&lt;b&gt;/); assert.match(html, /주소 공간이 같음/);
  assert.equal(adjustmentList({ actions: [{ name: "pip" }] }), "");
});

test("clone mode auto-includes exclusive Public IP and locks shareable WAF across boundaries", () => {
  const agwGraph = {
    nodes: [
      { id: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/applicationGateways/agw", name: "agw", location: "koreacentral", restoreSupported: true },
      { id: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/publicIPAddresses/pip", name: "pip", location: "koreacentral", restoreSupported: true },
      { id: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/waf", name: "waf", location: "koreacentral", restoreSupported: true },
    ],
    edges: [
      { from: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/applicationGateways/agw", to: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/publicIPAddresses/pip", kind: "reference", relation: "required", relationClass: "exclusive" },
      { from: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/applicationGateways/agw", to: "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/waf", kind: "reference", relation: "optional", relationClass: "shareable" },
    ],
    addresses: [],
  };
  const panel = Object.create(BundlePanel.prototype);
  Object.assign(panel, {
    graph: agwGraph,
    targets: { currentSubscription: "s1" },
    model: {
      mode: "clone", selected: [agwGraph.nodes[0].id], includeRelated: false,
      excludedRelated: [agwGraph.nodes[1].id, agwGraph.nodes[2].id],
      targetSubscription: "", targetLocation: "",
    },
  });
  panel.syncCloneConstraints();
  assert.equal(panel.model.includeRelated, true);
  assert.deepEqual(panel.model.excludedRelated, [agwGraph.nodes[2].id]);
  panel.model.targetSubscription = "s2";
  panel.syncCloneConstraints();
  assert.deepEqual(panel.model.excludedRelated, []);
});

test("smart clone fields auto-suggest DNS labels, enforce shared-subnet AGW static IP, and emit referenceBindings", () => {
  const subSrc = "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/vnet1/subnets/snet-agw";
  const subDr = "/subscriptions/s2/resourceGroups/rg-dr/providers/Microsoft.Network/virtualNetworks/vnet-dr/subnets/snet-agw";
  const agwId = "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/applicationGateways/agw";
  const pipId = "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/publicIPAddresses/pip";
  const richGraph = {
    nodes: [
      {
        id: agwId, name: "agw", location: "koreacentral", restoreSupported: true,
        cloneHints: { staticFrontends: [{ name: "priv", privateIPAddress: "10.0.1.10", subnetId: subSrc, requiresStatic: true }] },
      },
      {
        id: pipId, name: "pip", location: "koreacentral", restoreSupported: true,
        cloneHints: { dnsLabel: "contoso-web" },
      },
    ],
    edges: [
      { from: agwId, to: pipId, kind: "reference", relation: "required", relationClass: "exclusive" },
      { from: agwId, to: subSrc, referenceId: subSrc, kind: "shared", relation: "shared", relationClass: "shared-infra" },
    ],
    addresses: [],
  };
  assert.equal(suggestDnsLabel("contoso-web", "", "RG_DR_01"), "rg-dr-01-contoso-web");
  assert.throws(() => bundleReviewInput(model({
    selected: [agwId], clonePrefix: "dr", smartNames: {}, smartDnsLabels: {}, smartPrivateIps: {}, referenceBindings: {},
  }), richGraph), /정적 사설 IP/);

  const sameSubInput = bundleReviewInput(model({
    selected: [agwId], clonePrefix: "dr",
    smartNames: { [agwId.toLowerCase()]: "agw-canary" },
    smartPrivateIps: { [`${agwId.toLowerCase()}::priv`]: "10.0.1.25" },
  }), richGraph);
  assert.deepEqual(sameSubInput.overrides, [
    { resourceId: agwId, path: "name", value: "agw-canary" },
    { resourceId: agwId, path: "properties.frontendIPConfigurations[name=priv].properties.privateIPAddress", value: "10.0.1.25" },
  ]);

  assert.throws(() => bundleReviewInput(model({
    selected: [agwId], clonePrefix: "", targetSubscription: "s2", targetGroup: "rg-dr", targetLocation: "koreasouth",
    referenceBindings: {},
  }), richGraph), /공유 서브넷/);

  const crossSubInput = bundleReviewInput(model({
    selected: [agwId], clonePrefix: "", targetSubscription: "s2", targetGroup: "rg-dr", targetLocation: "koreasouth",
    referenceBindings: { [subSrc.toLowerCase()]: subDr },
  }), richGraph);
  assert.equal(crossSubInput.targetLocation, "koreasouth");
  assert.deepEqual(crossSubInput.referenceBindings, [{ sourceId: subSrc, targetId: subDr }]);
  assert.deepEqual(crossSubInput.overrides, [
    { resourceId: pipId, path: "properties.dnsSettings.domainNameLabel", value: "rg-dr-contoso-web" },
  ]);
});

test("restoreAvailability keeps clone available when live observation is unknown and allows recovering Failed state", () => {
  const baseState = { workspace: { restoreEnabled: true } };
  const unknownLive = {
    status: "unknown",
    snapshot: { complete: true, restoreSupported: true },
    observation: { status: "error", code: "Timeout" },
  };
  const resUnknown = restoreAvailability(baseState, unknownLive);
  assert.equal(resUnknown.allowed, false);
  assert.equal(resUnknown.cloneAllowed, true);

  const failedLive = {
    status: "unknown",
    snapshot: { complete: true, restoreSupported: true },
    observation: { status: "present", provisioningState: "Failed", warnings: [] },
  };
  const resFailed = restoreAvailability(baseState, failedLive);
  assert.equal(resFailed.allowed, true);
  assert.equal(resFailed.cloneAllowed, true);
  assert.match(resFailed.reason, /Failed/);

  const partialRow = {
    status: "warning",
    snapshot: { complete: true, restoreSupported: true, omittedCount: 2 },
    observation: { status: "present" },
  };
  const resPartial = restoreAvailability(baseState, partialRow);
  assert.equal(resPartial.allowed, true);
  assert.match(resPartial.reason, /복원 불가 속성 2개/);
});

test("review and execute notify non-restorable or kept-current properties and surface gate reasons inline", async () => {
  const notices = [];
  const reviewBtn = { disabled: false, title: "" };
  const reviewHint = { textContent: "" };
  const execBtn = { disabled: true, title: "" };
  const execHint = { textContent: "" };
  const elements = {
    '[data-bundle="review"]': reviewBtn,
    '[data-gate="review"]': reviewHint,
    '[data-bundle="execute"]': execBtn,
    '[data-gate="execute"]': execHint,
  };
  const panel = Object.create(BundlePanel.prototype);
  Object.assign(panel, {
    alive: true,
    graph,
    notify: (n) => notices.push(n),
    writeLocked: () => true,
    state: { workspace: { inventoryScope: "subscription", scopeConfirmation: "sub-uuid", resourceGroup: "rg1" } },
    model: {
      runId: "run1", selected: ["/lb"], includeRelated: false, excludedRelated: [],
      mode: "update", immutableConflict: "keep-current", ticket: "", reason: "", ack: false,
      confirmGroup: "", approved: false, plan: null, result: null, busy: false, error: "",
    },
    api: {
      bundleReview: async () => ({
        id: "plan-1", approvalSha256: "sha-1", expiresAt: "2026-12-01T00:00:00Z",
        actions: [{
          name: "agw", wasPresent: true,
          adjustments: [
            { path: "properties.sslCertificates[name=pfx]", change: "kept-current", reason: "PFX 비밀값 없음" },
            { path: "properties.outboundRules[0].properties.allocationPolicy", change: "dropped", reason: "비공개 속성 제외" },
          ],
        }],
      }),
    },
    run: async () => ({
      status: "Succeeded",
      result: {
        safetyRunId: "safety-1",
        omittedOrKept: [{ resource: "agw", path: "properties.sslCertificates[name=pfx]", change: "kept-current" }],
      },
    }),
    refresh: async () => {},
    render() { this.updateGates(); },
    root: {
      querySelector: (sel) => elements[sel] || null,
      insertAdjacentHTML: () => {},
    },
  });

  panel.updateGates();
  assert.equal(reviewBtn.disabled, true);
  assert.match(reviewHint.textContent, /티켓/);

  Object.assign(panel.model, { ticket: "CHG-99", reason: "partial restore test", ack: true });
  panel.updateGates();
  assert.equal(reviewBtn.disabled, false);
  assert.equal(reviewHint.textContent, "");

  await panel.click({ target: { closest: () => ({ dataset: { bundle: "review" }, disabled: false }) } });
  assert.equal(nonRestorableItems(panel.model.plan).length, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /2건/);
  assert.equal(execBtn.disabled, true);
  assert.match(execHint.textContent, /잠겨 있습니다/);

  panel.writeLocked = () => false;
  panel.updateGates();
  assert.match(execHint.textContent, /구독 ID/);
  panel.model.confirmGroup = "sub-uuid";
  panel.updateGates();
  assert.match(execHint.textContent, /체크박스/);
  panel.model.approved = true;
  panel.updateGates();
  assert.equal(execBtn.disabled, false);
  assert.equal(execHint.textContent, "");

  await panel.click({ target: { closest: () => ({ dataset: { bundle: "execute" }, disabled: false }) } });
  assert.equal(notices.length, 2);
  assert.match(notices[1].message, /1건/);
  assert.match(panel.resultView(), /1개는 제외 또는 현재 값 유지/);
});

test("AKS LB clone pre-warns before review, pre-fills sample IPs, dedupes pool adjustments, and supports restore sample chips", async () => {
  assert.equal(suggestSampleIp(["10.224.0.0/24"], ["10.224.0.4", "10.224.0.5"], ["10.224.0.4", "10.224.0.5"]), "10.224.0.250");
  assert.equal(suggestSampleIp(["10.224.0.0/24"], ["10.224.0.250"], ["10.224.0.250"]), "10.224.0.249");

  const lbId = "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/loadBalancers/capp-svc-lb";
  const poolId = `${lbId}/backendAddressPools/capp-svc-lbbepool`;
  const vnetId = "/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/aks-vnet";
  const aksGraph = {
    nodes: [
      {
        id: lbId, name: "capp-svc-lb", label: "Load Balancer", location: "koreacentral",
        resourceType: "microsoft.network/loadbalancers", restoreSupported: true,
        cloneHints: {
          backendPools: [{
            name: "capp-svc-lbbepool", ipCount: 2, nicCount: 0,
            sampleIps: ["10.224.0.4", "10.224.0.5"], vnetId, suggestedPlaceholderIp: "10.224.0.250",
          }],
        },
      },
      {
        id: poolId, parentId: lbId, name: "capp-svc-lbbepool", label: "LB Backend Pool",
        resourceType: "microsoft.network/loadbalancers/backendaddresspools", restoreSupported: true,
      },
    ],
    edges: [{ from: lbId, to: vnetId, referenceId: vnetId, kind: "shared", relationClass: "shared-infra" }],
    addresses: [],
  };

  const panel = Object.create(BundlePanel.prototype);
  Object.assign(panel, {
    alive: true,
    graph: aksGraph,
    prefilledKeys: new Set(),
    state: { workspace: { inventoryScope: "subscription", scopeConfirmation: "s1", resourceGroup: "rg1" }, current: {} },
    targets: {
      currentSubscription: "s1",
      subscriptions: [{ subscriptionId: "s1", name: "운영" }],
      groups: { s1: [{ name: "rg1", location: "koreacentral" }] },
      networks: { s1: [{ id: vnetId, name: "aks-vnet", resourceGroup: "rg1", location: "koreacentral", subnets: [{ id: `${vnetId}/subnets/aks`, name: "aks", addressPrefixes: ["10.224.0.0/24"] }] }] },
    },
    model: model({
      selected: [lbId], includeRelated: false, clonePrefix: "copy",
      backendPoolMode: "placeholder", smartPoolIps: {}, smartPrivateIps: {}, smartDnsLabels: {}, smartKeyVaultCerts: {},
      referenceBindings: {}, customBindingModes: {}, smartNames: {},
    }),
    invalidate() {},
    render() {},
    root: { querySelector: () => null },
  });

  panel.prefillSamples();
  const poolKey = `${lbId.toLowerCase()}::capp-svc-lbbepool`;
  assert.equal(panel.model.smartPoolIps[poolKey], "10.224.0.250");

  const formHtml = panel.reviewForm("");
  assert.match(formHtml, /사전 안내 · capp-svc-lb/);
  assert.match(formHtml, /id="bundle-pool-mode"/);
  assert.match(formHtml, /샘플 값 입력: 10\.224\.0\.250/);

  const reviewPayload = bundleReviewInput(panel.model, aksGraph);
  assert.equal(reviewPayload.backendPoolMode, "placeholder");
  assert.deepEqual(reviewPayload.placeholderIps, { [poolKey]: "10.224.0.250" });

  // Deduplicate LB + LB_POOL adjustments so user never sees two duplicate pool lines
  const dupPlan = {
    actions: [
      {
        resourceId: `${lbId}-copy`, resourceType: "microsoft.network/loadbalancers", name: "copy-capp-svc-lb",
        adjustments: [{ path: "properties.backendAddressPools[name=capp-svc-lbbepool].properties.loadBalancerBackendAddresses", change: "placeholder", reason: "샘플 사설 IP 적용" }],
      },
      {
        resourceId: `${lbId}-copy/backendAddressPools/capp-svc-lbbepool`, resourceType: "microsoft.network/loadbalancers/backendaddresspools", name: "capp-svc-lbbepool",
        adjustments: [{ path: "properties.loadBalancerBackendAddresses", change: "placeholder", reason: "샘플 사설 IP 적용" }],
      },
    ],
  };
  assert.equal(nonRestorableItems(dupPlan).length, 1);
  assert.equal(nonRestorableItems(dupPlan)[0].name, "capp-svc-lbbepool");
  assert.match(adjustmentList(dupPlan), /임시 샘플 값/);

  // Sample chip clicks populate fields and override lines in restore mode too
  panel.model.mode = "create";
  await panel.click({
    target: {
      closest: (sel) => sel === "[data-sample-override]"
        ? { dataset: { sampleOverride: "capp-svc-lb tags.environment=\"restored\"" }, disabled: false }
        : null,
    },
  });
  assert.equal(panel.model.overridesText, "capp-svc-lb tags.environment=\"restored\"");
  const createPayload = bundleReviewInput(panel.model, aksGraph);
  assert.deepEqual(createPayload.overrides, [{ resourceId: lbId, path: "tags.environment", value: "restored" }]);
});
