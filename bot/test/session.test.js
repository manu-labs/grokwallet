import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decryptJson, encryptJson, loadSession, saveSession, sessionMode } from "../src/session.js";

test("encrypts a session so the token is not on disk", () => {
  const secret = "test-passphrase";
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
  const blob = encryptJson({ accessToken: token, refreshToken: "refresh-token-value" }, secret);
  const encoded = JSON.stringify(blob);
  assert.equal(encoded.includes(token), false);
  assert.equal(encoded.includes("refresh-token-value"), false);
  assert.deepEqual(decryptJson(blob, secret), {
    accessToken: token,
    refreshToken: "refresh-token-value",
  });
  assert.throws(() => decryptJson(blob, "other-passphrase"));
});

test("writes the session file mode 600 and refuses plaintext tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokwallet-"));
  process.env.GROKWALLET_HOME = dir;
  process.env.GROKWALLET_PASSPHRASE = "correct horse battery";
  saveSession({
    v: 1,
    appId: "app",
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    wallets: [],
    caps: {},
    authorizationKey: "must-not-persist",
    deviceCode: "must-not-persist",
  });
  assert.equal(sessionMode(), 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const loaded = loadSession();
  assert.equal(loaded.accessToken, "access-token-secret");
  assert.equal(loaded.authorizationKey, undefined);
  assert.equal(loaded.deviceCode, undefined);
  const raw = JSON.stringify(loaded);
  assert.equal(raw.includes("must-not-persist"), false);
});
