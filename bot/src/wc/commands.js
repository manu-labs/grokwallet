import { readFileSync } from "node:fs";
import { requireSession, requireYes, runWalletRpc, walletOf } from "../commands.js";
import { CliError } from "../redact.js";
import { ensureDaemon, ipcCall, wcPaths } from "./client.js";
import { runDaemon } from "./daemon.js";
import { openPasteServer } from "./paste.js";
import { formatProposal, formatSession, planSessionApproval } from "./plan.js";
import { formatRequest, prepareWcRequest } from "./request.js";
import { assertPairingUri } from "./safety.js";

async function liveCall(message) {
  await ensureDaemon();
  const extra = message.op === "pair" ? Number(message.timeoutMs || 30000) + 5000 : 20000;
  return ipcCall(wcPaths().socket, message, extra);
}

function stdoutWrite(text) {
  process.stdout.write(text);
}

function timeoutMs(flags) {
  if (flags.timeout === undefined) return 30000;
  const value = Number(flags.timeout);
  if (!Number.isInteger(value) || value < 1 || value > 120) {
    throw new CliError("--timeout must be a whole number of seconds from 1 to 120");
  }
  return value * 1000;
}

function requireId(rest) {
  const value = rest[1];
  if (value === undefined || value === "") throw new CliError("missing id");
  if (rest.length > 2) throw new CliError(`unexpected argument ${rest[2]}`);
  return String(value);
}

function walletAddress(io) {
  const session = io.loadSession();
  return { session, wallet: walletOf(session, "ethereum") };
}

function rpcOutcome(record, action, rpcResult) {
  if (action.interpret === "signature") {
    const signature = rpcResult?.data?.signature || rpcResult?.signature || "";
    if (!signature) throw new CliError("wallet rpc did not return a signature");
    return { line: `signature ${signature}\n`, result: signature };
  }
  const hash = rpcResult?.data?.hash || rpcResult?.hash || "";
  if (!hash) throw new CliError("wallet rpc did not return a transaction hash");
  if (action.interpret === "calls") {
    return {
      line: `submitted ${action.chainName} ${hash}\n`,
      result: { id: action.batchId },
      recordCall: {
        id: action.batchId,
        hash,
        caip2: action.caip2,
        chainId: action.chainIdHex,
        topic: record.topic,
      },
    };
  }
  return { line: `submitted ${action.chainName} ${hash}\n`, result: hash };
}

function readUriFile(path) {
  let text;
  try {
    text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch {
    throw new CliError(
      path === "-" ? "could not read the pairing URI from stdin" : `could not read ${path}`,
      1,
      "Write the URI to a file mode 0600 and pass wc pair --from-file, or use wc pair --paste.",
    );
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length !== 1) {
    throw new CliError(
      "the pairing file must contain one WalletConnect URI",
      1,
      "Put the wc: URI on a single line and run wc pair --from-file again.",
    );
  }
  return lines[0];
}

async function readPairUri(rest, flags, io) {
  const positional = rest[1];
  const fromFile = flags["from-file"];
  if (flags.paste) {
    if (positional || fromFile !== undefined) {
      throw new CliError(
        "wc pair --paste does not take a URI or --from-file",
        1,
        "Run wc pair --paste by itself.",
      );
    }
    const page = await openPasteServer({ timeoutMs: timeoutMs(flags) });
    io.stdout(`paste_url: ${page.url}\nOpen it on this machine, paste the pairing URI once, then the page closes.\n`);
    return page.done;
  }
  if (fromFile !== undefined) {
    if (fromFile === true) {
      throw new CliError("missing --from-file path", 1, "Pass a path or - for stdin.");
    }
    if (positional) {
      throw new CliError("pass a pairing URI or --from-file, not both", 1, "Drop one of them and run wc pair again.");
    }
    if (rest.length > 1) throw new CliError(`unexpected argument ${rest[1]}`);
    return readUriFile(String(fromFile));
  }
  if (!positional) {
    throw new CliError(
      "missing WalletConnect URI",
      1,
      "Pass the URI, wc pair --from-file <path>, or wc pair --paste.",
    );
  }
  if (rest.length > 2) throw new CliError(`unexpected argument ${rest[2]}`);
  return positional;
}

async function pair(rest, flags, io) {
  const uri = await readPairUri(rest, flags, io);
  assertPairingUri(uri);
  const { wallet } = walletAddress(io);
  const record = await io.call({ op: "pair", uri, timeoutMs: timeoutMs(flags) });
  io.stdout(`${formatProposal(record, wallet.address)}\n`);
}

async function proposals(io) {
  const { wallet } = walletAddress(io);
  const records = await io.call({ op: "proposals" });
  if (!records.length) {
    io.stdout("proposals: none\n");
    return;
  }
  io.stdout(`${records.map((record) => formatProposal(record, wallet.address)).join("\n\n")}\n`);
}

async function approveProposal(rest, flags, io) {
  const id = requireId(rest);
  const { wallet } = walletAddress(io);
  const record = await io.call({ op: "getProposal", id });
  const plan = planSessionApproval(record, wallet.address);
  if (!plan.ok) throw new CliError(plan.reason);
  requireYes(flags, formatProposal(record, wallet.address));
  const again = await io.call({ op: "getProposal", id: record.id });
  if (again.payloadHash !== record.payloadHash) throw new CliError("the proposal changed. Nothing was approved.");
  const stored = await io.call({
    op: "approveProposal",
    id: again.id,
    payloadHash: again.payloadHash,
    address: wallet.address,
  });
  io.stdout(`${formatSession(stored)}\n`);
}

async function rejectProposal(rest, io) {
  const id = requireId(rest);
  const result = await io.call({ op: "rejectProposal", id });
  io.stdout(`rejected proposal ${result.id}\n`);
}

async function requests(io) {
  const { requests: pending, rejections, expired } = await io.call({ op: "requests" });
  const lines = [];
  if (expired?.requests) lines.push(`expired ${expired.requests} stale request(s)`);
  if (expired?.proposals) lines.push(`expired ${expired.proposals} stale proposal(s)`);
  if (!pending.length) lines.push("pending: none");
  else lines.push(pending.map((record) => formatRequest(record)).join("\n\n"));
  if (rejections?.length) {
    lines.push("auto-rejected:");
    for (const item of rejections) {
      lines.push(`${item.id} ${item.method} topic ${item.topic} origin ${item.origin} — ${item.reason}`);
    }
  }
  io.stdout(`${lines.join("\n")}\n`);
}

function callsStatusId(record) {
  if (Array.isArray(record.params)) return record.params[0];
  return record.params?.id;
}

async function approveRequest(rest, flags, io) {
  const id = requireId(rest);
  const { session, wallet } = walletAddress(io);
  const record = await io.call({ op: "getRequest", key: id });
  const callRecord =
    record.method === "wallet_getCallsStatus" ? await io.call({ op: "getCall", id: callsStatusId(record) }) : null;
  const prepared = await prepareWcRequest(record, {
    address: wallet.address,
    caps: session.caps,
    fetchImpl: io.fetchImpl,
    callRecord,
  });
  requireYes(flags, prepared.summary);
  const again = await io.call({ op: "getRequest", key: record.key });
  if (again.payloadHash !== record.payloadHash) {
    throw new CliError("the request changed after the summary. Nothing was signed.");
  }
  let outcome;
  if (prepared.action.type === "result") {
    outcome = {
      line: `responded ${record.id}\n${JSON.stringify(prepared.action.result)}\n`,
      result: prepared.action.result,
    };
  } else {
    const rpcResult = await io.rpc(session, wallet.id, prepared.action.body, {
      idempotency: prepared.action.idempotency,
    });
    outcome = rpcOutcome(again, prepared.action, rpcResult);
  }
  await io.call({
    op: "respond",
    key: again.key,
    payloadHash: again.payloadHash,
    result: outcome.result,
    recordCall: outcome.recordCall,
  });
  io.stdout(outcome.line);
}

async function rejectRequest(rest, io) {
  const id = requireId(rest);
  const result = await io.call({ op: "rejectRequest", key: id });
  io.stdout(`rejected request ${result.id}\n`);
}

async function sessions(io) {
  const records = await io.call({ op: "sessions" });
  if (!records.length) {
    io.stdout("sessions: none\n");
    return;
  }
  io.stdout(`${records.map((session) => formatSession(session)).join("\n\n")}\n`);
}

async function disconnect(rest, io) {
  const topic = requireId(rest);
  const session = await io.call({ op: "disconnect", topic });
  io.stdout(`disconnected\n${formatSession(session)}\n`);
}

async function clear(io) {
  const removed = await io.call({ op: "clear" });
  io.stdout(
    `cleared ${removed.sessions} session(s), ${removed.proposals} proposal(s), ${removed.requests} request(s)\n`,
  );
}

export async function walletConnectCommand(rest, flags, deps = {}) {
  const io = {
    call: deps.call || liveCall,
    loadSession: deps.loadSession || requireSession,
    rpc: deps.rpc || runWalletRpc,
    fetchImpl: deps.fetchImpl || fetch,
    stdout: deps.stdout || stdoutWrite,
  };
  switch (rest[0]) {
    case "pair":
      await pair(rest, flags, io);
      return;
    case "proposals":
      await proposals(io);
      return;
    case "approve-proposal":
      await approveProposal(rest, flags, io);
      return;
    case "reject-proposal":
      await rejectProposal(rest, io);
      return;
    case "requests":
      await requests(io);
      return;
    case "approve":
      await approveRequest(rest, flags, io);
      return;
    case "reject":
      await rejectRequest(rest, io);
      return;
    case "sessions":
      await sessions(io);
      return;
    case "disconnect":
      await disconnect(rest, io);
      return;
    case "clear":
      await clear(io);
      return;
    case "daemon":
      if (deps.call) throw new CliError("wc daemon is the relay process");
      return runDaemon();
    default:
      throw new CliError(
        "wc command must be pair, proposals, approve-proposal, reject-proposal, requests, approve, reject, sessions, disconnect, or clear",
      );
  }
}
