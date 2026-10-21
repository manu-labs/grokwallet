// Stateless MCP OAuth for the Connect card.
// Tokens are HMAC-signed. Nothing here is a Privy credential.

const TEXT = new TextEncoder();
const SCOPE = "link_status";

export const USER_CODE = /^[A-Za-z0-9]{4,16}(?:-[A-Za-z0-9]{4,16})?$/;

// Registration accepts any https URI, and http only for localhost or
// 127.0.0.1. /authorize then requires an exact match against the URIs stored
// in the signed client id, so a registered client cannot be sent elsewhere.

const CLIENT_TTL = 90 * 24 * 60 * 60;
const TXN_TTL = 10 * 60;
const CODE_TTL = 60;
const PROOF_TTL = 2 * 60;
// link_status grants nothing about the wallet, so the connector can keep the
// access token for a month. The refresh token outlives it.
export const TOKEN_TTL = 30 * 24 * 60 * 60;
export const REFRESH_TTL = 90 * 24 * 60 * 60;
const GRANT_ORDER = ["authorization_code", "refresh_token"];
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];

export function base64urlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64urlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  let binary;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isPublicHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "grokwallet.fun" || host === "www.grokwallet.fun" || host === "grokwallet.pages.dev" || host.endsWith(".grokwallet.pages.dev");
}

export function isAllowedRedirect(uri) {
  if (typeof uri !== "string" || uri.length < 8 || uri.length > 512) return false;
  if (/[\s#\\]/.test(uri) || uri.includes("..")) return false;
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || url.origin === "null" || !url.hostname) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

function decodeUserCode(raw) {
  if (typeof raw !== "string" || raw.length < 4 || raw.length > 64) return "";
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return "";
  }
  if (!USER_CODE.test(value)) return "";
  return value;
}

export function parseConnectorResource(value, expectedOrigin) {
  if (typeof value !== "string" || value.length > 300) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const localHttp = url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1");
  if (url.protocol === "https:") {
    if (!isPublicHost(host)) return null;
  } else if (!localHttp) {
    return null;
  } else if (!expectedOrigin || url.origin !== expectedOrigin) {
    return null;
  }
  if (expectedOrigin && url.origin !== expectedOrigin) return null;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const pathCode = /^\/mcp\/c\/([^/]+)$/.exec(path);
  if (pathCode) {
    if (url.search) return null;
    const userCode = decodeUserCode(pathCode[1]);
    if (!userCode) return null;
    return {
      userCode,
      origin: url.origin,
      canonical: `${url.origin}/mcp/c/${encodeURIComponent(userCode)}`,
    };
  }
  if (path === "/mcp") {
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== "code") return null;
    const userCode = decodeUserCode(url.searchParams.get("code") || "");
    if (!userCode) return null;
    return {
      userCode,
      origin: url.origin,
      canonical: `${url.origin}/mcp?code=${encodeURIComponent(userCode)}`,
    };
  }
  return null;
}

export function approvalUrl(origin, userCode, txn) {
  const url = new URL("/", origin);
  url.searchParams.set("user_code", userCode);
  url.searchParams.set("oauth_return", txn);
  return url.toString();
}

export function redirectTarget(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function importKey(secret) {
  const trimmed = typeof secret === "string" ? secret.trim() : "";
  if (trimmed.length < 32) return null;
  return crypto.subtle.importKey("raw", TEXT.encode(trimmed), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function hmacSecret(env) {
  const value = env && typeof env.GROKWALLET_OAUTH_HMAC_KEY === "string" ? env.GROKWALLET_OAUTH_HMAC_KEY.trim() : "";
  return value.length >= 32 ? value : "";
}

async function signPayload(payload, secret) {
  const key = await importKey(secret);
  if (!key) return "";
  const body = base64urlEncode(TEXT.encode(JSON.stringify(payload)));
  const signed = TEXT.encode(`gw1.${body}`);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return `gw1.${body}.${base64urlEncode(sig)}`;
}

export async function readPayload(token, secret, typ, now) {
  if (typeof token !== "string" || token.length < 20 || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "gw1") return null;
  const key = await importKey(secret);
  if (!key) return null;
  const sig = base64urlDecode(parts[2]);
  if (!sig) return null;
  const ok = await crypto.subtle.verify("HMAC", key, sig, TEXT.encode(`gw1.${parts[1]}`));
  if (!ok) return null;
  let payload;
  try {
    const raw = base64urlDecode(parts[1]);
    if (!raw) return null;
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || payload.typ !== typ) return null;
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
  if (payload.iat > now + 60 || payload.exp < now) return null;
  return payload;
}

export async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", TEXT.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function codeChallengeS256(verifier) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", TEXT.encode(verifier)));
  return base64urlEncode(digest);
}

export function validVerifier(verifier) {
  return typeof verifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

function sameString(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

function selectKnown(values, allowed, required) {
  if (values === undefined) return { granted: [required] };
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) return { error: "invalid list" };
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 1 || value.length > 64) return { error: "invalid list" };
    seen.add(value);
  }
  const granted = allowed.filter((value) => seen.has(value));
  if (!granted.includes(required)) return { error: `missing ${required}` };
  return { granted };
}

async function deriveClientSecret(clientId, secret) {
  const key = await importKey(secret);
  if (!key) return "";
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, TEXT.encode(`gw1.secret.${clientId}`)));
  return base64urlEncode(sig);
}

function parseBasic(authorization) {
  if (!authorization) return null;
  const trimmed = authorization.trim();
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(trimmed);
  if (!match) return { error: true };
  let binary;
  try {
    const pad = match[1].length % 4 === 0 ? "" : "=".repeat(4 - (match[1].length % 4));
    binary = atob(match[1].replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch {
    return { error: true };
  }
  const split = binary.indexOf(":");
  if (split < 0) return { error: true };
  let id;
  let secret;
  try {
    id = decodeURIComponent(binary.slice(0, split).replace(/\+/g, " "));
    secret = decodeURIComponent(binary.slice(split + 1).replace(/\+/g, " "));
  } catch {
    return { error: true };
  }
  if (!id) return { error: true };
  return { id, secret };
}

export function metadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: GRANT_ORDER,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [SCOPE],
  };
}

export function protectedResource(origin, resource) {
  return {
    resource,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "GrokWallet link",
  };
}

export async function registerClient(body, secret, now) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid_client_metadata", description: "registration body must be a JSON object" };
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) {
    return { error: "invalid_client_metadata", description: "redirect_uris must contain 1 to 5 URIs" };
  }
  for (const uri of uris) {
    if (!isAllowedRedirect(uri)) return { error: "invalid_redirect_uri", description: "redirect_uri is not allowed" };
  }
  // Unknown grant names and unknown metadata fields are ignored. authorization_code
  // is required. refresh_token is kept when the client asks for it.
  const grants = selectKnown(body.grant_types, GRANT_ORDER, "authorization_code");
  if (grants.error) {
    return { error: "invalid_client_metadata", description: "authorization_code is required" };
  }
  const responses = selectKnown(body.response_types, ["code"], "code");
  if (responses.error) {
    return { error: "invalid_client_metadata", description: "response_types must include code" };
  }
  const authMethod = body.token_endpoint_auth_method === undefined ? "none" : body.token_endpoint_auth_method;
  if (typeof authMethod !== "string" || !AUTH_METHODS.includes(authMethod)) {
    return { error: "invalid_client_metadata", description: "unsupported token_endpoint_auth_method" };
  }
  const clientId = await signPayload(
    { v: 1, typ: "client", uris, grants: grants.granted, auth: authMethod, iat: now, exp: now + CLIENT_TTL },
    secret,
  );
  if (!clientId) return { error: "server_error", description: "GROKWALLET_OAUTH_HMAC_KEY is not configured" };
  const client = {
    client_id: clientId,
    client_id_issued_at: now,
    redirect_uris: uris,
    grant_types: grants.granted,
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    scope: SCOPE,
  };
  if (authMethod !== "none") {
    const clientSecret = await deriveClientSecret(clientId, secret);
    if (!clientSecret) return { error: "server_error", description: "GROKWALLET_OAUTH_HMAC_KEY is not configured" };
    client.client_secret = clientSecret;
    client.client_secret_expires_at = now + CLIENT_TTL;
  }
  return { client };
}

function validState(state) {
  return state === "" || /^[\x21-\x7E]{1,512}$/.test(state);
}

export async function startAuthorization(searchParams, origin, secret, now) {
  const clientId = searchParams.get("client_id") || "";
  const redirectUri = searchParams.get("redirect_uri") || "";
  const client = await readPayload(clientId, secret, "client", now);
  if (!client || !Array.isArray(client.uris)) return { status: 400, error: "invalid_client" };
  if (!client.uris.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    return { status: 400, error: "invalid_request", description: "redirect_uri does not match the registered client" };
  }
  const state = searchParams.get("state") || "";
  if (!validState(state)) {
    return { redirect: redirectTarget(redirectUri, { error: "invalid_request", state: "" }) };
  }
  const fail = (error) => ({ redirect: redirectTarget(redirectUri, { error, state }) });
  if ((searchParams.get("response_type") || "") !== "code") return fail("unsupported_response_type");
  if ((searchParams.get("code_challenge_method") || "") !== "S256") return fail("invalid_request");
  const challenge = searchParams.get("code_challenge") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request");
  const scope = searchParams.get("scope") || SCOPE;
  if (scope !== SCOPE) return fail("invalid_scope");
  // Bind the connector URL into the signed transaction. /oauth/token may omit
  // resource and will use this value. A resource that is present must parse as
  // one of this host's connector URLs.
  const resource = parseConnectorResource(searchParams.get("resource") || "", origin);
  if (!resource) return fail("invalid_target");
  const txn = await signPayload(
    {
      v: 1,
      typ: "txn",
      aud: resource.canonical,
      code: resource.userCode,
      redir: redirectUri,
      chal: challenge,
      cid: await sha256Hex(clientId),
      state,
      n: randomId(),
      iat: now,
      exp: now + TXN_TTL,
    },
    secret,
  );
  if (!txn) return { status: 503, error: "server_error" };
  return { redirect: approvalUrl(origin, resource.userCode, txn) };
}

export async function issueApprovalProof(txnToken, userCode, secret, now) {
  const txn = await readPayload(txnToken, secret, "txn", now);
  if (!txn || !isAllowedRedirect(txn.redir) || typeof txn.code !== "string") {
    return { status: 400, error: "invalid_request" };
  }
  if (userCode !== txn.code) return { status: 400, error: "invalid_request" };
  const proof = await signPayload(
    {
      v: 1,
      typ: "approval",
      code: txn.code,
      bind: await sha256Hex(txnToken),
      iat: now,
      exp: now + PROOF_TTL,
    },
    secret,
  );
  if (!proof) return { status: 503, error: "server_error" };
  return { status: 200, body: { proof } };
}

export async function completeAuthorization(searchParams, secret, now) {
  const txnToken = searchParams.get("txn") || "";
  const txn = await readPayload(txnToken, secret, "txn", now);
  if (!txn || !isAllowedRedirect(txn.redir) || typeof txn.aud !== "string" || typeof txn.code !== "string") {
    return { status: 400, error: "invalid_request" };
  }
  if ((searchParams.get("user_code") || "") !== txn.code) return { status: 400, error: "invalid_request" };
  if (searchParams.get("deny") === "1") {
    return { redirect: redirectTarget(txn.redir, { error: "access_denied", state: txn.state || "" }) };
  }
  const proof = await readPayload(searchParams.get("proof") || "", secret, "approval", now);
  if (!proof || proof.code !== txn.code || proof.bind !== (await sha256Hex(txnToken))) {
    return { status: 400, error: "access_denied", description: "approval proof required" };
  }
  const code = await signPayload(
    {
      v: 1,
      typ: "code",
      aud: txn.aud,
      code: txn.code,
      redir: txn.redir,
      chal: txn.chal,
      cid: txn.cid,
      iat: now,
      exp: now + CODE_TTL,
    },
    secret,
  );
  if (!code) return { status: 503, error: "server_error" };
  return { redirect: redirectTarget(txn.redir, { code, state: txn.state || "" }) };
}

async function authenticateClient(params, authorization, secret, now) {
  const basic = parseBasic(authorization);
  if (basic && basic.error) return { status: 401, error: "invalid_client" };
  let clientId = params.get("client_id") || "";
  let presented = params.get("client_secret") || "";
  if (basic && !basic.error) {
    if (clientId && clientId !== basic.id) return { status: 401, error: "invalid_client" };
    if (!clientId) clientId = basic.id;
    if (!presented) presented = basic.secret;
  }
  const client = await readPayload(clientId, secret, "client", now);
  if (!client || !Array.isArray(client.uris)) return { status: 401, error: "invalid_client" };
  const method = client.auth || "none";
  if (method === "none") return { client, clientId };
  const expected = await deriveClientSecret(clientId, secret);
  if (!presented || !expected || !sameString(presented, expected)) return { status: 401, error: "invalid_client" };
  return { client, clientId };
}

function grantsOf(client) {
  return Array.isArray(client.grants) ? client.grants : ["authorization_code"];
}

function resourceMatches(requested, audience) {
  if (!requested) return true;
  let parsed = null;
  try {
    parsed = parseConnectorResource(requested, new URL(audience).origin);
  } catch {
    parsed = null;
  }
  return Boolean(parsed && parsed.canonical === audience);
}

async function tokenBody(audience, clientId, client, secret, now) {
  const access = await signPayload(
    { v: 1, typ: "token", aud: audience, sub: "link", scope: SCOPE, iat: now, exp: now + TOKEN_TTL },
    secret,
  );
  if (!access) return { status: 503, error: "server_error" };
  const body = { access_token: access, token_type: "Bearer", expires_in: TOKEN_TTL, scope: SCOPE };
  if (grantsOf(client).includes("refresh_token")) {
    const refresh = await signPayload(
      {
        v: 1,
        typ: "refresh",
        aud: audience,
        cid: await sha256Hex(clientId),
        scope: SCOPE,
        iat: now,
        exp: now + REFRESH_TTL,
      },
      secret,
    );
    if (!refresh) return { status: 503, error: "server_error" };
    body.refresh_token = refresh;
  }
  return { status: 200, body };
}

export async function exchangeToken(params, secret, now, authorization = "") {
  const authed = await authenticateClient(params, authorization, secret, now);
  if (authed.error) return { status: authed.status, error: authed.error };
  const { client, clientId } = authed;
  const grant = params.get("grant_type") || "";
  if (grant === "refresh_token") {
    if (!grantsOf(client).includes("refresh_token")) return { status: 400, error: "unauthorized_client" };
    const refresh = await readPayload(params.get("refresh_token") || "", secret, "refresh", now);
    if (!refresh || refresh.scope !== SCOPE || typeof refresh.aud !== "string") return { status: 400, error: "invalid_grant" };
    if ((await sha256Hex(clientId)) !== refresh.cid) return { status: 400, error: "invalid_grant" };
    if (!resourceMatches(params.get("resource") || "", refresh.aud)) return { status: 400, error: "invalid_target" };
    return tokenBody(refresh.aud, clientId, client, secret, now);
  }
  if (grant !== "authorization_code") return { status: 400, error: "unsupported_grant_type" };
  const code = await readPayload(params.get("code") || "", secret, "code", now);
  if (!code) return { status: 400, error: "invalid_grant" };
  if ((await sha256Hex(clientId)) !== code.cid) return { status: 400, error: "invalid_grant" };
  if (
    (params.get("redirect_uri") || "") !== code.redir ||
    !Array.isArray(client.uris) ||
    !client.uris.includes(code.redir) ||
    !isAllowedRedirect(code.redir)
  ) {
    return { status: 400, error: "invalid_grant" };
  }
  // resource is optional. When the client sends it, it must be the connector
  // URL bound into this code at /oauth/authorize. When it is absent, that
  // bound URL is the audience.
  if (!resourceMatches(params.get("resource") || "", code.aud)) return { status: 400, error: "invalid_target" };
  const verifier = params.get("code_verifier") || "";
  if (!validVerifier(verifier)) return { status: 400, error: "invalid_grant" };
  const expected = await codeChallengeS256(verifier);
  if (!sameString(expected, code.chal)) return { status: 400, error: "invalid_grant" };
  return tokenBody(code.aud, clientId, client, secret, now);
}

export async function accessTokenAudience(token, secret, now) {
  const payload = await readPayload(token, secret, "token", now);
  if (!payload || payload.sub !== "link" || payload.scope !== SCOPE || typeof payload.aud !== "string") return "";
  return payload.aud;
}
