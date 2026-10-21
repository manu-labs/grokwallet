import assert from "node:assert/strict";
import test from "node:test";
import { deviceVerifySucceeded } from "./device-verify.ts";

test("device_verify success is a direct 200 or 204 without an error body", () => {
  assert.equal(deviceVerifySucceeded(200, "", false), true);
  assert.equal(deviceVerifySucceeded(204, "", false), true);
  assert.equal(deviceVerifySucceeded(200, "{}", false), true);
  assert.equal(deviceVerifySucceeded(200, '{"success":true}', false), true);
});

test("device_verify failure stays a failure", () => {
  assert.equal(deviceVerifySucceeded(400, '{"error":"expired_token"}', false), false);
  assert.equal(deviceVerifySucceeded(401, "", false), false);
  assert.equal(deviceVerifySucceeded(200, '{"error":"invalid_user_code"}', false), false);
  assert.equal(deviceVerifySucceeded(200, '{"success":false}', false), false);
  assert.equal(deviceVerifySucceeded(200, "<html>login</html>", false), false);
  assert.equal(deviceVerifySucceeded(302, "", true), false);
  assert.equal(deviceVerifySucceeded(0, "", true), false);
});
