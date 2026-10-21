import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "../home.js";
import { CliError, redact } from "../redact.js";

export function wcPaths(home = homeDir()) {
  const dir = join(home, "wc");
  return {
    dir,
    socket: join(dir, "daemon.sock"),
    state: join(dir, "state.json"),
    store: join(dir, "store.json"),
    pid: join(dir, "daemon.pid"),
    log: join(dir, "daemon.log"),
  };
}

function cliPath() {
  return fileURLToPath(new URL("../../bin/grokwallet.js", import.meta.url));
}

export function ipcCall(socketPath, message, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CliError("walletconnect daemon timed out"));
    }, timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      if (error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        reject(new CliError("walletconnect daemon is not running"));
        return;
      }
      reject(new CliError("walletconnect daemon is not reachable"));
    };
    socket.setEncoding("utf8");
    socket.on("error", fail);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(buf.slice(0, nl));
      } catch {
        socket.end();
        reject(new CliError("walletconnect daemon returned invalid JSON"));
        return;
      }
      socket.end();
      if (!parsed.ok) reject(new CliError(redact(parsed.error || "walletconnect daemon failed")));
      else resolve(parsed.result);
    });
  });
}

function lastLogLine(file) {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").trim();
  const line = text.split("\n").at(-1) || "";
  return redact(line).slice(0, 300);
}

export async function ensureDaemon() {
  const paths = wcPaths();
  try {
    await ipcCall(paths.socket, { op: "ping" }, 500);
    return;
  } catch {
    // The relay process is started below.
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (existsSync(paths.socket)) rmSync(paths.socket);
  const log = openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [cliPath(), "wc", "daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await ipcCall(paths.socket, { op: "ping" }, 500);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const detail = lastLogLine(paths.log);
  throw new CliError(detail || "walletconnect daemon did not start");
}
