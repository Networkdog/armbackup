import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_RESOURCES, officialPolicyTypes, legacyPolicyTypes, relatedPolicyResources, resourceBackupCompanions } from "../src/armbackup/ui_static/support-catalog.mjs";
import { DemoStore, savePolicy, DemoError } from "../src/armbackup/ui_static/model.mjs";

test("official choices are fixed even with no instances and exclude contained or experimental types", () => {
  assert.deepEqual(SUPPORTED_RESOURCES.map((entry) => entry.label), ["Application Gateway", "Load Balancer"]);
  const types = SUPPORTED_RESOURCES.map((entry) => entry.type);
  assert.deepEqual(officialPolicyTypes([types[0].toUpperCase(), "microsoft.cdn/profiles"]), [types[0]]);
  assert.deepEqual(legacyPolicyTypes([...types, "microsoft.cdn/profiles"]), ["microsoft.cdn/profiles"]);
});

test("each selectable resource type describes both related and dependent resources backed up together", () => {
  const [agw, lb] = SUPPORTED_RESOURCES.map(resourceBackupCompanions);
  assert.equal(agw.relatedText, "Public IP · WAF Policy");
  assert.match(agw.dependentText, /Listener.*Backend Pool.*본문 포함/);
  assert.equal(lb.relatedText, "Public IP");
  assert.match(lb.dependentText, /Backend Pool \(하위 리소스\).*부하 분산 규칙.*본문 포함/);
});

test("the preview accepts official types without fabricating instances and preserves old backups", () => {
  const memory = new Map();
  const store = new DemoStore({ getItem: (key) => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) });
  const originalRuns = structuredClone(store.state.runs);
  const policy = { ...store.state.policy, types: SUPPORTED_RESOURCES.map((entry) => entry.type) };
  savePolicy(store, policy);
  assert.deepEqual(store.state.runs, originalRuns);
  assert.throws(() => savePolicy(store, { ...policy, types: ["microsoft.network/publicipaddresses"] }), DemoError);
});

test("effective targets include referenced public IPs and contained pools but not shared networks", () => {
  const type = SUPPORTED_RESOURCES[1].type;
  const resources = [
    { id: "/lb", type }, { id: "/lb/backendAddressPools/http", type: type + "/backendaddresspools" },
    { id: "/ip", type: "microsoft.network/publicipaddresses" },
    { id: "/vnet", type: "microsoft.network/virtualnetworks" },
    { id: "/other-ip", type: "microsoft.network/publicipaddresses" },
  ];
  const current = { "/lb": { raw: { properties: {
    frontendIPConfigurations: [{ publicIPAddress: { id: "/IP" } }], virtualNetwork: { id: "/vnet" },
  } } } };
  assert.deepEqual(relatedPolicyResources(resources, current, [resources[0]]).map((resource) => resource.id),
    ["/lb", "/lb/backendAddressPools/http", "/ip"]);
});
