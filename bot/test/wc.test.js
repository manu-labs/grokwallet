import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HELP } from "../src/commands.js";
import { encodeErc20Transfer } from "../src/erc20.js";
import { redact } from "../src/redact.js";
import { readConfig, writeConfig } from "../src/session.js";
import { ipcCall } from "../src/wc/client.js";
import { listen, WalletDaemon } from "../src/wc/daemon.js";
import { walletConnectCommand } from "../src/wc/commands.js";
import { formatProposal, freezeProposal, planSessionApproval } from "../src/wc/plan.js";
import { freezeRequest, prepareWcRequest } from "../src/wc/request.js";
import {
  assertPairingUri,
  classifyMethod,
  originReport,
  payloadHash,
  PUBLIC_WC_PROJECT_ID,
  requireWcProjectId,
} from "../src/wc/safety.js";
import { setCapAmount, setTokenCap } from "../src/policy.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const TOPIC = "ab".repeat(32);
const SYM = "cd".repeat(32);
const URI = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${SYM}`;

function sessionFor(chains = ["eip155:8453"]) {
  const verify = { origin: "https://example.com", validation: "VALID", isScam: false };
  return {
    topic: "session-topic",
    claimedName: "Example",
    claimedUrl: "https://example.com",
    verify,
    origin: originReport(verify, "https://example.com"),
    chains,
    methods: ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction", "wallet_sendCalls"],
    accounts: chains.map((chain) => `${chain}:${ADDRESS}`),
  };
}

function requestEvent({ id = 7, method, params, chainId = "eip155:8453", topic = "session-topic", verify }) {
  return {
    id,
    topic,
    verifyContext: {
      verified: verify || { origin: "https://example.com", validation: "VALID", verifyUrl: "https://verify.walletconnect.org" },
    },
    params: { request: { method, params }, chainId },
  };
}

function proposalEvent(overrides = {}) {
  return {
    id: 4,
    verifyContext: {
      verified: { origin: "https://example.com", validation: "VALID", verifyUrl: "https://verify.walletconnect.org" },
    },
    params: {
      pairingTopic: TOPIC,
      proposer: { publicKey: "ignored", metadata: { name: "Example", url: "https://example.com", description: "", icons: [] } },
      requiredNamespaces: {
        eip155: { chains: ["eip155:8453"], methods: ["personal_sign"], events: ["chainChanged"] },
      },
      optionalNamespaces: {
        eip155: { chains: ["eip155:1", "eip155:999"], methods: ["eth_signTypedData_v4", "eth_sign"], events: [] },
      },
      ...overrides,
    },
  };
}

function fakeClient() {
  const listeners = new Map();
  return {
    on(event, fn) {
      listeners.set(event, fn);
    },
    emit(event, payload) {
      return listeners.get(event)?.(payload);
    },
    async pair() {},
    async approve(params) {
      this.approved = params;
      return {
        topic: "session-topic",
        peer: { metadata: { name: "Example", url: "https://example.com" } },
        namespaces: params.namespaces,
      };
    },
    async reject(params) {
      this.rejected = params;
    },
    async respond(params) {
      this.responses = this.responses || [];
      this.responses.push(params);
    },
    async disconnect(params) {
      this.disconnected = params;
    },
    session: { getAll() { return []; } },
  };
}

function word(address) {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

test("pairing URIs and project ids stay out of errors and the build", () => {
  assert.deepEqual(assertPairingUri(URI), { topic: TOPIC });
  assert.throws(() => assertPairingUri(`not-a-uri-${SYM}`), (error) => {
    assert.equal(error.message.includes(SYM), false);
    assert.equal(error.message.includes(TOPIC), false);
    return true;
  });
  assert.equal(redact(`failed ${URI}`).includes(SYM), false);
  assert.equal(classifyMethod("eth_sign").rawHash, true);
  assert.equal(classifyMethod("eth_signTypedData_v3").rawHash, true);
  assert.equal(classifyMethod("wallet_addEthereumChain").allow, false);
  assert.equal(classifyMethod("personal_sign").allow, true);
  assert.equal(classifyMethod("Personal_Sign").allow, false);
});

test("origin line flags a Verify mismatch and an unverified claim", () => {
  const mismatch = originReport(
    { origin: "https://evil.example", validation: "INVALID", isScam: false },
    "https://example.com",
  );
  assert.equal(mismatch.domain, "MISMATCH");
  assert.equal(mismatch.mismatch, true);
  const unverified = originReport({ origin: "", validation: "UNKNOWN", isScam: false }, "https://example.com/path");
  assert.equal(unverified.domain, "example.com (unverified)");
  assert.equal(unverified.mismatch, false);
  const valid = originReport({ origin: "https://example.com", validation: "VALID", isScam: true }, "https://example.com/app");
  assert.equal(valid.domain, "example.com");
  assert.equal(valid.scam, true);
  const record = freezeProposal({
    ...proposalEvent(),
    verifyContext: { verified: { origin: "https://evil.example", validation: "INVALID" } },
  });
  const text = formatProposal(record, ADDRESS);
  assert.match(text, /^origin: MISMATCH/);
  assert.match(text, /WARNING: verified origin does not match the dapp's claimed URL/);
  assert.match(text, /claimed url \(untrusted\): https:\/\/example.com/);
  assert.match(text, /will grant chains: eip155:8453, eip155:1/);
  assert.match(text, /not granted chains: eip155:999/);
  assert.match(text, /not granted methods: eth_sign/);
});

test("a proposal that requires an unsupported chain or raw-hash method is refused", () => {
  const badChain = freezeProposal(
    proposalEvent({
      requiredNamespaces: { eip155: { chains: ["eip155:999"], methods: ["personal_sign"], events: [] } },
      optionalNamespaces: {},
    }),
  );
  assert.equal(planSessionApproval(badChain, ADDRESS).ok, false);
  const badMethod = freezeProposal(
    proposalEvent({
      requiredNamespaces: { eip155: { chains: ["eip155:8453"], methods: ["eth_sign"], events: [] } },
      optionalNamespaces: {},
    }),
  );
  assert.match(planSessionApproval(badMethod, ADDRESS).reason, /eth_sign/);
  const same = payloadHash({ id: 1, method: "personal_sign" });
  assert.equal(same, payloadHash({ method: "personal_sign", id: 1 }));
  assert.notEqual(same, payloadHash({ id: 1, method: "eth_sign" }));
});

test("personal_sign and typed data keep the existing summary and refuse without --yes", async () => {
  const session = sessionFor();
  const record = freezeRequest(
    requestEvent({ method: "personal_sign", params: ["0x6869", ADDRESS] }),
    session,
  );
  const prepared = await prepareWcRequest(record, { address: ADDRESS, caps: {}, fetchImpl: () => { throw new Error("no rpc"); } });
  assert.match(prepared.summary, /origin: example.com/);
  assert.match(prepared.summary, /method: personal_sign/);
  assert.match(prepared.summary, /---\nhi\n---/);
  assert.equal(prepared.action.body.params.message, "hi");
  let rpc = false;
  let responded = false;
  await assert.rejects(
    () =>
      walletConnectCommand(["approve", "7"], {}, {
        call: async (message) => {
          if (message.op === "getRequest") return record;
          responded = true;
          return {};
        },
        loadSession: () => ({ wallets: [{ chainType: "ethereum", address: ADDRESS, id: "wallet" }], caps: {} }),
        rpc: async () => {
          rpc = true;
        },
        stdout: () => {},
      }),
    (error) => {
      assert.equal(error.exitCode, 2);
      return true;
    },
  );
  assert.equal(rpc, false);
  assert.equal(responded, false);

  const typed = freezeRequest(
    requestEvent({
      id: 8,
      method: "eth_signTypedData_v4",
      params: [
        ADDRESS,
        {
          domain: { name: "Example", version: "1", chainId: "0x66eee", verifyingContract: OTHER },
          types: { Mail: [{ name: "note", type: "string" }] },
          primaryType: "Mail",
          message: { note: "hello" },
        },
      ],
    }),
    session,
  );
  const typedPrepared = await prepareWcRequest(typed, { address: ADDRESS, caps: {} });
  assert.match(typedPrepared.summary, /primaryType: Mail/);
  assert.match(typedPrepared.summary, /0x66eee \(421614\)/);
  assert.equal(typedPrepared.action.body.method, "eth_signTypedData_v4");
  assert.equal(typedPrepared.action.body.params.typed_data.domain.chainId, 421614);
});

test("approving one request id cannot sign a different payload", async () => {
  const session = sessionFor();
  const first = freezeRequest(requestEvent({ id: 1, method: "personal_sign", params: ["hello", ADDRESS] }), session);
  const second = freezeRequest(requestEvent({ id: 2, method: "personal_sign", params: ["bye", ADDRESS] }), session);
  let signed = "";
  let responded = null;
  await walletConnectCommand(["approve", "1"], { yes: true }, {
    call: async (message) => {
      if (message.op === "getRequest") return message.key === second.key ? second : first;
      if (message.op === "respond") {
        responded = message;
        return { id: 1 };
      }
      throw new Error(message.op);
    },
    loadSession: () => ({ wallets: [{ chainType: "ethereum", address: ADDRESS, id: "wallet" }], caps: {} }),
    rpc: async (_session, _walletId, body) => {
      signed = body.params.message;
      return { data: { signature: "0xsig" } };
    },
    stdout: () => {},
  });
  assert.equal(signed, "hello");
  assert.equal(responded.payloadHash, first.payloadHash);
  assert.equal(responded.result, "0xsig");

  let calls = 0;
  let rpc = false;
  await assert.rejects(
    () =>
      walletConnectCommand(["approve", String(first.id)], { yes: true }, {
        call: async (message) => {
          if (message.op === "getRequest") {
            calls += 1;
            if (calls === 1) return first;
            return { ...first, payloadHash: "changed", params: ["swapped", ADDRESS] };
          }
          rpc = true;
          return {};
        },
        loadSession: () => ({ wallets: [{ chainType: "ethereum", address: ADDRESS, id: "wallet" }], caps: {} }),
        rpc: async () => {
          rpc = true;
        },
        stdout: () => {},
      }),
    /request changed/,
  );
  assert.equal(rpc, false);
});

test("WalletConnect sends use the ETH cap and the token cap", async () => {
  const previous = process.env.GROKWALLET_BASE_RPC;
  process.env.GROKWALLET_BASE_RPC = "https://rpc.example.test";
  try {
    const session = sessionFor();
    const caps = setCapAmount({}, "eth", "0.05");
    const over = freezeRequest(
      requestEvent({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: OTHER, value: "0xde0b6b3a7640000" }],
      }),
      session,
    );
    await assert.rejects(
      () => prepareWcRequest(over, { address: ADDRESS, caps, fetchImpl: () => { throw new Error("no rpc"); } }),
      /ETH spend cap/,
    );
    const data = encodeErc20Transfer(OTHER, 1_000_000n);
    const tokenCaps = setTokenCap(caps, `base:${TOKEN}=10`);
    let fetched = 0;
    const transfer = freezeRequest(
      requestEvent({
        id: 9,
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: TOKEN, value: "0x0", data, gas: "0x5208" }],
      }),
      session,
    );
    const prepared = await prepareWcRequest(transfer, {
      address: ADDRESS,
      caps: tokenCaps,
      fetchImpl: () => {
        fetched += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ result: `0x${(6).toString(16).padStart(64, "0")}` }),
        });
      },
    });
    assert.ok(fetched > 0);
    assert.match(prepared.summary, /token cap: 10/);
    assert.match(prepared.summary, /dapp gas and nonce fields are ignored/);
    assert.equal(prepared.action.body.params.transaction.to, TOKEN);
    assert.equal(prepared.action.body.params.transaction.data, data);
    await assert.rejects(
      () =>
        prepareWcRequest(transfer, {
          address: ADDRESS,
          caps,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ result: `0x${(6).toString(16).padStart(64, "0")}` }),
          }),
        }),
      /no spend cap/,
    );
    const fromData = `0x23b872dd${word(ADDRESS)}${word(OTHER)}${(1_000_000n).toString(16).padStart(64, "0")}`;
    const transferFrom = freezeRequest(
      requestEvent({
        id: 10,
        method: "wallet_sendCalls",
        params: [{ from: ADDRESS, chainId: "0x2105", atomicRequired: true, calls: [{ to: TOKEN, value: "0x0", data: fromData }] }],
      }),
      session,
    );
    const batch = await prepareWcRequest(transferFrom, {
      address: ADDRESS,
      caps: tokenCaps,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: `0x${(6).toString(16).padStart(64, "0")}` }),
      }),
    });
    assert.match(batch.summary, /transferFrom owner: 0x1111111111111111111111111111111111111111/);
    assert.equal(batch.action.interpret, "calls");
    const multi = freezeRequest(
      requestEvent({
        id: 11,
        method: "wallet_sendCalls",
        params: [{ from: ADDRESS, chainId: "0x2105", calls: [{ to: OTHER, value: "0x1" }, { to: OTHER, value: "0x1" }] }],
      }),
      session,
    );
    await assert.rejects(() => prepareWcRequest(multi, { address: ADDRESS, caps }), /more than one call/);
  } finally {
    if (previous === undefined) delete process.env.GROKWALLET_BASE_RPC;
    else process.env.GROKWALLET_BASE_RPC = previous;
  }
});

test("the daemon keeps proposal and request identity and rejects raw-hash methods", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gwc-"));
  const client = fakeClient();
  const daemon = new WalletDaemon(client);
  const server = await listen(daemon, join(dir, "s"));
  try {
    assert.deepEqual(await ipcCall(join(dir, "s"), { op: "ping" }), { ok: true });
    const pending = ipcCall(join(dir, "s"), { op: "pair", uri: URI, timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.emit("session_proposal", proposalEvent());
    const proposal = await pending;
    assert.equal(proposal.id, 4);
    assert.equal(proposal.origin.domain, "example.com");
    const stored = await ipcCall(join(dir, "s"), {
      op: "approveProposal",
      id: proposal.id,
      payloadHash: proposal.payloadHash,
      address: ADDRESS,
    });
    assert.equal(stored.topic, "session-topic");
    assert.equal(client.approved.namespaces.eip155.chains.includes("eip155:999"), false);
    assert.equal(client.approved.namespaces.eip155.methods.includes("eth_sign"), false);
    const first = requestEvent({ id: 7, method: "personal_sign", params: ["hello", ADDRESS] });
    await client.emit("session_request", first);
    const swapped = requestEvent({ id: 7, method: "personal_sign", params: ["swapped", ADDRESS] });
    await client.emit("session_request", swapped);
    const listed = await ipcCall(join(dir, "s"), { op: "requests" });
    assert.equal(listed.requests.length, 1);
    assert.deepEqual(listed.requests[0].params, ["hello", ADDRESS]);
    assert.match(listed.rejections.at(-1).reason, /duplicate request id/);
    await assert.rejects(
      () =>
        ipcCall(join(dir, "s"), {
          op: "respond",
          key: listed.requests[0].key,
          payloadHash: "nope",
          result: "0xsig",
        }),
      /request changed/,
    );
    assert.equal(client.responses, undefined);
    await ipcCall(join(dir, "s"), {
      op: "respond",
      key: listed.requests[0].key,
      payloadHash: listed.requests[0].payloadHash,
      result: "0xsig",
    });
    assert.equal(client.responses[0].response.result, "0xsig");
    await client.emit("session_request", requestEvent({ id: 9, method: "eth_sign", params: [ADDRESS, `0x${"11".repeat(32)}`] }));
    const after = await ipcCall(join(dir, "s"), { op: "requests" });
    assert.equal(after.requests.length, 0);
    assert.equal(client.responses.at(-1).response.error.code, 5101);
    assert.match(client.responses.at(-1).response.error.message, /Raw hash signing is refused/);
    assert.match(after.rejections.at(-1).reason, /raw hash signing is refused/);
    await ipcCall(join(dir, "s"), { op: "disconnect", topic: "session-topic" });
    assert.equal(client.disconnected.reason.code, 6000);
    const sessions = await ipcCall(join(dir, "s"), { op: "sessions" });
    assert.equal(sessions.length, 0);
    client.pair = async () => {
      throw new Error(`relay rejected ${URI}`);
    };
    await assert.rejects(() => ipcCall(join(dir, "s"), { op: "pair", uri: URI, timeoutMs: 1000 }), (error) => {
      assert.equal(String(error.message).includes(SYM), false);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("project id defaults to the public id, then config, then env", () => {
  const previousHome = process.env.GROKWALLET_HOME;
  const previousId = process.env.GROKWALLET_WC_PROJECT_ID;
  const dir = mkdtempSync(join(tmpdir(), "gwc-home-"));
  process.env.GROKWALLET_HOME = dir;
  delete process.env.GROKWALLET_WC_PROJECT_ID;
  try {
    assert.equal(PUBLIC_WC_PROJECT_ID, "bdfd32cda68514c6f0300c6f7a80320d");
    assert.equal(requireWcProjectId(), PUBLIC_WC_PROJECT_ID);
    writeConfig({ appId: "cmvh5kyg300qy0gl01ww23ixy", wcProjectId: "cd".repeat(16) });
    writeConfig({ appId: "cmvh5kyg300qy0gl01ww23ixy" });
    assert.equal(readConfig().wcProjectId, "cd".repeat(16));
    assert.equal(readConfig().appId, "cmvh5kyg300qy0gl01ww23ixy");
    assert.equal(requireWcProjectId(), "cd".repeat(16));
    process.env.GROKWALLET_WC_PROJECT_ID = "ab".repeat(16);
    assert.equal(requireWcProjectId(), "ab".repeat(16));
    process.env.GROKWALLET_WC_PROJECT_ID = "not-a-project-id";
    assert.throws(() => requireWcProjectId(), /built-in public project id/);
    delete process.env.GROKWALLET_WC_PROJECT_ID;
    writeConfig({ wcProjectId: "short" });
    assert.throws(() => requireWcProjectId(), /built-in public project id/);
  } finally {
    if (previousHome === undefined) delete process.env.GROKWALLET_HOME;
    else process.env.GROKWALLET_HOME = previousHome;
    if (previousId === undefined) delete process.env.GROKWALLET_WC_PROJECT_ID;
    else process.env.GROKWALLET_WC_PROJECT_ID = previousId;
  }
});

test("help, the wallet-ops skill, and the diff wording stay generic", () => {
  assert.match(HELP, /wc pair \(<wc-uri>/);
  assert.match(HELP, /wc approve <id> \[--dry-run\] --yes/);
  assert.match(HELP, /dashboard\.reown\.com/);
  assert.match(HELP, /public WalletConnect project id is built in/);
  const templatePath = join(import.meta.dirname, "../../template/grokwallet.json");
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  const ops = template.skills.find((skill) => skill.name === "wallet-ops");
  const started = template.skills.find((skill) => skill.name === "getting-started");
  assert.match(ops.content, /wc approve <id> --yes/);
  assert.match(ops.content, /MISMATCH/);
  assert.match(ops.content, /Do not print tokens/);
  assert.match(started.content, /show it in chat/);
  assert.match(started.content, /Never show or ask for the device code/);
  assert.doesNotMatch(started.content, /Do not show the approval link or the user code/);
  assert.match(started.content, /public WalletConnect project id is built in/);
  assert.ok(Buffer.byteLength(ops.content) < 6500);
  assert.ok(Buffer.byteLength(started.content) < 6000);
  const roots = ["bot/src", "bot/test", "template", "docs", "README.md", "SECURITY.md", ".env.example"];
  const files = [];
  for (const root of roots) {
    const path = join(import.meta.dirname, "../..", root);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  const banned = ["op", "al"].join("");
  for (const file of files) {
    assert.equal(readFileSync(file, "utf8").toLowerCase().includes(banned), false, file);
  }
});

test("sign client module loads", async () => {
  const { SignClient } = await import("@walletconnect/sign-client");
  assert.equal(typeof SignClient.init, "function");
});

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
}
