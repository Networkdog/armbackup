import assert from "node:assert/strict";
import test from "node:test";
import { createNotifications } from "../src/armbackup/ui_static/notifications.mjs";

class Element {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, listeners: {}, className: "", hidden: false, textContent: "", innerHTML: "", parent: null, disabled: false });
  }
  append(...kids) { for (const kid of kids) { kid.parent = this; this.children.push(kid); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  fire(name, event = {}) { (this.listeners[name] || []).forEach((handler) => handler(event)); }
  find(className) { return this.children.flatMap((child) => [child, ...child.descendants()]).filter((child) => child.className.split(" ").includes(className)); }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
}

function harness() {
  const ids = Object.fromEntries(["#notification-region", "#notification-bell", "#notification-count", "#notification-panel", "#notification-list", "#notification-clear"]
    .map((id) => [id, new Element("div")]));
  ids["#notification-panel"].hidden = true;
  const doc = { createElement: (tag) => new Element(tag), querySelector: (selector) => ids[selector] || null, addEventListener() {} };
  const timers = [];
  let clock = 1_000_000;
  const api = createNotifications(doc, {
    now: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cancelled = true; },
  });
  const live = () => timers.filter((timer) => !timer.cancelled);
  return { api, ids, region: ids["#notification-region"], timers, live, advance: (ms) => { clock += ms; }, fire: () => { const timer = live().at(-1); timer.cancelled = true; timer.fn(); } };
}

test("messages pop up as literal text and disappear after a few seconds", () => {
  const h = harness();
  h.api.notify({ level: "info", message: "<img src=x onerror=alert(1)>" });
  const [popup] = h.region.children;
  assert.equal(popup.find("notification-text")[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(popup.attrs.role, "status");
  assert.equal(h.live().at(-1).ms, 6000);
  h.fire();
  assert.equal(h.region.children.length, 0);
  h.api.notify({ level: "error", message: "denied" });
  assert.equal(h.region.children[0].attrs.role, "alert");
  assert.equal(h.live().at(-1).ms, 12000);
});

test("progress stays until it is replaced by its result under the same key", () => {
  const h = harness();
  h.api.notify({ key: "read", level: "progress", message: "읽는 중" });
  assert.equal(h.live().length, 0);
  h.api.notify({ key: "read", level: "success", message: "완료" });
  assert.equal(h.region.children.length, 1);
  assert.equal(h.region.children[0].find("notification-text")[0].textContent, "완료");
  assert.equal(h.live().length, 1);
  h.api.notify({ key: "read", level: "progress", message: "다시 읽는 중" });
  h.api.dismiss("read");
  assert.equal(h.region.children.length, 0);
});

test("hovering keeps a notification and leaving gives it time to be read", () => {
  const h = harness();
  h.api.notify({ level: "warning", message: "slow" });
  const [popup] = h.region.children;
  popup.fire("mouseenter");
  assert.equal(h.live().length, 0);
  popup.fire("mouseleave");
  assert.ok(h.live().at(-1).ms >= 3000);
});

test("repeated status notices are quiet for five minutes but explicit messages always show", () => {
  const h = harness();
  h.api.notify({ key: "collection", level: "info", message: "수집 중", dedupe: true });
  h.fire();
  h.api.notify({ key: "collection", level: "info", message: "수집 중", dedupe: true });
  assert.equal(h.region.children.length, 0);
  h.api.notify({ level: "success", message: "저장했습니다" });
  h.fire();
  h.api.notify({ level: "success", message: "저장했습니다" });
  assert.equal(h.region.children.length, 1);
  h.fire();
  h.advance(301_000);
  h.api.notify({ key: "collection", level: "info", message: "수집 중", dedupe: true });
  assert.equal(h.region.children.length, 1);
});

test("a visible duplicate with dedupe does not restart its timer", () => {
  const h = harness();
  h.api.notify({ key: "k", level: "warning", message: "same", dedupe: true });
  const first = h.live().at(-1);
  h.api.notify({ key: "k", level: "warning", message: "same", dedupe: true });
  assert.equal(h.live().at(-1), first);
  assert.equal(h.region.children.length, 1);
});

test("at most four notifications are visible while all remain in the bell list", () => {
  const h = harness();
  for (let index = 1; index <= 6; index++) h.api.notify({ level: "info", message: `message ${index}` });
  assert.equal(h.region.children.length, 4);
  assert.equal(h.ids["#notification-list"].children.length, 6);
  assert.equal(h.ids["#notification-count"].textContent, "6");
  assert.equal(h.ids["#notification-count"].hidden, false);
  h.ids["#notification-bell"].fire("click");
  assert.equal(h.ids["#notification-panel"].hidden, false);
  assert.equal(h.ids["#notification-count"].hidden, true);
  h.api.notify({ level: "info", message: "while open" });
  assert.equal(h.ids["#notification-count"].hidden, true);
  h.ids["#notification-clear"].fire("click");
  assert.equal(h.ids["#notification-list"].children[0].className, "notification-empty");
});

test("error recovery actions run once and dismissed background errors stay quiet", () => {
  const h = harness();
  let retries = 0;
  h.api.show("Disconnected", [{ label: "상태 다시 확인", run: () => { retries++; } }, { label: "다시 로그인", href: "/login" }]);
  assert.equal(h.api.open, true);
  const buttons = h.region.children[0].find("button").concat(h.region.children[0].find("a"));
  assert.deepEqual(buttons.map((button) => button.textContent), ["상태 다시 확인", "다시 로그인"]);
  assert.equal(buttons[1].href, "/login");
  buttons[0].fire("click");
  assert.equal(retries, 1);
  assert.equal(h.api.open, false);
  h.api.show("Network failed", [], { background: true });
  h.region.children[0].find("notification-close")[0].fire("click");
  h.api.show("Network failed", [], { background: true });
  assert.equal(h.region.children.length, 0);
  h.api.show("Network failed");
  assert.equal(h.region.children.length, 1);
  h.api.clear();
  assert.equal(h.api.open, false);
  h.api.show("Network failed", [], { background: true });
  assert.equal(h.region.children.length, 1);
});

test("notice blocks rendered into the page are promoted to notifications, except persistent safety text", () => {
  const h = harness();
  const make = (className, text, parent = null) => ({
    classList: { contains: (name) => className.split(" ").includes(name) }, textContent: text, removed: false,
    closest: () => parent, querySelectorAll: () => [], remove() { this.removed = true; },
  });
  const warning = make("notice warning", "  첫 줄  \n 둘째   줄 ");
  const plain = make("notice", "정보");
  const persistent = make("notice warning", "되돌리면 규칙이 제거됩니다", {});
  h.api.adopt({ querySelectorAll: () => [warning, plain, persistent] });
  assert.equal(warning.removed, true);
  assert.equal(plain.removed, true);
  assert.equal(persistent.removed, false);
  const shown = h.region.children.map((popup) => popup.find("notification-text")[0].textContent);
  assert.deepEqual(shown, ["첫 줄\n둘째 줄", "정보"]);
  assert.equal(h.region.children[0].className, "notification warning");
});
