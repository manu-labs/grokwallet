import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { CliError } from "../redact.js";
import { assertPairingUri } from "./safety.js";

function page(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GrokWallet paste</title>
<style>
  :root { color-scheme: dark; --ink: #f1f3f1; --muted: #969c98; --paper: #080b09; --line: #28312b; --good: #10c77a; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: var(--paper); color: var(--ink); font-family: Arial, Helvetica, sans-serif; }
  body { background-image: radial-gradient(ellipse at 75% 40%, #11201955, transparent 52%); }
  main { width: min(560px, calc(100% - 32px)); margin: 48px auto; }
  .brand { display: flex; align-items: center; font-size: 24px; font-weight: 650; letter-spacing: -1px; }
  .brand-dot { color: var(--good); }
  .brand-icon { display: flex; align-items: flex-start; justify-content: center; gap: 5px; width: 35px; height: 35px; border-radius: 50%; background: var(--good); margin-right: 11px; padding-top: 8px; transform: rotate(-23deg); }
  .brand-icon i { display: block; width: 5px; height: 10px; background: #082317; border-radius: 1px; }
  .brand-icon i:last-child { height: 7px; }
  .card { margin-top: 24px; background: linear-gradient(130deg, #171e19, #101511); border: 1px solid var(--line); border-radius: 22px; padding: 30px; }
  h1 { margin: 0 0 14px; font-size: 32px; font-weight: 500; letter-spacing: -1.2px; }
  p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
  textarea { width: 100%; min-height: 96px; margin-top: 16px; padding: 12px; border: 1px solid #26382b; border-radius: 10px; background: #090e0b; color: #e2f5e9; font: 14px ui-monospace, monospace; }
  button { margin-top: 16px; border: 1px solid var(--good); border-radius: 9px; background: var(--good); color: #032213; font-weight: 600; padding: 13px 17px; cursor: pointer; }
  button:focus-visible, textarea:focus-visible { outline: 2px solid #70f3b9; outline-offset: 3px; }
</style>
</head>
<body>
<main>
<div class="brand"><span class="brand-icon" aria-hidden="true"><i></i><i></i></span>GrokWallet<span class="brand-dot">.</span></div>
<section class="card">
<h1>Paste a pairing URI</h1>
<p>This page is local, accepts one WalletConnect URI, then closes.</p>
<form method="post" action="/">
<input type="hidden" name="token" value="${token}">
<textarea name="uri" rows="4" autofocus></textarea>
<p><button type="submit">Pair</button></p>
</form>
</section>
</main>
</body>
</html>`;
}

function loopback(remote) {
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

export function openPasteServer({ timeoutMs = 120000 } = {}) {
  const token = randomBytes(16).toString("hex");
  let resolveUri;
  let rejectUri;
  let finished = false;
  const done = new Promise((resolve, reject) => {
    resolveUri = resolve;
    rejectUri = reject;
  });
  const server = createServer((req, res) => {
    const remote = req.socket.remoteAddress || "";
    const host = String(req.headers.host || "");
    if (!loopback(remote) || (!host.startsWith("127.0.0.1:") && !host.startsWith("[::1]:") && !host.startsWith("localhost:"))) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("forbidden\n");
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page(token));
      return;
    }
    if (req.method !== "POST" || req.url !== "/") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (finished) {
        res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
        res.end("this page was already used\n");
        return;
      }
      try {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (params.get("token") !== token) throw new CliError("paste page token did not match");
        const uri = String(params.get("uri") || "").trim();
        assertPairingUri(uri);
        finished = true;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("received. You can close this page.\n");
        clearTimeout(timer);
        server.close();
        resolveUri(uri);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("That is not a WalletConnect v2 pairing URI.\n");
      }
    });
  });
  let timer;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}/`;
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        server.close();
        rejectUri(
          new CliError(
            "paste page timed out",
            1,
            "Run wc pair --paste again, or pass the URI with wc pair --from-file.",
          ),
        );
      }, timeoutMs);
      resolve({ url, done, close: () => server.close() });
    });
  });
}
