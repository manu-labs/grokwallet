import assert from "node:assert/strict";
import test from "node:test";
import { assertWithinCap, policyDocuments, setCapAmount } from "../src/policy.js";
import { base58Decode, base58Encode, buildSolTransfer, SYSTEM_PROGRAM } from "../src/solana.js";
import { formatUnits, parseUnits } from "../src/units.js";
import { formatLoginPrompt, pollDeviceToken, DEVICE_GRANT } from "../src/privy.js";
import { connectorUrlForUserCode } from "../src/home.js";
import { parseArgs } from "../src/cli.js";

test("parses ETH and SOL amounts without floating point", () => {
  assert.equal(parseUnits("0.01", 18), 10000000000000000n);
  assert.equal(parseUnits("1", 9), 1000000000n);
  assert.equal(formatUnits(10000000000000000n, 18), "0.01");
  assert.throws(() => parseUnits("0.0000000000000000001", 18));
  assert.throws(() => parseUnits("-1", 18));
});

test("system program and sol transfer wire format", () => {
  assert.equal(base58Encode(Buffer.alloc(32)), SYSTEM_PROGRAM);
  assert.ok(base58Decode(SYSTEM_PROGRAM).equals(Buffer.alloc(32)));
  const sample = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
  assert.ok(base58Decode(base58Encode(sample)).equals(sample));
  const from = base58Encode(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
  const to = base58Encode(Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i)));
  const blockhash = base58Encode(Buffer.from(Array.from({ length: 32 }, () => 7)));
  const raw = Buffer.from(buildSolTransfer({ from, to, lamports: 5n, recentBlockhash: blockhash }), "base64");
  assert.equal(raw[0], 1);
  assert.ok(raw.subarray(1, 65).every((byte) => byte === 0));
  const message = raw.subarray(65);
  assert.deepEqual([...message.subarray(0, 3)], [1, 0, 1]);
  assert.equal(message[3], 3);
  assert.ok(message.subarray(4 + 64, 4 + 96).every((byte) => byte === 0));
  const data = message.subarray(message.length - 12);
  assert.equal(data.readUInt32LE(0), 2);
  assert.equal(data.readBigUInt64LE(4), 5n);
});

test("local spend cap blocks an over-cap send and prints a Privy policy document", () => {
  let caps = setCapAmount({}, "eth", "0.01");
  caps = setCapAmount(caps, "sol", "0.5");
  assert.doesNotThrow(() => assertWithinCap(caps, "eth", parseUnits("0.01", 18)));
  assert.throws(() => assertWithinCap(caps, "eth", parseUnits("0.02", 18)));
  const docs = policyDocuments(caps);
  assert.equal(docs[0].rules[0].conditions[0].value, "0x2386f26fc10000");
  assert.equal(docs[1].rules[0].conditions[0].field, "Transfer.lamports");
  assert.equal(docs[1].rules[0].conditions[0].value, "500000000");
});

test("login stdout contains the user code and connector URL, not the device code", () => {
  const deviceCode = "device-secret-value";
  const connectorUrl = connectorUrlForUserCode("ABCD-1234");
  assert.equal(connectorUrl, "https://grokwallet.fun/mcp/c/ABCD-1234");
  assert.equal(connectorUrlForUserCode("not a code"), "");
  assert.equal(connectorUrlForUserCode("../ABCD-1234"), "");
  const text = formatLoginPrompt({
    verificationUriComplete: "https://grokwallet.fun/?user_code=ABCD-1234",
    userCode: "ABCD-1234",
    connectorUrl,
    expiresInSeconds: 600,
    now: Date.parse("2026-10-21T05:00:00.000Z"),
  });
  assert.match(text, /verification_uri_complete: https:\/\/grokwallet\.fun\/\?user_code=ABCD-1234\n/);
  assert.match(text, /user_code: ABCD-1234\n/);
  assert.match(text, /connector_url: https:\/\/grokwallet\.fun\/mcp\/c\/ABCD-1234\n/);
  assert.match(text, /expires_in: 600\n/);
  assert.match(text, /expires_at: 2026-10-21T05:10:00.000Z\n/);
  assert.equal(text.includes(deviceCode), false);
});

test("device poll uses the RFC 8628 grant and honors slow_down", async () => {
  const calls = [];
  let now = 0;
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "slow_down" }),
      };
    }
    if (calls.length === 2) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "authorization_pending" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "a", refresh_token: "b", expires_in: 900 }),
    };
  };
  const sleeps = [];
  const tokens = await pollDeviceToken({
    appId: "app",
    deviceCode: "device-secret-value",
    intervalSeconds: 5,
    expiresInSeconds: 600,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
  });
  assert.equal(tokens.access_token, "a");
  assert.equal(calls[0].grant_type, DEVICE_GRANT);
  assert.equal(calls[0].device_code, "device-secret-value");
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [5000, 10000, 10000]);
});

test("device poll keeps waiting through authorization_pending for the full expiry window", async () => {
  let now = 0;
  const sleeps = [];
  let polls = 0;
  await assert.rejects(
    () =>
      pollDeviceToken({
        appId: "app",
        deviceCode: "device-secret-value",
        intervalSeconds: 5,
        expiresInSeconds: 12,
        fetchImpl: async () => {
          polls += 1;
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "authorization_pending" }),
          };
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        now: () => now,
      }),
    /timed out waiting for approval/,
  );
  assert.ok(polls >= 2);
  assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) >= 12000);
});

test("argument parser keeps --yes and the message text", () => {
  const parsed = parseArgs(["sign-message", "--chain", "ethereum", "--message", "hello -- there", "--yes"]);
  assert.equal(parsed.command, "sign-message");
  assert.equal(parsed.flags.chain, "ethereum");
  assert.equal(parsed.flags.message, "hello -- there");
  assert.equal(parsed.flags.yes, true);
});
