import assert from "node:assert/strict";
import test from "node:test";
import { loginMessage } from "../src/armbackup/ui_static/login.mjs";

test("sign-in errors never say which of ID or password was wrong", () => {
  assert.equal(loginMessage(401), "아이디 또는 비밀번호가 올바르지 않습니다.");
});

test("throttled sign-in tells the operator how long to wait", () => {
  assert.match(loginMessage(429, "840"), /14분 후/);
  assert.match(loginMessage(429, ""), /잠시 후/);
});

test("other failures get a generic retry message", () => {
  assert.match(loginMessage(500), /다시 시도/);
});
