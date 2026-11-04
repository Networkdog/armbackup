import assert from "node:assert/strict";
import test from "node:test";
import { createErrorDialog } from "../src/armbackup/ui_static/error-dialog.mjs";

function harness() {
  const element = () => ({
    textContent: "", children: [], events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    replaceChildren(...children) { this.children = children; },
  });
  const message = element(), actions = element(), close = element();
  const root = {
    ...element(), open: false, openings: 0,
    querySelector: (selector) => ({ "#error-message": message, "#error-actions": actions, "#error-close": close })[selector],
    ownerDocument: { createElement: element },
    showModal() { this.open = true; this.openings++; },
    close() { this.open = false; },
  };
  return { modal: createErrorDialog(root), root, message, actions, close };
}

test("errors use literal text, a native modal and working recovery and confirmation controls", () => {
  const h = harness();
  let retries = 0;
  h.modal.show("<img src=x onerror=alert(1)>", [{ label: "상태 다시 확인", run: () => { retries++; } }]);
  assert.equal(h.modal.open, true);
  assert.equal(h.message.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(h.root.openings, 1);
  h.modal.show(h.message.textContent);
  assert.equal(h.root.openings, 1);
  h.actions.children[0].events.click();
  assert.equal(retries, 1);
  assert.equal(h.modal.open, false);
  h.modal.show("Another error");
  h.actions.children.at(-1).events.click();
  assert.equal(h.modal.open, false);
});

test("dismissed background errors do not steal focus again, but explicit retries still report them", () => {
  const h = harness();
  h.modal.show("Network failed", [], { background: true });
  h.close.events.click();
  h.modal.show("Network failed", [], { background: true });
  assert.equal(h.modal.open, false);
  h.modal.show("Network failed");
  assert.equal(h.modal.open, true);
  h.root.events.cancel();
  h.root.close();
  h.modal.show("Network failed", [], { background: true });
  assert.equal(h.modal.open, false);
  h.modal.clear();
  h.modal.show("Network failed", [], { background: true });
  assert.equal(h.modal.open, true);
});

test("authentication recovery offers a same-origin login link without replacing other dialogs", () => {
  const h = harness();
  h.modal.show("HTTP 403", [{ label: "다시 로그인", href: "/.auth/login/aad?post_login_redirect_uri=%2F" }]);
  assert.equal(h.actions.children[0].href, "/.auth/login/aad?post_login_redirect_uri=%2F");
  assert.equal(h.actions.children.at(-1).textContent, "확인");
  h.modal.clear();
  assert.equal(h.modal.open, false);
});

test("Escape closes only the error modal and suppresses repeated background errors", () => {
  const h = harness();
  let prevented = false, stopped = false;
  h.modal.show("Disconnected");
  h.root.events.keydown({ key: "Enter" });
  assert.equal(h.modal.open, true);
  h.root.events.keydown({
    key: "Escape",
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(h.modal.open, false);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  h.modal.show("Disconnected", [], { background: true });
  assert.equal(h.modal.open, false);
});
