import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { CliError, redact } from "../redact.js";
import { ipcCall, wcPaths } from "./client.js";
import { freezeProposal, planSessionApproval, sessionView } from "./plan.js";
import { freezeRequest } from "./request.js";
import {
  RAW_HASH_REFUSED,
  UNSUPPORTED_METHOD,
  USER_DISCONNECTED,
  USER_REJECTED,
  assertPairingUri,
  classifyMethod,
  requireWcProjectId,
} from "./safety.js";

const REJECTION_LIMIT = 20;

export function emptyState() {
  return { proposals: [], requests: [], rejections: [], sessions: [], calls: [] };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

export class FileStorage {
  constructor(file) {
    this.file = file;
    const parsed = readJson(file, {});
    this.map = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }

  async getKeys() {
    return Object.keys(this.map);
  }

  async getEntries() {
    return Object.entries(this.map);
  }

  async getItem(key) {
    return this.map[key];
  }

  async setItem(key, value) {
    this.map[key] = value;
    this.flush();
  }

  async removeItem(key) {
    delete this.map[key];
    this.flush();
  }

  flush() {
    writeJson(this.file, this.map);
  }
}

function findById(list, key, noun) {
  const text = String(key ?? "");
  if (!text) throw new CliError(`missing ${noun} id`);
  if (text.includes(":")) {
    const found = list.find((item) => item.key === text);
    if (!found) throw new CliError(`no pending ${noun} with that id`);
    return found;
  }
  const matches = list.filter((item) => String(item.id) === text);
  if (matches.length === 0) throw new CliError(`no pending ${noun} with that id`);
  if (matches.length > 1) throw new CliError(`that ${noun} id is not unique. Pass topic:id.`);
  return matches[0];
}

export class WalletDaemon {
  constructor(client) {
    this.client = client;
    this.state = emptyState();
    this.statePath = "";
    this.pendingPair = null;
    const listen = (event, fn) => {
      if (typeof client.on === "function") client.on(event, fn);
      else client.events.on(event, fn);
    };
    listen("session_proposal", (event) => this.onProposal(event));
    listen("session_request", (event) => this.onRequest(event));
    listen("session_delete", (event) => this.dropSession(event.topic));
    listen("session_expire", (event) => this.dropSession(event.topic));
    listen("proposal_expire", (event) => this.dropProposal(event.id));
    listen("session_request_expire", (event) => this.dropRequestById(event.id));
  }

  save() {
    if (!this.statePath) return;
    writeJson(this.statePath, this.state);
  }

  pushRejection(entry) {
    this.state.rejections.push({ ...entry, at: new Date().toISOString() });
    if (this.state.rejections.length > REJECTION_LIMIT) {
      this.state.rejections.splice(0, this.state.rejections.length - REJECTION_LIMIT);
    }
    this.save();
  }

  onProposal(event) {
    let record;
    try {
      record = freezeProposal(event);
    } catch (error) {
      void this.client.reject?.({ id: event?.id, reason: UNSUPPORTED_METHOD }).catch(() => {});
      this.pushRejection({
        id: event?.id,
        topic: "",
        method: "session_proposal",
        reason: error instanceof CliError ? error.message : "proposal was refused",
        origin: "(unknown)",
      });
      return;
    }
    this.state.proposals = this.state.proposals.filter((item) => item.id !== record.id);
    this.state.proposals.push(record);
    this.save();
    if (this.pendingPair) this.pendingPair(record);
  }

  async failRequest(event, error, reason, session) {
    try {
      if (event?.topic && Number.isInteger(event?.id)) {
        await this.client.respond({
          topic: event.topic,
          response: { id: event.id, jsonrpc: "2.0", error },
        });
      }
    } catch {
      // A dead relay must not leave the request approvable.
    }
    this.pushRejection({
      id: event?.id,
      topic: event?.topic || "",
      method: event?.params?.request?.method || "(missing)",
      reason,
      origin: session?.origin?.domain || "(unknown)",
    });
  }

  async onRequest(event) {
    const method = event?.params?.request?.method || "(missing)";
    const session = this.state.sessions.find((item) => item.topic === event?.topic);
    const decision = classifyMethod(method);
    if (!session || !decision.allow) {
      await this.failRequest(
        event,
        decision.rawHash ? RAW_HASH_REFUSED : UNSUPPORTED_METHOD,
        !session ? "request is not on an approved session" : decision.reason,
        session,
      );
      return;
    }
    const key = `${event.topic}:${event.id}`;
    if (this.state.requests.some((item) => item.key === key)) {
      this.pushRejection({
        id: event.id,
        topic: event.topic,
        method,
        reason: "duplicate request id was ignored",
        origin: session.origin.domain,
      });
      return;
    }
    try {
      this.state.requests.push(freezeRequest(event, session));
      this.save();
    } catch (error) {
      await this.failRequest(
        event,
        UNSUPPORTED_METHOD,
        error instanceof CliError ? error.message : "request was refused",
        session,
      );
    }
  }

  dropProposal(id) {
    this.state.proposals = this.state.proposals.filter((item) => item.id !== id);
    this.save();
  }

  dropRequestById(id) {
    this.state.requests = this.state.requests.filter((item) => item.id !== id);
    this.save();
  }

  dropSession(topic) {
    this.state.sessions = this.state.sessions.filter((item) => item.topic !== topic);
    this.state.requests = this.state.requests.filter((item) => item.topic !== topic);
    this.save();
  }

  sweep() {
    const now = Date.now();
    const requests = this.state.requests.filter((item) => item.expiresAt && item.expiresAt > now);
    const proposals = this.state.proposals.filter((item) => item.expiresAt && item.expiresAt > now);
    const dropped = {
      requests: this.state.requests.length - requests.length,
      proposals: this.state.proposals.length - proposals.length,
    };
    if (dropped.requests || dropped.proposals) {
      this.state.requests = requests;
      this.state.proposals = proposals;
      this.save();
    }
    return dropped;
  }

  findProposal(id) {
    this.sweep();
    return findById(this.state.proposals, id, "proposal");
  }

  findRequest(key) {
    this.sweep();
    return findById(this.state.requests, key, "request");
  }

  async pair({ uri, timeoutMs }) {
    assertPairingUri(uri);
    const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingPair = null;
        reject(new CliError("pairing timed out before a session proposal arrived"));
      }, timeout);
      this.pendingPair = (record) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingPair = null;
        resolve(record);
      };
      Promise.resolve(this.client.pair({ uri })).catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingPair = null;
        const message = error instanceof Error ? error.message : "pairing failed";
        reject(new CliError(redact(message)));
      });
    });
  }

  async approveProposal({ id, payloadHash, address }) {
    const record = this.findProposal(id);
    if (record.payloadHash !== payloadHash) throw new CliError("the proposal changed. Nothing was approved.");
    const plan = planSessionApproval(record, address);
    if (!plan.ok) throw new CliError(plan.reason);
    const session = await this.client.approve({ id: record.id, namespaces: plan.namespaces });
    const stored = sessionView({
      topic: session.topic,
      peer: session.peer,
      namespaces: plan.namespaces,
      verify: record.verify,
      claimedName: record.claimedName,
      claimedUrl: record.claimedUrl,
    });
    this.state.sessions = this.state.sessions.filter((item) => item.topic !== stored.topic);
    this.state.sessions.push(stored);
    this.dropProposal(record.id);
    return stored;
  }

  async rejectProposal(id) {
    const record = this.findProposal(id);
    await this.client.reject({ id: record.id, reason: USER_REJECTED });
    this.dropProposal(record.id);
    return { id: record.id };
  }

  async respond({ key, payloadHash, result, recordCall }) {
    const record = this.findRequest(key);
    if (record.payloadHash !== payloadHash) throw new CliError("the request changed. The response was not sent.");
    await this.client.respond({
      topic: record.topic,
      response: { id: record.id, jsonrpc: "2.0", result },
    });
    this.state.requests = this.state.requests.filter((item) => item.key !== record.key);
    if (recordCall) {
      this.state.calls = this.state.calls.filter((item) => item.id !== recordCall.id);
      this.state.calls.push(recordCall);
    }
    this.save();
    return { id: record.id };
  }

  async rejectRequest(key) {
    const record = this.findRequest(key);
    await this.client.respond({
      topic: record.topic,
      response: { id: record.id, jsonrpc: "2.0", error: USER_REJECTED },
    });
    this.state.requests = this.state.requests.filter((item) => item.key !== record.key);
    this.save();
    return { id: record.id, topic: record.topic };
  }

  async disconnect(topic) {
    const session = this.state.sessions.find((item) => item.topic === topic);
    if (!session) throw new CliError("no session with that topic");
    await this.client.disconnect({ topic, reason: USER_DISCONNECTED });
    const copy = session;
    this.dropSession(topic);
    return copy;
  }

  async clear() {
    const topics = this.state.sessions.map((item) => item.topic);
    const removed = {
      sessions: topics.length,
      proposals: this.state.proposals.length,
      requests: this.state.requests.length,
    };
    for (const topic of topics) {
      try {
        await this.client.disconnect({ topic, reason: USER_DISCONNECTED });
      } catch {
        // Drop the local session even if the relay is already gone.
      }
    }
    this.state.sessions = [];
    this.state.proposals = [];
    this.state.requests = [];
    this.state.rejections = [];
    this.save();
    return removed;
  }

  async handle(message) {
    const expired = message?.op === "ping" ? { requests: 0, proposals: 0 } : this.sweep();
    switch (message?.op) {
      case "ping":
        return { ok: true };
      case "pair":
        return this.pair(message);
      case "proposals":
        return this.state.proposals;
      case "getProposal":
        return this.findProposal(message.id);
      case "approveProposal":
        return this.approveProposal(message);
      case "rejectProposal":
        return this.rejectProposal(message.id);
      case "requests":
        return { requests: this.state.requests, rejections: this.state.rejections, expired };
      case "clear":
        return this.clear();
      case "getRequest":
        return this.findRequest(message.key);
      case "respond":
        return this.respond(message);
      case "rejectRequest":
        return this.rejectRequest(message.key);
      case "sessions":
        return this.state.sessions;
      case "disconnect":
        return this.disconnect(message.topic);
      case "getCall":
        return this.state.calls.find((item) => item.id === message.id) || null;
      default:
        throw new CliError("unknown walletconnect daemon command");
    }
  }
}

export async function listen(daemon, socketPath) {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) {
        socket.destroy();
        return;
      }
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void answer(socket, daemon, line);
        nl = buf.indexOf("\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return {
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          if (existsSync(socketPath)) rmSync(socketPath);
          resolve();
        });
      });
    },
  };
}

async function answer(socket, daemon, line) {
  try {
    const message = JSON.parse(line);
    const result = await daemon.handle(message);
    socket.end(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    const message = redact(error instanceof CliError ? error.message : "walletconnect daemon failed");
    socket.end(`${JSON.stringify({ ok: false, error: message })}\n`);
  }
}

function hydrate(daemon) {
  const sessions = daemon.client.session?.getAll?.() || [];
  for (const session of sessions) {
    if (daemon.state.sessions.some((item) => item.topic === session.topic)) continue;
    daemon.state.sessions.push(
      sessionView({
        topic: session.topic,
        peer: session.peer,
        namespaces: session.namespaces,
        verify: { origin: "", validation: "UNKNOWN", isScam: false },
      }),
    );
  }
  daemon.save();
}

export async function runDaemon() {
  const paths = wcPaths();
  try {
    await ipcCall(paths.socket, { op: "ping" }, 500);
    process.stderr.write("walletconnect daemon is already running\n");
    return;
  } catch {
    // Start a new relay process.
  }
  let projectId = "";
  try {
    projectId = requireWcProjectId();
    const { SignClient } = await import("@walletconnect/sign-client");
    const client = await SignClient.init({
      projectId,
      metadata: {
        name: "GrokWallet",
        description: "Non-custodial CLI wallet",
        url: "https://grokwallet.fun",
        icons: ["https://grokwallet.fun/favicon.ico"],
      },
      storage: new FileStorage(paths.store),
      logger: "error",
      telemetryEnabled: false,
    });
    const daemon = new WalletDaemon(client);
    daemon.statePath = paths.state;
    const saved = readJson(paths.state, null);
    if (saved && typeof saved === "object") {
      const base = { ...emptyState(), ...saved };
      for (const key of ["proposals", "requests", "rejections", "sessions", "calls"]) {
        if (!Array.isArray(base[key])) base[key] = [];
      }
      daemon.state = base;
    }
    hydrate(daemon);
    const server = await listen(daemon, paths.socket);
    writeJson(paths.pid, { pid: process.pid });
    await new Promise((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await server.close();
  } catch (error) {
    let message = error instanceof Error ? error.message : "walletconnect daemon failed";
    if (projectId) message = message.split(projectId).join("[project-id]");
    process.stderr.write(`${redact(message)}\n`);
    return 1;
  }
}

