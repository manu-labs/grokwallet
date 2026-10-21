import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { codeChallengeS256, isAllowedRedirect, parseConnectorResource } from "../functions/_lib/_oauth.js";
import { handleRequest, LINK_STATUS_TEXT } from "../functions/_lib/_server.js";

const SECRET = "test-key-test-key-test-key-test-key";
const NOW = 1_700_000_000;
const ORIGIN = "https://grokwallet.fun";
const ENV = { GROKWALLET_OAUTH_HMAC_KEY: SECRET };
const REDIRECTS = [
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "http://localhost:8787/callback",
];

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

async function call(path, { method = "GET", headers = {}, body, env = ENV, now = NOW, origin = ORIGIN } = {}) {
  const request = new Request(`${origin}${path}`, { method, headers, body });
  const response = await handleRequest(request, env, { now });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return { status: response.status, headers: response.headers, text, payload };
}

async function register() {
  const response = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: REDIRECTS,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: "Grok Bot",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.text.includes("device-secret-value"), false);
  return response.payload.client_id;
}

async function authorize(clientId, { resource, redirect = REDIRECTS[0], verifier, challenge, state = "state-1" }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "link_status",
    resource,
  });
  return call(`/oauth/authorize?${params}`);
}

test("connector URLs keep only the public user code", () => {
  const path = parseConnectorResource("https://grokwallet.fun/mcp/c/ABCD-1234", ORIGIN);
  assert.equal(path.userCode, "ABCD-1234");
  assert.equal(path.canonical, "https://grokwallet.fun/mcp/c/ABCD-1234");
  const query = parseConnectorResource("https://grokwallet.fun/mcp?code=ABCD-1234", ORIGIN);
  assert.equal(query.userCode, "ABCD-1234");
  assert.equal(query.canonical, "https://grokwallet.fun/mcp?code=ABCD-1234");
  assert.equal(parseConnectorResource("https://grokwallet.fun/mcp/c/ABCD-1234?next=https://evil.example", ORIGIN), null);
  assert.equal(parseConnectorResource("https://evil.example/mcp/c/ABCD-1234", ORIGIN), null);
  assert.equal(parseConnectorResource("https://grokwallet.fun/mcp/c/../oauth/token", ORIGIN), null);
  assert.equal(parseConnectorResource("https://grokwallet.fun/mcp?code=ABCD-1234&next=1", ORIGIN), null);
  assert.equal(parseConnectorResource("https://grokwallet.fun/mcp/c/%2e%2e", ORIGIN), null);
});

test("redirect allowlist is exact and loopback is only /callback", () => {
  for (const uri of REDIRECTS) assert.equal(isAllowedRedirect(uri), true);
  assert.equal(isAllowedRedirect("http://127.0.0.1:8787/callback"), true);
  assert.equal(isAllowedRedirect("https://evil.example/callback"), false);
  assert.equal(isAllowedRedirect("javascript:https://www.cursor.com/agents/mcp/oauth/callback"), false);
  assert.equal(isAllowedRedirect("cursor://anysphere.cursor-mcp/oauth/callback/extra"), false);
  assert.equal(isAllowedRedirect("https://user@www.cursor.com/agents/mcp/oauth/callback"), false);
  assert.equal(isAllowedRedirect("http://localhost:8787/callback/../steal"), false);
  assert.equal(isAllowedRedirect("https://www.cursor.com.evil.example/agents/mcp/oauth/callback"), false);
});

test("PKCE S256, path code, and a token that cannot cross connectors", async () => {
  const verifier = `${"a".repeat(43)}-verifier`;
  const challenge = await codeChallengeS256(verifier);
  assert.equal(challenge.length, 43);
  assert.notEqual(await codeChallengeS256(`${verifier}x`), challenge);
  const clientId = await register();
  const resource = "https://grokwallet.fun/mcp/c/ABCD-1234";
  const started = await authorize(clientId, { resource, challenge });
  assert.equal(started.status, 302);
  const approval = new URL(started.headers.get("location"));
  assert.equal(approval.origin, ORIGIN);
  assert.equal(approval.pathname, "/");
  assert.equal(approval.searchParams.get("user_code"), "ABCD-1234");
  assert.match(approval.searchParams.get("oauth_return"), /^gw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(started.headers.get("location").includes("device_code"), false);
  assert.equal(approval.searchParams.get("device_code"), null);

  const done = await call(
    `/oauth/complete?txn=${encodeURIComponent(approval.searchParams.get("oauth_return"))}&user_code=ABCD-1234`,
  );
  assert.equal(done.status, 302);
  const back = new URL(done.headers.get("location"));
  assert.equal(back.protocol, "cursor:");
  assert.equal(back.hostname, "anysphere.cursor-mcp");
  assert.equal(back.pathname, "/oauth/callback");
  assert.equal(back.searchParams.get("state"), "state-1");
  const code = back.searchParams.get("code");
  assert.match(code, /^gw1\./);

  const mismatch = await call(
    `/oauth/complete?txn=${encodeURIComponent(approval.searchParams.get("oauth_return"))}&user_code=ZZZZ-9999`,
  );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.headers.get("location"), null);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECTS[0],
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  assert.equal(token.status, 200);
  assert.equal(token.payload.token_type, "Bearer");
  assert.equal(token.payload.scope, "link_status");
  assert.equal(Object.hasOwn(token.payload, "refresh_token"), false);
  assert.equal(token.text.includes("device-secret-value"), false);

  const again = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  assert.equal(again.status, 200);

  const wrong = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(form), code_verifier: `${"b".repeat(43)}-verifier` }),
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.payload.error, "invalid_grant");

  const expired = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    now: NOW + 120,
  });
  assert.equal(expired.status, 400);

  const bare = await call("/mcp/c/ABCD-1234", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(bare.status, 401);
  assert.match(bare.headers.get("www-authenticate"), /resource_metadata="https:\/\/grokwallet\.fun\/\.well-known\/oauth-protected-resource\/mcp\/c\/ABCD-1234"/);

  const authed = await call("/mcp/c/ABCD-1234", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.payload.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "link_status", arguments: {} } }),
  });
  assert.equal(authed.status, 200);
  assert.equal(authed.payload.result.content[0].text, LINK_STATUS_TEXT);

  const other = await call("/mcp/c/WXYZ-9876", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.payload.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
  });
  assert.equal(other.status, 401);

  const queryResource = "https://grokwallet.fun/mcp?code=ABCD-1234";
  const queryStart = await authorize(clientId, { resource: queryResource, redirect: REDIRECTS[1], challenge, state: "q" });
  assert.equal(queryStart.status, 302);
  assert.equal(new URL(queryStart.headers.get("location")).searchParams.get("user_code"), "ABCD-1234");
});

test("authorize rejects an unregistered redirect without sending the browser there", async () => {
  const clientId = await register();
  const challenge = await codeChallengeS256("c".repeat(50));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://evil.example/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "https://grokwallet.fun/mcp/c/ABCD-1234",
    device_code: "device-secret-value",
  });
  const response = await call(`/oauth/authorize?${params}`);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.text.includes("evil.example"), false);
  assert.equal(response.text.includes("device-secret-value"), false);
});

test("registration rejects a redirect that is not on the allowlist", async () => {
  const response = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "invalid_redirect_uri");
  assert.equal(response.text.includes("evil.example"), false);
});

test("metadata and a missing HMAC key", async () => {
  const as = await call("/.well-known/oauth-authorization-server");
  assert.equal(as.status, 200);
  assert.equal(as.payload.issuer, ORIGIN);
  assert.equal(as.payload.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.deepEqual(as.payload.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.payload.registration_endpoint, `${ORIGIN}/oauth/register`);

  const prm = await call("/.well-known/oauth-protected-resource/mcp/c/ABCD-1234");
  assert.equal(prm.payload.resource, `${ORIGIN}/mcp/c/ABCD-1234`);
  assert.deepEqual(prm.payload.authorization_servers, [ORIGIN]);

  const queryPrm = await call("/.well-known/oauth-protected-resource/mcp?code=ABCD-1234");
  assert.equal(queryPrm.payload.resource, `${ORIGIN}/mcp?code=ABCD-1234`);

  const missing = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: REDIRECTS }),
    env: {},
  });
  assert.equal(missing.status, 503);
  assert.match(missing.text, /GROKWALLET_OAUTH_HMAC_KEY/);
});

test("Pages functions do not reference Privy credentials", () => {
  const banned = ["device_code", "auth.privy.io", "refresh_token", "GROKWALLET_PASSPHRASE", "BEGIN PRIVATE KEY"];
  for (const file of walk(new URL("../functions", import.meta.url).pathname)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(file, "utf8");
    for (const word of banned) assert.equal(source.includes(word), false, `${file} contains ${word}`);
    const imported = /from "(\.[^"]+)"/.exec(source);
    if (!imported) continue;
    const target = fileURLToPath(new URL(imported[1], pathToFileURL(file)));
    assert.equal(existsSync(target), true, `${file} imports missing ${imported[1]}`);
  }
});
