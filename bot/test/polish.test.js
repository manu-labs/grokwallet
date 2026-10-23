import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { balance, sendEth, signMessage } from "../src/commands.js";
import { doctor, nodeSupported } from "../src/doctor.js";
import { changelogSection } from "../src/release-notes.js";
import { DryRun, redact } from "../src/redact.js";
import { saveSession } from "../src/session.js";
import { hashInstallFile, verifyInstall, writeManifest } from "../src/verify.js";
import { ipcCall } from "../src/wc/client.js";
import { walletConnectCommand } from "../src/wc/commands.js";
import { listen, WalletDaemon } from "../src/wc/daemon.js";
import { openPasteServer } from "../src/wc/paste.js";
import { freezeProposal } from "../src/wc/plan.js";
import { formatRequest, freezeRequest } from "../src/wc/request.js";
import { originReport } from "../src/wc/safety.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x3333333333333333333333333333333333333333";
const TOPIC = "ab".repeat(32);
const SYM = "cd".repeat(32);
const URI = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${SYM}`;

function abiUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiString(text) {
  const bytes = Buffer.from(text, "utf8");
  const offset = abiUint(32).slice(2);
  const length = abiUint(bytes.length).slice(2);
  const data = bytes.toString("hex").padEnd(64, "0");
  return `0x${offset}${length}${data}`;
}

function capture() {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function loggedInHome(caps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gwc-polish-"));
  process.env.GROKWALLET_HOME = dir;
  process.env.GROKWALLET_PASSPHRASE = "correct horse battery";
  saveSession({
    v: 1,
    appId: "cmvh5kyg300qy0gl01ww23ixy",
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    wallets: [
      { chainType: "ethereum", address: ADDRESS, id: "eth-wallet" },
      { chainType: "solana", address: "So11111111111111111111111111111111111111112", id: "sol-wallet" },
    ],
    caps,
  });
  return dir;
}

function sessionRecord() {
  const verify = { origin: "https://example.com", validation: "VALID", isScam: false };
  return {
    topic: "session-topic",
    claimedName: "Example",
    claimedUrl: "https://example.com",
    verify,
    origin: originReport(verify, "https://example.com"),
    chains: ["eip155:8453"],
    methods: ["personal_sign"],
    accounts: [`eip155:8453:${ADDRESS}`],
  };
}

function requestEvent(extra = {}) {
  return {
    id: extra.id || 7,
    topic: "session-topic",
    expiry: extra.expiry,
    verifyContext: {
      verified: { origin: "https://example.com", validation: "VALID", verifyUrl: "https://verify.walletconnect.org" },
    },
    params: { request: { method: "personal_sign", params: ["hello", ADDRESS] }, chainId: "eip155:8453" },
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
    async approve() {
      return { topic: "session-topic", peer: {}, namespaces: {} };
    },
    async reject() {},
    async respond() {},
    async disconnect(params) {
      this.disconnected = params;
    },
    session: { getAll() { return []; } },
  };
}

test("node support, doctor, and secret redaction", async () => {
  assert.equal(nodeSupported("22.23.0"), true);
  assert.equal(nodeSupported("22.24.1"), true);
  assert.equal(nodeSupported("22.22.9"), false);
  assert.equal(nodeSupported("23.0.0"), false);
  const previousHome = process.env.GROKWALLET_HOME;
  const previousPass = process.env.GROKWALLET_PASSPHRASE;
  const dir = mkdtempSync(join(tmpdir(), "gwc-doctor-"));
  process.env.GROKWALLET_HOME = dir;
  process.env.GROKWALLET_PASSPHRASE = "correct horse battery";
  const lines = [];
  try {
    const code = await doctor({
      nodeVersion: "20.0.0",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: "0x1" }) }),
      stdout: { write: (chunk) => lines.push(String(chunk)) },
    });
    const text = lines.join("");
    assert.equal(code, 1);
    assert.match(text, /fail node: 20\.0\.0/);
    assert.match(text, /fix: Install Node 22\.23\.x/);
    assert.match(text, /fail login: not logged in/);
    assert.match(text, /fix: Run: grokwallet login/);
    assert.match(text, /ok rpc ethereum: ethereum\.publicnode\.com/);
    assert.match(text, /ok rpc solana: api\.mainnet-beta\.solana\.com/);
    assert.equal(text.includes("correct horse battery"), false);
    assert.equal(text.includes("access-token-secret"), false);
    assert.equal(redact("leak correct horse battery"), "leak [redacted]");
  } finally {
    if (previousHome === undefined) delete process.env.GROKWALLET_HOME;
    else process.env.GROKWALLET_HOME = previousHome;
    if (previousPass === undefined) delete process.env.GROKWALLET_PASSPHRASE;
    else process.env.GROKWALLET_PASSPHRASE = previousPass;
  }
});

test("verify checks the bundled manifest and --version prints the package version", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-manifest-"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: "0.2.6" })}\n`);
  writeFileSync(join(root, "hello.txt"), "hello\n");
  writeManifest(root);
  assert.equal(verifyInstall(root), 2);
  writeFileSync(join(root, "hello.txt"), "changed\n");
  assert.throws(() => verifyInstall(root), /changed hello\.txt/);
  const fresh = mkdtempSync(join(tmpdir(), "gwc-nomanifest-"));
  assert.throws(() => verifyInstall(fresh), /no SHA256SUMS manifest/);
  assert.equal(hashInstallFile(root, "hello.txt"), hashInstallFile(root, "hello.txt"));
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    assert.equal(await main(["--version"]), 0);
  } finally {
    process.stdout.write = original;
  }
  assert.match(chunks.join(""), /^0\.2\.7\n$/);
});

test("dry-run prints the cap result and does not sign", async () => {
  const previousHome = process.env.GROKWALLET_HOME;
  const previousPass = process.env.GROKWALLET_PASSPHRASE;
  loggedInHome({ ethWei: "50000000000000000", solLamports: null, tokens: {} });
  const out = capture();
  try {
    await assert.rejects(
      () => sendEth({ to: ADDRESS, amount: "1", chain: "ethereum", "dry-run": true }),
      /exceeds the ETH spend cap/,
    );
    await assert.rejects(
      () => sendEth({ to: ADDRESS, amount: "0.01", chain: "ethereum", "dry-run": true }),
      (error) => error instanceof DryRun,
    );
    await assert.rejects(
      () => signMessage({ chain: "ethereum", message: "hello", "dry-run": true }),
      (error) => error instanceof DryRun,
    );
    const text = out.text();
    assert.match(text, /send 0\.01 ETH on ethereum/);
    assert.match(text, /dry-run: nothing was signed or broadcast/);
    assert.match(text, /sign ethereum message/);
    assert.equal(text.includes("access-token-secret"), false);
  } finally {
    out.restore();
    if (previousHome === undefined) delete process.env.GROKWALLET_HOME;
    else process.env.GROKWALLET_HOME = previousHome;
    if (previousPass === undefined) delete process.env.GROKWALLET_PASSPHRASE;
    else process.env.GROKWALLET_PASSPHRASE = previousPass;
  }
});

test("balance prints token name and symbol when the contract returns them", async () => {
  const previousHome = process.env.GROKWALLET_HOME;
  const previousPass = process.env.GROKWALLET_PASSPHRASE;
  loggedInHome();
  const out = capture();
  const fetchImpl = async (_url, options) => {
    const data = JSON.parse(options.body).params[0].data;
    let result = abiUint(1_500_000);
    if (data === "0x313ce567") result = abiUint(6);
    else if (data === "0x95d89b41") result = abiString("USDC");
    else if (data === "0x06fdde03") result = abiString("USD Coin");
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  try {
    await balance({ chain: "base", token: TOKEN }, fetchImpl);
    assert.match(out.text(), /base 0x1111111111111111111111111111111111111111 1\.5 USDC \(USD Coin\) token 0x3333333333333333333333333333333333333333/);
  } finally {
    out.restore();
    if (previousHome === undefined) delete process.env.GROKWALLET_HOME;
    else process.env.GROKWALLET_HOME = previousHome;
    if (previousPass === undefined) delete process.env.GROKWALLET_PASSPHRASE;
    else process.env.GROKWALLET_PASSPHRASE = previousPass;
  }
});

test("wc pair --from-file and the paste page validate the URI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gwc-uri-"));
  const good = join(dir, "uri.txt");
  const bad = join(dir, "bad.txt");
  writeFileSync(good, `\n# comment\n${URI}\n`);
  writeFileSync(bad, `nope symKey=${SYM}\n`);
  const session = {
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    wallets: [{ chainType: "ethereum", address: ADDRESS, id: "eth-wallet" }],
    caps: {},
  };
  let paired = "";
  const proposal = freezeProposal({
    id: 4,
    verifyContext: { verified: { origin: "https://example.com", validation: "VALID" } },
    params: {
      proposer: { metadata: { name: "Example", url: "https://example.com" } },
      requiredNamespaces: { eip155: { chains: ["eip155:8453"], methods: ["personal_sign"], events: ["chainChanged"] } },
      optionalNamespaces: {},
    },
  });
  await walletConnectCommand(["pair"], { "from-file": good }, {
    call: async (message) => {
      paired = message.uri;
      return proposal;
    },
    loadSession: () => session,
    stdout: () => {},
  });
  assert.equal(paired, URI);
  await assert.rejects(
    () => walletConnectCommand(["pair"], { "from-file": bad }, {
      call: async () => { throw new Error("should not pair"); },
      loadSession: () => session,
      stdout: () => {},
    }),
    (error) => {
      assert.equal(String(error.message).includes(SYM), false);
      assert.match(error.message, /not a v2 pairing URI/);
      return true;
    },
  );
  const page = await openPasteServer({ timeoutMs: 2000 });
  const response = await fetch(page.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "wrong", uri: URI }),
  });
  assert.equal(response.status, 400);
  const html = await (await fetch(page.url)).text();
  const token = html.match(/name="token" value="([0-9a-f]+)"/)[1];
  const ok = await fetch(page.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, uri: URI }),
  });
  assert.equal(ok.status, 200);
  assert.equal(await page.done, URI);
  assert.equal((await ok.text()).includes(SYM), false);
});

test("wc approve --dry-run does not sign or respond", async () => {
  const record = freezeRequest(requestEvent(), sessionRecord());
  const ops = [];
  const out = capture();
  try {
    await assert.rejects(
      () => walletConnectCommand(["approve", "7"], { "dry-run": true }, {
        call: async (message) => {
          ops.push(message.op);
          if (message.op === "getRequest") return record;
          throw new Error(`unexpected ${message.op}`);
        },
        loadSession: () => ({
          wallets: [{ chainType: "ethereum", address: ADDRESS, id: "eth-wallet" }],
          caps: {},
        }),
        rpc: async () => { throw new Error("rpc was called"); },
        stdout: () => {},
      }),
      (error) => error instanceof DryRun,
    );
  } finally {
    out.restore();
  }
  assert.deepEqual(ops, ["getRequest"]);
  assert.match(out.text(), /dry-run: nothing was signed or broadcast/);
  assert.match(out.text(), /summary: sign message: hello/);
});

test("requests show verify status and stale requests expire; wc clear drops them", async () => {
  const mismatch = freezeRequest(
    {
      ...requestEvent(),
      verifyContext: { verified: { origin: "https://evil.example", validation: "INVALID" } },
    },
    {
      ...sessionRecord(),
      claimedUrl: "https://example.com",
      verify: { origin: "https://evil.example", validation: "INVALID", isScam: false },
      origin: originReport({ origin: "https://evil.example", validation: "INVALID", isScam: false }, "https://example.com"),
    },
  );
  assert.match(formatRequest(mismatch), /^origin: MISMATCH/);
  assert.match(formatRequest(mismatch), /verify: MISMATCH/);
  assert.match(formatRequest(mismatch), /WARNING: verified origin does not match/);
  assert.match(formatRequest(mismatch), /summary: sign message: hello/);

  const dir = mkdtempSync(join(tmpdir(), "gwc-expire-"));
  const client = fakeClient();
  const daemon = new WalletDaemon(client);
  daemon.state.sessions.push(sessionRecord());
  const server = await listen(daemon, join(dir, "s"));
  try {
    await client.emit("session_request", requestEvent());
    const live = await ipcCall(join(dir, "s"), { op: "requests" });
    assert.equal(live.requests.length, 1);
    await client.emit("session_request", requestEvent({ expiry: 1, id: 8 }));
    const listed = await ipcCall(join(dir, "s"), { op: "requests" });
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.requests[0].id, 7);
    assert.equal(listed.expired.requests, 1);
    daemon.state.proposals.push({ id: 9, expiresAt: Date.now() + 60_000, required: { chains: [], methods: [], events: [], other: [] }, optional: { chains: [], methods: [], events: [], other: [] }, origin: { domain: "example.com" }, verify: { validation: "UNKNOWN" }, claimedName: "", claimedUrl: "" });
    const cleared = await ipcCall(join(dir, "s"), { op: "clear" });
    assert.equal(cleared.sessions, 1);
    assert.equal(cleared.requests, 1);
    assert.equal(client.disconnected.topic, "session-topic");
    const after = await ipcCall(join(dir, "s"), { op: "requests" });
    assert.equal(after.requests.length, 0);
    const sessions = await ipcCall(join(dir, "s"), { op: "sessions" });
    assert.equal(sessions.length, 0);
  } finally {
    await server.close();
  }
});

test("changelog section is selected by version", () => {
  const markdown = "## 0.2.6\n\nship\n\n## 0.2.5\n\npublic id\n";
  assert.equal(changelogSection(markdown, "v0.2.6"), "## 0.2.6\n\nship\n");
  assert.equal(changelogSection(markdown, "main"), "");
  const file = readFileSync(join(import.meta.dirname, "../../CHANGELOG.md"), "utf8");
  assert.match(changelogSection(file, "0.2.6"), /production dependencies/);
  assert.match(changelogSection(file, "0.2.7"), /favicon now matches the header logo/);
  assert.match(changelogSection(file, "0.2.7"), /CLI is unchanged/);
  assert.match(changelogSection(file, "0.2.2"), /device_verify/);
});
