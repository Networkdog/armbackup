import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/armbackup/ui_static/live-app.mjs", import.meta.url), "utf8");
const functionSource = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("calendar-to-Gateway review preserves the historical run instead of the latest aggregate", () => {
  const row = { resource: { id: "/gateway", type: "microsoft.network/applicationgateways" },
    snapshot: {}, observation: { status: "present" } };
  const context = vm.createContext({
    ui: { runId: "latest" }, state: {}, location: { hash: "#restore" },
    bundlePreferences: null, renders: 0,
    selectedRow: () => row, rowsFor: (_, id) => { assert.equal(id, "historical-run"); return [row]; },
    restoreAvailability: () => ({ allowed: true }),
    render: () => context.renders++,
  });
  vm.runInContext(functionSource("function openBundle(", "function renderRestoreCalendar("), context);
  vm.runInContext(functionSource("function startRestore(", "function renderRestore()"), context);
  context.startRestore("/gateway", "historical-run", true);
  assert.equal(context.bundlePreferences.runId, "historical-run");
  assert.equal(context.ui.restore.bundle, true);
  assert.equal(context.location.hash, "#restore");
  assert.equal(context.renders, 1);
});
