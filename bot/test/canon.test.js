import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { buildSignaturePayload, canonicalizePayload, signPayload, verifyPayload } from "../src/canon.js";

test("canonicalizes the authorization payload with sorted keys and the empty-body rule", () => {
  const payload = buildSignaturePayload({
    method: "POST",
    url: "https://auth.privy.io/api/oauth/v2/wallets/wallet_abc/rpc",
    appId: "app-1",
    body: {
      params: { message: "Hello", encoding: "utf-8" },
      method: "personal_sign",
      chain_type: "ethereum",
    },
  });
  assert.equal(
    canonicalizePayload(payload),
    '{"body":{"chain_type":"ethereum","method":"personal_sign","params":{"encoding":"utf-8","message":"Hello"}},"headers":{"privy-app-id":"app-1"},"method":"POST","url":"https://auth.privy.io/api/oauth/v2/wallets/wallet_abc/rpc","version":1}',
  );

  const reversed = buildSignaturePayload({
    method: "POST",
    url: "https://auth.privy.io/api/oauth/v2/wallets/wallet_abc/rpc",
    appId: "app-1",
    requestExpiry: "1700000000000",
    idempotencyKey: "idem-1",
    body: { method: "personal_sign", chain_type: "ethereum", params: { encoding: "utf-8", message: "Hello" } },
  });
  assert.equal(
    canonicalizePayload(reversed),
    '{"body":{"chain_type":"ethereum","method":"personal_sign","params":{"encoding":"utf-8","message":"Hello"}},"headers":{"privy-app-id":"app-1","privy-idempotency-key":"idem-1","privy-request-expiry":"1700000000000"},"method":"POST","url":"https://auth.privy.io/api/oauth/v2/wallets/wallet_abc/rpc","version":1}',
  );

  const empty = buildSignaturePayload({
    method: "POST",
    url: "https://api.privy.io/v1/wallets",
    appId: "app-1",
    body: {},
  });
  assert.equal(empty.body, "");
  assert.equal(
    canonicalizePayload(empty),
    '{"body":"","headers":{"privy-app-id":"app-1"},"method":"POST","url":"https://api.privy.io/v1/wallets","version":1}',
  );
});

test("ECDSA P-256 signature verifies over the canonical payload", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const payload = buildSignaturePayload({
    method: "POST",
    url: "https://auth.privy.io/api/oauth/v2/wallets/wallet_abc/rpc",
    appId: "app-1",
    body: { method: "personal_sign", params: { message: "Hello", encoding: "utf-8" } },
  });
  const signature = signPayload(payload, `wallet-auth:${pkcs8}`);
  assert.equal(verifyPayload(payload, signature, pkcs8), true);
  payload.body.params.message = "changed";
  assert.equal(verifyPayload(payload, signature, pkcs8), false);
});
