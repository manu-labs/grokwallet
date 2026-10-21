import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createServer } from "node:http";
import { codeChallengeS256, isAllowedRedirect, parseConnectorResource, readPayload, TOKEN_TTL } from "../functions/_lib/_oauth.js";
import { handleRequest, LINK_STATUS_TEXT } from "../functions/_lib/_server.js";

const SECRET = "test-key-test-key-test-key-test-key";
const NOW = 1_700_000_000;
const ORIGIN = "https://grokwallet.fun";
const ENV = { GROKWALLET_OAUTH_HMAC_KEY: SECRET };
const REDIRECTS = [
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "https://bot.example/oauth/callback?listen=1",
  "http://localhost:8787/any/path",
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

async function approvalProof(txn, userCode) {
  const response = await call("/oauth/proof", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txn, user_code: userCode }),
  });
  assert.equal(response.status, 200, response.text);
  return response.payload.proof;
}

async function completeApproval(txn, userCode) {
  const proof = await approvalProof(txn, userCode);
  return call(
    `/oauth/complete?txn=${encodeURIComponent(txn)}&user_code=${encodeURIComponent(userCode)}&proof=${encodeURIComponent(proof)}`,
  );
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

test("registration accepts any https URI and loopback http", () => {
  for (const uri of REDIRECTS) assert.equal(isAllowedRedirect(uri), true);
  assert.equal(isAllowedRedirect("https://evil.example/callback"), true);
  assert.equal(isAllowedRedirect("http://127.0.0.1:9/cb/extra"), true);
  assert.equal(isAllowedRedirect("http://127.0.0.1/callback"), true);
  assert.equal(isAllowedRedirect("javascript:https://www.cursor.com/agents/mcp/oauth/callback"), false);
  assert.equal(isAllowedRedirect("cursor://anysphere.cursor-mcp/oauth/callback"), false);
  assert.equal(isAllowedRedirect("https://user@www.cursor.com/agents/mcp/oauth/callback"), false);
  assert.equal(isAllowedRedirect("http://localhost:8787/callback/../steal"), false);
  assert.equal(isAllowedRedirect("http://evil.example/callback"), false);
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

  const txn = approval.searchParams.get("oauth_return");
  const withoutProof = await call(`/oauth/complete?txn=${encodeURIComponent(txn)}&user_code=ABCD-1234`);
  assert.equal(withoutProof.status, 400);
  assert.equal(withoutProof.headers.get("location"), null);
  assert.equal(withoutProof.text.includes("code="), false);
  const done = await completeApproval(txn, "ABCD-1234");
  assert.equal(done.status, 302);
  const back = new URL(done.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECTS[0]);
  assert.equal(back.searchParams.get("state"), "state-1");
  const code = back.searchParams.get("code");
  assert.match(code, /^gw1\./);
  const clientPayload = await readPayload(clientId, SECRET, "client", NOW);
  const codePayload = await readPayload(code, SECRET, "code", NOW);
  assert.deepEqual(clientPayload.uris, REDIRECTS);
  assert.equal(codePayload.redir, REDIRECTS[0]);
  assert.equal(codePayload.aud, resource);

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

  const matched = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(form), resource }),
  });
  assert.equal(matched.status, 200);
  const otherResource = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...Object.fromEntries(form),
      resource: "https://grokwallet.fun/mcp/c/WXYZ-9876",
    }),
  });
  assert.equal(otherResource.status, 400);
  assert.equal(otherResource.payload.error, "invalid_target");

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

test("completion requires an approval proof bound to that user code, and deny returns access_denied", async () => {
  const verifier = `${"f".repeat(43)}-verifier`;
  const challenge = await codeChallengeS256(verifier);
  const clientId = await register();
  const first = await authorize(clientId, { resource: "https://grokwallet.fun/mcp/c/ABCD-1234", challenge, state: "one" });
  const second = await authorize(clientId, { resource: "https://grokwallet.fun/mcp/c/ABCD-1234", challenge, state: "two" });
  const txnOne = new URL(first.headers.get("location")).searchParams.get("oauth_return");
  const txnTwo = new URL(second.headers.get("location")).searchParams.get("oauth_return");
  const proofOne = await approvalProof(txnOne, "ABCD-1234");
  const crossed = await call(
    `/oauth/complete?txn=${encodeURIComponent(txnTwo)}&user_code=ABCD-1234&proof=${encodeURIComponent(proofOne)}`,
  );
  assert.equal(crossed.status, 400);
  assert.equal(crossed.headers.get("location"), null);
  const otherCode = await call("/oauth/proof", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txn: txnOne, user_code: "ZZZZ-9999" }),
  });
  assert.equal(otherCode.status, 400);
  const denied = await call(`/oauth/complete?txn=${encodeURIComponent(txnTwo)}&user_code=ABCD-1234&deny=1`);
  assert.equal(denied.status, 302);
  const back = new URL(denied.headers.get("location"));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("code"), null);
  assert.equal(back.searchParams.get("state"), "two");
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

test("registration rejects non-https and non-loopback redirects", async () => {
  for (const uri of ["http://evil.example/callback", "cursor://anysphere.cursor-mcp/oauth/callback", "javascript:alert(1)"]) {
    const response = await call("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [uri] }),
    });
    assert.equal(response.status, 400, uri);
    assert.equal(response.payload.error, "invalid_redirect_uri");
    assert.equal(response.text.includes(uri), false);
  }
  const accepted = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/callback", "http://127.0.0.1:4242/cb"] }),
  });
  assert.equal(accepted.status, 201);
  const stored = await readPayload(accepted.payload.client_id, SECRET, "client", NOW);
  assert.deepEqual(stored.uris, ["https://evil.example/callback", "http://127.0.0.1:4242/cb"]);
});

test("metadata and a missing HMAC key", async () => {
  const as = await call("/.well-known/oauth-authorization-server");
  assert.equal(as.status, 200);
  assert.equal(as.payload.issuer, ORIGIN);
  assert.equal(as.payload.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.deepEqual(as.payload.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.payload.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(as.payload.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(as.payload.token_endpoint_auth_methods_supported, ["none", "client_secret_post", "client_secret_basic"]);

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

const GROK_REGISTRATION = {
  redirect_uris: ["https://www.cursor.com/bot/mcp/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_name: "Grok Bot",
};

test("registration accepts the Grok Bot payload and ignores unknown extras", async () => {
  const response = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...GROK_REGISTRATION,
      grant_types: ["authorization_code", "refresh_token", "urn:example:ignored"],
      response_types: ["code", "token"],
      client_uri: "https://example.com/grok",
      client_secret: "sent-by-the-client",
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.payload.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(response.payload.response_types, ["code"]);
  assert.equal(response.payload.token_endpoint_auth_method, "none");
  assert.equal(Object.hasOwn(response.payload, "client_secret"), false);
  assert.equal(response.text.includes("sent-by-the-client"), false);
  const stored = await readPayload(response.payload.client_id, SECRET, "client", NOW);
  assert.deepEqual(stored.grants, ["authorization_code", "refresh_token"]);
  assert.equal(stored.auth, "none");

  const onlyRefresh = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: GROK_REGISTRATION.redirect_uris, grant_types: ["refresh_token"] }),
  });
  assert.equal(onlyRefresh.status, 400);
  assert.equal(onlyRefresh.payload.error, "invalid_client_metadata");

  const privateKey = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...GROK_REGISTRATION, token_endpoint_auth_method: "private_key_jwt" }),
  });
  assert.equal(privateKey.status, 400);
  assert.equal(privateKey.payload.error, "invalid_client_metadata");
});

test("refresh returns a link_status token and a confidential client must present its secret", async () => {
  const verifier = `${"d".repeat(43)}-verifier`;
  const challenge = await codeChallengeS256(verifier);
  const registered = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(GROK_REGISTRATION),
  });
  assert.equal(registered.status, 201);
  const clientId = registered.payload.client_id;
  const resource = "https://grokwallet.fun/mcp/c/TEST-CODE";
  const started = await authorize(clientId, {
    resource,
    redirect: GROK_REGISTRATION.redirect_uris[0],
    challenge,
    state: "grok",
  });
  const approval = new URL(started.headers.get("location"));
  assert.equal(approval.searchParams.get("user_code"), "TEST-CODE");
  const done = await completeApproval(approval.searchParams.get("oauth_return"), "TEST-CODE");
  const back = new URL(done.headers.get("location"));
  const code = back.searchParams.get("code");
  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: GROK_REGISTRATION.redirect_uris[0],
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  assert.equal(token.status, 200);
  assert.equal(token.payload.expires_in, TOKEN_TTL);
  assert.equal(TOKEN_TTL, 30 * 24 * 60 * 60);
  assert.match(token.payload.refresh_token, /^gw1\./);
  const refreshPayload = await readPayload(token.payload.refresh_token, SECRET, "refresh", NOW);
  assert.equal(refreshPayload.aud, resource);

  const stillValid = await call("/mcp/c/TEST-CODE", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token.payload.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "link_status", arguments: {} } }),
    now: NOW + 11 * 60,
  });
  assert.equal(stillValid.status, 200);

  const expiredAccess = await call("/mcp/c/TEST-CODE", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token.payload.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    now: NOW + TOKEN_TTL + 5,
  });
  assert.equal(expiredAccess.status, 401);

  const refreshed = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.payload.refresh_token,
      client_id: clientId,
      resource,
    }),
    now: NOW + TOKEN_TTL + 5,
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.payload.expires_in, TOKEN_TTL);
  assert.match(refreshed.payload.refresh_token, /^gw1\./);
  assert.notEqual(refreshed.payload.access_token, token.payload.access_token);
  const afterRefresh = await call("/mcp/c/TEST-CODE", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${refreshed.payload.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    now: NOW + TOKEN_TTL + 5,
  });
  assert.equal(afterRefresh.status, 200);

  const otherClient = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...GROK_REGISTRATION,
      redirect_uris: ["https://www.cursor.com/bot/mcp/oauth/callback-other"],
    }),
  });
  const wrongClient = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.payload.refresh_token,
      client_id: otherClient.payload.client_id,
    }),
  });
  assert.equal(wrongClient.status, 400);
  assert.equal(wrongClient.payload.error, "invalid_grant");

  const secretClient = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...GROK_REGISTRATION, token_endpoint_auth_method: "client_secret_basic" }),
  });
  assert.equal(secretClient.status, 201);
  assert.equal(secretClient.payload.token_endpoint_auth_method, "client_secret_basic");
  assert.match(secretClient.payload.client_secret, /^[A-Za-z0-9_-]+$/);
  const secretId = secretClient.payload.client_id;
  const secret = secretClient.payload.client_secret;
  const secretStart = await authorize(secretId, {
    resource,
    redirect: GROK_REGISTRATION.redirect_uris[0],
    challenge,
    state: "sec",
  });
  const secretApproval = new URL(secretStart.headers.get("location"));
  const secretDone = await completeApproval(secretApproval.searchParams.get("oauth_return"), "TEST-CODE");
  const secretCode = new URL(secretDone.headers.get("location")).searchParams.get("code");
  const noSecret = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: secretCode,
      redirect_uri: GROK_REGISTRATION.redirect_uris[0],
      client_id: secretId,
      code_verifier: verifier,
    }),
  });
  assert.equal(noSecret.status, 401);
  assert.equal(noSecret.payload.error, "invalid_client");
  const basic = Buffer.from(`${secretId}:${secret}`, "utf8").toString("base64");
  const withBasic = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: secretCode,
      redirect_uri: GROK_REGISTRATION.redirect_uris[0],
      code_verifier: verifier,
    }),
  });
  assert.equal(withBasic.status, 200);
  const postSecret = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...GROK_REGISTRATION, token_endpoint_auth_method: "client_secret_post" }),
  });
  assert.equal(postSecret.payload.token_endpoint_auth_method, "client_secret_post");
  assert.equal(Object.hasOwn(postSecret.payload, "client_secret"), true);
});

function listenLocal() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === "host" || key === "content-length" || key === "transfer-encoding" || value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else headers.set(key, value);
    }
    const body = Buffer.concat(chunks);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await handleRequest(request, ENV, { now: NOW, allowLocal: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    const out = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out);
    res.end(bytes);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("local connector flow discovers metadata, registers, refreshes, and calls link_status", async () => {
  const server = await listenLocal();
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const resource = `${origin}/mcp/c/TEST-CODE`;
  try {
    const bare = await fetch(resource, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }),
    });
    assert.equal(bare.status, 401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(bare.headers.get("www-authenticate"))[1];
    const prm = await (await fetch(metadataUrl)).json();
    assert.equal(prm.resource, resource);
    const issuer = prm.authorization_servers[0];
    const as = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.registration_endpoint, `${origin}/oauth/register`);
    assert.ok(as.grant_types_supported.includes("refresh_token"));
    const registered = await fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GROK_REGISTRATION),
    });
    assert.equal(registered.status, 201);
    const client = await registered.json();
    const verifier = `${"e".repeat(43)}-verifier`;
    const challenge = await codeChallengeS256(verifier);
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", GROK_REGISTRATION.redirect_uris[0]);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "local");
    authorizeUrl.searchParams.set("scope", "link_status");
    authorizeUrl.searchParams.set("resource", resource);
    const started = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(started.status, 302);
    const approval = new URL(started.headers.get("location"));
    assert.equal(approval.origin, origin);
    assert.equal(approval.pathname, "/");
    assert.equal(approval.searchParams.get("user_code"), "TEST-CODE");
    const txn = approval.searchParams.get("oauth_return");
    const premature = await fetch(`${origin}/oauth/complete?txn=${encodeURIComponent(txn)}&user_code=TEST-CODE`, {
      redirect: "manual",
    });
    assert.equal(premature.status, 400);
    assert.equal(premature.headers.get("location"), null);
    const proved = await fetch(`${origin}/oauth/proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txn, user_code: "TEST-CODE" }),
    });
    assert.equal(proved.status, 200);
    const { proof } = await proved.json();
    const complete = await fetch(
      `${origin}/oauth/complete?txn=${encodeURIComponent(txn)}&user_code=TEST-CODE&proof=${encodeURIComponent(proof)}`,
      { redirect: "manual" },
    );
    assert.equal(complete.status, 302);
    const callback = new URL(complete.headers.get("location"));
    assert.equal(`${callback.origin}${callback.pathname}`, GROK_REGISTRATION.redirect_uris[0]);
    const tokenResponse = await fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        redirect_uri: GROK_REGISTRATION.redirect_uris[0],
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    const refreshResponse = await fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: client.client_id,
      }),
    });
    const refreshed = await refreshResponse.json();
    assert.equal(refreshResponse.status, 200);
    for (const [method, id] of [
      ["initialize", 1],
      ["tools/list", 2],
      ["tools/call", 3],
    ]) {
      const body =
        method === "tools/call"
          ? { jsonrpc: "2.0", id, method, params: { name: "link_status", arguments: {} } }
          : { jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : {} };
      const rpc = await fetch(resource, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${refreshed.access_token}`,
        },
        body: JSON.stringify(body),
      });
      const payload = await rpc.json();
      assert.equal(rpc.status, 200, method);
      if (method === "initialize") assert.equal(payload.result.serverInfo.name, "grokwallet-link");
      if (method === "tools/list") assert.equal(payload.result.tools[0].name, "link_status");
      if (method === "tools/call") assert.equal(payload.result.content[0].text, LINK_STATUS_TEXT);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("Pages functions do not reference Privy credentials", () => {
  const banned = ["device_code", "auth.privy.io", "GROKWALLET_PASSPHRASE", "BEGIN PRIVATE KEY", "privy-app-id"];
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
