import assert from "node:assert/strict";
import test from "node:test";
import { connectCardReturnPath } from "./oauth-return.ts";

const TOKEN = `gw1.${"a".repeat(40)}.${"b".repeat(43)}`;

test("connect card return path stays on this origin", () => {
  const path = connectCardReturnPath(TOKEN, "ABCD-1234");
  assert.equal(path, `/oauth/complete?txn=${TOKEN}&user_code=ABCD-1234`);
  assert.equal(path.startsWith("/oauth/complete?"), true);
  assert.equal(connectCardReturnPath("https://evil.example/phish", "ABCD-1234"), "");
  assert.equal(connectCardReturnPath("//evil.example", "ABCD-1234"), "");
  assert.equal(connectCardReturnPath(TOKEN, "../ABCD-1234"), "");
  assert.equal(connectCardReturnPath(`${TOKEN}?next=https://evil.example`, "ABCD-1234"), "");
});
