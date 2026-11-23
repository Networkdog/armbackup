import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  blobDetailDialogHtml,
  buildStorageIndex,
  buildStoragePaneNodes,
  createStorageState,
  defaultCollapsedDirs,
  exactBytes,
  formatBytes,
  formatShare,
  handleStorageTableKey,
  selectStorageDirectory,
  storageBreadcrumbHtml,
  storageShellHtml,
  storageTableHtml,
  storageTopbarHtml,
  toggleStorageTableDir,
  visibleStorageRows,
} from "../src/armbackup/ui_static/storage-explorer.mjs";
import { LiveClient } from "../src/armbackup/ui_static/live-client.mjs";
import { createDemoState } from "../src/armbackup/ui_static/demo-data.mjs";
import { previewStorageData } from "../src/armbackup/ui_static/model.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const icon = (name) => `<svg data-icon="${name}"></svg>`;
const helpers = { esc, icon, date: (v) => v, timezone: "KST" };
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
};

const samplePayload = {
  observedAt: "2026-11-23T03:00:00Z",
  archiveMode: "blob",
  accountUrl: "https://stvaultprod.blob.core.windows.net",
  accountName: "stvaultprod",
  container: "armbackup",
  localPath: "",
  configuredPrefix: "armbackup",
  prefix: "",
  blobCount: 5,
  totalBytes: 105994,
  truncated: false,
  scanLimit: 10000,
  blobs: [
    { name: "armbackup/runs/20261123T020000Z-111111111111/manifest.json", size: 1500, lastModified: "2026-11-23T02:00:05Z", contentType: "application/json", tier: "Hot" },
    { name: "armbackup/runs/20261123T020000Z-111111111111/resources/res-agw.json", size: 80000, lastModified: "2026-11-23T02:00:04Z", contentType: "application/json", tier: "Hot" },
    { name: "armbackup/runs/20261122T020000Z-222222222222/resources/res-lb.json", size: 20000, lastModified: "2026-11-22T02:00:03Z", contentType: "application/json", tier: "Hot" },
    { name: "armbackup/console/views/objects/view.json", size: 4490, lastModified: "2026-11-23T02:05:00Z", contentType: "application/json", tier: "Hot" },
    { name: "armbackup/locks/capture.lock", size: 4, lastModified: "2026-11-23T01:00:00Z", contentType: "application/octet-stream", tier: "Hot" },
  ],
};

test("buildStorageIndex rolls up recursive directory sizes, counts, timestamps and largest-first child order", () => {
  const index = buildStorageIndex(samplePayload);
  assert.equal(index.totalBytes, 105994);
  assert.equal(index.blobCount, 5);
  assert.equal(index.dirs.get("armbackup").totalBytes, 105994);
  assert.equal(index.dirs.get("armbackup/runs").totalBytes, 101500);
  assert.equal(index.dirs.get("armbackup/runs").blobCount, 3);
  assert.equal(index.dirs.get("armbackup/console").totalBytes, 4490);
  assert.equal(index.dirs.get("armbackup/locks").totalBytes, 4);
  assert.deepEqual(index.dirs.get("armbackup").childDirs, [
    "armbackup/runs",
    "armbackup/console",
    "armbackup/locks",
  ]);
  assert.equal(index.dirs.get("armbackup").lastModified, "2026-11-23T02:05:00Z");

  const paneNodes = buildStoragePaneNodes(index);
  const runsNode = paneNodes.find((n) => n.key === "armbackup/runs");
  assert.equal(runsNode.parent, "armbackup");
  assert.equal(runsNode.metaText, formatBytes(101500));
  assert.match(runsNode.kind, /백업 실행 보관소/);
});

test("formatBytes and formatShare keep exact bytes and tiny non-zero shares distinguishable", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.00 KiB");
  assert.equal(formatBytes(1048576 * 2.5), "2.50 MiB");
  assert.equal(exactBytes(105994), "105,994 B");
  assert.deepEqual(formatShare(4, 105994), { pct: 1, text: "<0.1%" });
  assert.deepEqual(formatShare(0, 105994), { pct: 0, text: "0.0%" });
});

test("current, flat, search and collapsed-tree A-layout views expose directory and blob sizes", () => {
  const index = buildStorageIndex(samplePayload);
  const st = createStorageState(memoryStorage());
  st.data = samplePayload;
  st.index = index;
  st.pane.collapsed = defaultCollapsedDirs(index);

  selectStorageDirectory(index, st, "armbackup");
  const inPrefix = visibleStorageRows(index, st);
  assert.deepEqual(inPrefix.rows.map((r) => r.displayName), ["runs", "console", "locks"]);

  // Flat mode ranks every individual blob under the selected directory by size descending.
  st.mode = "flat";
  const flat = visibleStorageRows(index, st);
  assert.equal(flat.rows.length, 5);
  assert.equal(flat.rows[0].blob.size, 80000);
  assert.equal(flat.rows.at(-1).blob.size, 4);

  // Search in current mode finds deep descendants from an ancestor directory.
  st.mode = "current";
  st.query = "res-agw";
  const searched = visibleStorageRows(index, st);
  assert.equal(searched.rows.length, 1);
  assert.equal(searched.rows[0].blob.name.endsWith("res-agw.json"), true);
  st.query = "";

  // Collapsed TreePane switches to A-layout with sticky scope-dir rows.
  st.pane.open = false;
  st.expandedDirs = new Set(["armbackup"]);
  const aLayout = visibleStorageRows(index, st);
  assert.equal(aLayout.rows[0].kind, "scope-dir");
  assert.equal(aLayout.rows[0].dir.path, "armbackup");
  toggleStorageTableDir(st, "armbackup");
  assert.equal(st.expandedDirs.has("armbackup"), false);
});

test("rendered HTML escapes untrusted text, uses zero inline style attributes and distinguishes states", () => {
  const st = createStorageState(memoryStorage());
  st.loading = true;
  assert.match(storageShellHtml(st, helpers), /집계하고 있습니다/);

  st.loading = false;
  st.error = "<img onerror=1>";
  const errHtml = storageShellHtml(st, helpers);
  assert.match(errHtml, /&lt;img onerror=1&gt;/);
  assert.match(errHtml, /data-action="storage-refresh"/);

  const truncatedData = { ...samplePayload, truncated: true, scanLimit: 5 };
  const index = buildStorageIndex(truncatedData);
  st.error = "";
  st.data = truncatedData;
  st.index = index;
  selectStorageDirectory(index, st, "armbackup/runs");

  const topbar = storageTopbarHtml(st, helpers);
  const crumbs = storageBreadcrumbHtml(index, st, helpers);
  const table = storageTableHtml(index, st, helpers);
  const detail = blobDetailDialogHtml(index, samplePayload.blobs[1].name, helpers);

  assert.match(topbar, /최소/);
  assert.match(crumbs, /data-action="storage-query-prefix"/);
  assert.match(table, /role="treegrid"/);
  assert.match(detail, /80,000 B/);
  for (const snippet of [topbar, crumbs, table, detail, storageShellHtml(st, helpers)]) {
    assert.doesNotMatch(snippet, /\sstyle="/);
  }
});

test("keyboard navigation drills into directories, ascends to parent and opens blob details", () => {
  const index = buildStorageIndex(samplePayload);
  const st = createStorageState(memoryStorage());
  st.data = samplePayload;
  st.index = index;
  selectStorageDirectory(index, st, "armbackup");

  let rerenders = 0;
  let inspected = "";
  const makeElements = () => visibleStorageRows(index, st).rows.map((row, idx) => ({
    dataset: { storageRow: row.id },
    tabIndex: idx === 0 ? 0 : -1,
    closest: (sel) => (sel === "[data-storage-row]" ? { dataset: { storageRow: row.id } } : null),
    focus() {},
    scrollIntoView() {},
  }));
  let elements = makeElements();
  const root = { querySelectorAll: () => elements };
  const dispatch = (key, rowIndex = 0) => {
    const target = elements[rowIndex];
    target.closest = (sel) => (sel === "[data-storage-row]" ? target : null);
    let prevented = false;
    const handled = handleStorageTableKey(
      { key, target, preventDefault() { prevented = true; } },
      root, index, st,
      { rerender: () => { rerenders++; elements = makeElements(); }, inspectBlob: (name) => { inspected = name; } },
    );
    return { handled, prevented };
  };

  assert.equal(dispatch("ArrowRight", 0).handled, true);
  assert.equal(st.pane.scope, "armbackup/runs");
  assert.equal(rerenders, 1);

  assert.equal(dispatch("ArrowRight", 0).handled, true);
  assert.equal(st.pane.scope, "armbackup/runs/20261123T020000Z-111111111111");

  // Second item in that run folder is manifest.json (first is resources/ directory).
  assert.equal(dispatch("Enter", 1).handled, true);
  assert.match(inspected, /manifest\.json$/);

  assert.equal(dispatch("ArrowLeft", 0).handled, true);
  assert.equal(st.pane.scope, "armbackup/runs");
});

test("LiveClient.storage encodes optional prefix and previewStorageData derives container blobs from preview state", async () => {
  const calls = [];
  const client = new LiveClient(async (path) => {
    calls.push(path);
    return { ok: true, status: 200, redirected: false, json: async () => ({ blobs: [], totalBytes: 0, blobCount: 0 }) };
  });
  await client.storage();
  await client.storage("armbackup/runs");
  assert.deepEqual(calls, ["/api/storage", "/api/storage?prefix=armbackup%2Fruns"]);

  const demo = previewStorageData(createDemoState(new Date("2026-11-23T00:00:00Z")));
  assert.equal(demo.archiveMode, "preview");
  assert.ok(demo.blobCount > 5);
  assert.equal(demo.totalBytes, demo.blobs.reduce((s, b) => s + b.size, 0));

  const uiStatic = readFileSync(new URL("../src/armbackup/ui_static/storage-explorer.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(uiStatic, /\sstyle="/);
  assert.doesNotMatch(uiStatic.toLowerCase(), /\bdemo\b/);
});
