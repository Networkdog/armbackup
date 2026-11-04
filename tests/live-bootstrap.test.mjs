import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/armbackup/ui_static/live-bootstrap.mjs", import.meta.url), "utf8");
const retryKey = "armbackup.module-reload.v1";

async function load({ fail = false, values = new Map(), storageError = "" } = {}) {
  const main = { textContent: "실환경 연결을 준비하고 있습니다…" };
  const banner = { hidden: true, replaceChildren(...children) { this.children = children; } };
  const timers = [], errors = [], warnings = [];
  let reloads = 0, imports = 0;
  const storage = {
    getItem: (key) => { if (storageError === "read") throw new Error("Storage blocked"); return values.get(key) ?? null; },
    setItem: (key, value) => { if (storageError === "write") throw new Error("Storage full"); values.set(key, value); },
    removeItem: (key) => { if (storageError === "remove") throw new Error("Storage blocked"); values.delete(key); },
  };
  await vm.runInNewContext(source.replace('import("./live-app.mjs")', "loadApp()"), {
    Error, String,
    loadApp: async () => { imports++; if (fail) throw new TypeError("Module fetch failed"); },
    window: { sessionStorage: storage, location: { reload: () => { reloads++; } } },
    document: {
      querySelector: (selector) => selector === "#main" ? main : banner,
      createElement: () => ({ addEventListener(name, callback) { this[name] = callback; } }),
    },
    console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
  });
  return { main, banner, timers, errors, warnings, imports, values, reloads: () => reloads };
}

test("a failed module dependency shows the error and automatically reloads once", async () => {
  const h = await load({ fail: true });
  assert.equal(h.banner.hidden, false);
  assert.match(h.banner.children[0].textContent, /Module fetch failed/);
  assert.match(h.main.textContent, /자동으로 새로고침/);
  assert.equal(h.errors.length, 1);
  assert.equal(h.imports, 1);
  assert.equal(h.values.get(retryKey), "retried");
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 1500);
  h.timers[0].callback();
  assert.equal(h.reloads(), 1);
});

test("persistent module failures stop automatic reloads and offer a working manual retry", async () => {
  const first = await load({ fail: true });
  const h = await load({ fail: true, values: first.values });
  assert.equal(h.timers.length, 0);
  assert.equal(h.banner.hidden, false);
  assert.match(h.main.textContent, /시작하지 못했습니다/);
  h.banner.children[1].click();
  assert.equal(h.reloads(), 1);
});

test("a recovered import clears the reload limit without changing application content", async () => {
  const h = await load({ values: new Map([[retryKey, "retried"]]) });
  assert.equal(h.values.has(retryKey), false);
  assert.equal(h.banner.hidden, true);
  assert.equal(h.timers.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.main.textContent, "실환경 연결을 준비하고 있습니다…");
});

test("blocked storage never creates a reload loop or hides the module failure", async () => {
  for (const storageError of ["read", "write"]) {
    const h = await load({ fail: true, storageError });
    assert.equal(h.timers.length, 0);
    assert.equal(h.banner.hidden, false);
    assert.equal(h.errors.length, 1);
    assert.equal(h.warnings.length, 1);
  }
  const h = await load({ storageError: "remove" });
  assert.equal(h.timers.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.warnings.length, 1);
});
