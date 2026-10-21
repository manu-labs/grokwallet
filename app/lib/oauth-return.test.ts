import assert from "node:assert/strict";
import test from "node:test";
import { connectCardDenyPath, connectCardReturnPath, hasConnectCard } from "./oauth-return.ts";

const TOKEN = `gw1.${"a".repeat(40)}.${"b".repeat(43)}`;
const PROOF = `gw1.${"c".repeat(40)}.${"d".repeat(43)}`;

test("connect card return path stays on this origin and requires an approval proof", () => {
  assert.equal(hasConnectCard(TOKEN, "ABCD-1234"), true);
  const path = connectCardReturnPath(TOKEN, "ABCD-1234", PROOF);
  assert.equal(path, `/oauth/complete?txn=${TOKEN}&user_code=ABCD-1234&proof=${PROOF}`);
  assert.equal(path.startsWith("/oauth/complete?"), true);
  assert.equal(connectCardReturnPath(TOKEN, "ABCD-1234", ""), "");
  assert.equal(connectCardReturnPath("https://evil.example/phish", "ABCD-1234", PROOF), "");
  assert.equal(connectCardReturnPath("//evil.example", "ABCD-1234", PROOF), "");
  assert.equal(connectCardReturnPath(TOKEN, "../ABCD-1234", PROOF), "");
  assert.equal(connectCardReturnPath(`${TOKEN}?next=https://evil.example`, "ABCD-1234", PROOF), "");
  assert.equal(connectCardDenyPath(TOKEN, "ABCD-1234"), `/oauth/complete?txn=${TOKEN}&user_code=ABCD-1234&deny=1`);
  assert.equal(connectCardDenyPath("https://evil.example", "ABCD-1234"), "");
});
