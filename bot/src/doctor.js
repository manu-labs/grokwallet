import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chainConfig, chainNames } from "./balances.js";
import { ensureHome } from "./home.js";
import { CliError } from "./redact.js";
import { loadSession, sessionFileExists } from "./session.js";

export function nodeSupported(version) {
  const [major, minor, patch] = String(version).split(".").map((part) => Number(part));
  if (major !== 22 || !Number.isInteger(minor) || !Number.isInteger(patch)) return false;
  return minor > 23 || (minor === 23 && patch >= 0);
}

function safeHost(url) {
  try {
    return new URL(url).hostname || "the configured endpoint";
  } catch {
    return "the configured endpoint";
  }
}

function checkConfig(home) {
  const file = join(home, "config.json");
  if (!existsSync(file)) {
    return { ok: true, line: "config: no config file; built-in app id and WalletConnect project id" };
  }
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) {
    return {
      ok: false,
      problem: `config: ${file} is mode ${mode.toString(8)}`,
      fix: `Run: chmod 600 ${file}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {
      ok: false,
      problem: "config: file is not JSON",
      fix: "Fix ~/.grokwallet/config.json or delete it. The CLI will use the built-in public ids.",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      problem: "config: file must be a JSON object",
      fix: "Replace ~/.grokwallet/config.json with an object containing appId or wcProjectId.",
    };
  }
  if (parsed.wcProjectId && !/^[0-9a-fA-F]{32}$/.test(String(parsed.wcProjectId))) {
    return {
      ok: false,
      problem: "config: wcProjectId is not 32 hex characters",
      fix: "Set wcProjectId to 32 hex characters, or remove it to use the built-in public project id.",
    };
  }
  return { ok: true, line: "config: present" };
}

function checkLogin() {
  if (!sessionFileExists()) {
    return { ok: false, problem: "login: not logged in", fix: "Run: grokwallet login" };
  }
  const mode = statSync(join(ensureHome(), "session.json")).mode & 0o777;
  if (mode !== 0o600) {
    return {
      ok: false,
      problem: `login: session file is mode ${mode.toString(8)}`,
      fix: "Run: chmod 600 ~/.grokwallet/session.json",
    };
  }
  try {
    const session = loadSession();
    if (!session?.accessToken || !session?.refreshToken) {
      return { ok: false, problem: "login: session file has no saved login", fix: "Run: grokwallet login" };
    }
    return { ok: true, line: "login: logged in" };
  } catch (error) {
    const message = error instanceof CliError ? error.message : "session could not be read";
    if (message.includes("GROKWALLET_PASSPHRASE")) {
      return {
        ok: false,
        problem: "login: GROKWALLET_PASSPHRASE is not set",
        fix: "Export GROKWALLET_PASSPHRASE. Do not paste it into chat.",
      };
    }
    return {
      ok: false,
      problem: "login: session could not be decrypted",
      fix: "Export the same GROKWALLET_PASSPHRASE used at login, or run grokwallet login again.",
    };
  }
}

async function checkRpc(name, fetchImpl) {
  const chain = chainConfig(name);
  const host = safeHost(chain.rpc);
  const body =
    chain.kind === "evm"
      ? { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }
      : { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] };
  try {
    const response = await fetchImpl(chain.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        ok: false,
        problem: `rpc ${name}: ${host} returned HTTP ${response.status}`,
        fix: `Check the network, or set ${chain.env} to a working ${name} endpoint.`,
      };
    }
    const payload = await response.json();
    if (!payload || payload.error || payload.result === undefined || payload.result === null) {
      return {
        ok: false,
        problem: `rpc ${name}: ${host} did not return a result`,
        fix: `Check the network, or set ${chain.env} to a working ${name} endpoint.`,
      };
    }
    return { ok: true, line: `rpc ${name}: ${host}` };
  } catch {
    return {
      ok: false,
      problem: `rpc ${name}: ${host} did not answer`,
      fix: `Check the network, or set ${chain.env} to a working ${name} endpoint.`,
    };
  }
}

export async function doctor({
  fetchImpl = fetch,
  nodeVersion = process.versions.node,
  home = ensureHome(),
  stdout = process.stdout,
} = {}) {
  const rows = [];
  if (nodeSupported(nodeVersion)) rows.push({ ok: true, line: `node ${nodeVersion}` });
  else {
    rows.push({
      ok: false,
      problem: `node: ${nodeVersion} is outside >=22.23.0 <23`,
      fix: "Install Node 22.23.x. This CLI does not support Node 23 or older than 22.23.0.",
    });
  }
  rows.push(checkConfig(home));
  rows.push(checkLogin());
  const rpcs = [];
  for (const name of chainNames()) rpcs.push(await checkRpc(name, fetchImpl));
  rows.push(...rpcs);
  let failed = false;
  for (const row of rows) {
    if (row.ok) stdout.write(`ok ${row.line}\n`);
    else {
      failed = true;
      stdout.write(`fail ${row.problem}\nfix: ${row.fix}\n`);
    }
  }
  return failed ? 1 : 0;
}
