import assert from "node:assert/strict";
import test from "node:test";
import { adjustmentList, bundleReviewInput, bundleSelection, parseOverrides } from "../src/armbackup/ui_static/bundle-panel.mjs";

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

test("overrides are sent only for clones and bad lines stop the review", () => {
  const text = "pip-web name=pip-web-dr";
  assert.deepEqual(bundleReviewInput(model({ overridesText: text }), graph).overrides,
    [{ resourceId: "/pip", path: "name", value: "pip-web-dr" }]);
  assert.equal(bundleReviewInput(model({ mode: "update", overridesText: text }), graph).overrides, undefined);
  assert.throws(() => bundleReviewInput(model({ overridesText: "nonsense" }), graph), /형식/);
});

test("an update can ask to keep immutable live values", () => {
  assert.equal(bundleReviewInput(model({ mode: "update", immutableConflict: "keep-current" }), graph).immutableConflict, "keep-current");
  assert.equal(bundleReviewInput(model({ mode: "update" }), graph).immutableConflict, undefined);
  assert.equal(bundleReviewInput(model({ immutableConflict: "keep-current" }), graph).immutableConflict, undefined);
});

test("the plan lists what changes, with the reason, and escapes server text", () => {
  const html = adjustmentList({ actions: [{ name: "pip", adjustments: [
    { path: "properties.dnsSettings.reverseFqdn", change: "dropped", reason: "<b>원본</b>" }], warnings: ["주소 공간이 같음"] }] });
  assert.match(html, /제외/); assert.match(html, /&lt;b&gt;/); assert.match(html, /주소 공간이 같음/);
  assert.equal(adjustmentList({ actions: [{ name: "pip" }] }), "");
});
