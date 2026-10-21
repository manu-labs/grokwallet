import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHAINS } from "../src/balances.js";
import { parseArgs } from "../src/cli.js";
import { HELP, signTypedData } from "../src/commands.js";
import { saveSession } from "../src/session.js";
import { buildTypedDataBody, loadTypedData, normalizeTypedData, summarizeTypedData } from "../src/typed-data.js";

const APPROVE_AGENT = {
  types: {
    "HyperliquidTransaction:ApproveAgent": [
      { name: "hyperliquidChain", type: "string" },
      { name: "agentAddress", type: "address" },
      { name: "agentName", type: "string" },
      { name: "nonce", type: "uint64" },
    ],
  },
  primaryType: "HyperliquidTransaction:ApproveAgent",
  domain: {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: "0x66eee",
    verifyingContract: "0x0000000000000000000000000000000000000000",
  },
  message: {
    hyperliquidChain: "Testnet",
    signatureChainId: "0x66eee",
    agentAddress: "0x1111111111111111111111111111111111111111",
    agentName: "",
    nonce: 1,
  },
};

test("Hyperliquid approveAgent keeps a domain chainId that is not the wallet chain", () => {
  assert.equal(Object.values(CHAINS).some((chain) => chain.chainId === 1337), false);
  const typed = normalizeTypedData(APPROVE_AGENT);
  assert.equal(typed.primaryType, "HyperliquidTransaction:ApproveAgent");
  assert.equal(typed.domain.chainId, 421614);
  assert.equal(typed.chainIdText, "0x66eee (421614)");
  assert.equal(Object.hasOwn(typed.types, "EIP712Domain"), false);
  const summary = summarizeTypedData(typed, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.match(summary, /primaryType: HyperliquidTransaction:ApproveAgent/);
  assert.match(summary, /domain\.chainId: 0x66eee \(421614\)/);
  assert.match(summary, /domain\.verifyingContract: 0x0000000000000000000000000000000000000000/);
  assert.match(summary, /domain\.name: HyperliquidSignTransaction/);
  assert.match(summary, /message\.signatureChainId: 0x66eee/);
  assert.match(summary, /"hyperliquidChain": "Testnet"/);
  const body = buildTypedDataBody(typed);
  assert.equal(body.method, "eth_signTypedData_v4");
  assert.equal(body.chain_type, "ethereum");
  assert.equal(Object.hasOwn(body, "caip2"), false);
  assert.equal(body.params.typed_data.primary_type, "HyperliquidTransaction:ApproveAgent");
  assert.equal(body.params.typed_data.domain.chainId, 421614);
  const l1 = normalizeTypedData({
    ...APPROVE_AGENT,
    domain: { ...APPROVE_AGENT.domain, chainId: 1337 },
  });
  assert.equal(l1.domain.chainId, 1337);
  assert.equal(l1.chainIdText, "0x539 (1337)");
});

test("typed data accepts primary_type and a JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokwallet-typed-"));
  const file = join(dir, "agent.json");
  const payload = {
    types: APPROVE_AGENT.types,
    primary_type: APPROVE_AGENT.primaryType,
    domain: { ...APPROVE_AGENT.domain, chainId: 421614 },
    message: APPROVE_AGENT.message,
  };
  writeFileSync(file, `\uFEFF${JSON.stringify(payload)}\n`);
  const typed = loadTypedData(`@${file}`, { readFile: (path) => readFileSync(path, "utf8") });
  assert.equal(typed.primaryType, "HyperliquidTransaction:ApproveAgent");
  assert.throws(() =>
    normalizeTypedData({ ...payload, primaryType: "Other", primary_type: APPROVE_AGENT.primaryType }),
  );
});

test("sign-typed-data prints the summary before any Privy call and refuses without --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokwallet-session-"));
  const previous = {
    home: process.env.GROKWALLET_HOME,
    pass: process.env.GROKWALLET_PASSPHRASE,
    auth: process.env.GROKWALLET_AUTH_BASE,
  };
  process.env.GROKWALLET_HOME = dir;
  process.env.GROKWALLET_PASSPHRASE = "test-passphrase";
  process.env.GROKWALLET_AUTH_BASE = "https://auth.example.test";
  const calls = [];
  const writes = [];
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), stdout: writes.join("") });
    return { ok: false, status: 500, json: async () => ({ error: "nope" }) };
  };
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    saveSession({
      v: 1,
      appId: "cmvh5kyg300qy0gl01ww23ixy",
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
      accessExpiresAt: Date.now() + 3_600_000,
      wallets: [
        {
          id: "wallet-1",
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          chainType: "ethereum",
        },
      ],
      caps: { ethWei: null, solLamports: null },
    });
    const flags = { chain: "ethereum", data: JSON.stringify(APPROVE_AGENT) };
    await assert.rejects(
      () => signTypedData(flags),
      (error) => error.exitCode === 2 && /refusing without --yes/.test(error.message),
    );
    assert.equal(calls.length, 0);
    const preview = writes.join("");
    assert.match(preview, /domain\.chainId: 0x66eee \(421614\)/);
    assert.match(preview, /primaryType: HyperliquidTransaction:ApproveAgent/);
    assert.equal(preview.includes("access-token-value"), false);
    assert.equal(preview.includes("refresh-token-value"), false);
    writes.length = 0;
    await assert.rejects(() => signTypedData({ ...flags, yes: true }));
    assert.equal(calls.length, 1);
    assert.match(calls[0].stdout, /domain\.chainId: 0x66eee \(421614\)/);
    assert.match(calls[0].url, /\/wallets\/wallet-1\/rpc|\/wallets\/authenticate/);
    assert.equal(calls[0].stdout.includes("access-token-value"), false);
  } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    restoreEnv(previous);
  }
});

test("help lists typed data, erc20, and arbitrum", () => {
  assert.match(HELP, /sign-typed-data --chain ethereum --data <json\|@file> --yes/);
  assert.match(HELP, /send-erc20/);
  assert.match(HELP, /arbitrum-sepolia/);
  assert.match(HELP, /--message-file/);
  const parsed = parseArgs([
    "cap",
    "set",
    "--token",
    "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831=10",
    "--token",
    "base:0x0000000000000000000000000000000000000001=2",
    "--yes",
  ]);
  assert.deepEqual(parsed.flags.token, [
    "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831=10",
    "base:0x0000000000000000000000000000000000000001=2",
  ]);
  assert.equal(parsed.flags.yes, true);
});

function restoreEnv(previous) {
  for (const [key, envName] of [
    ["home", "GROKWALLET_HOME"],
    ["pass", "GROKWALLET_PASSPHRASE"],
    ["auth", "GROKWALLET_AUTH_BASE"],
  ]) {
    if (previous[key] === undefined) delete process.env[envName];
    else process.env[envName] = previous[key];
  }
}
