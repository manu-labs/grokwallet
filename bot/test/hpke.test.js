import assert from "node:assert/strict";
import test from "node:test";
import { createHpkeRecipient, sealForRecipient } from "../src/hpke.js";

test("HPKE BASE round trip uses the same suite Privy documents", async () => {
  const recipient = await createHpkeRecipient();
  const spki = Buffer.from(recipient.publicKeyBase64, "base64");
  assert.equal(spki.length, 91);
  const sealed = await sealForRecipient(recipient.rawPublicKey, Buffer.from("wallet-auth:test-key", "utf8"));
  const opened = await recipient.decrypt(sealed.encapsulatedKey, sealed.ciphertext);
  assert.equal(opened, "wallet-auth:test-key");
});
