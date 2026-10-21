import { randomUUID } from "node:crypto";
import { CliError, redact } from "./redact.js";
import { authBase } from "./home.js";
import { buildSignaturePayload, signPayload } from "./canon.js";
import { createHpkeRecipient } from "./hpke.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export function formatLoginPrompt({ verificationUriComplete, userCode, connectorUrl = "" }) {
  const lines = [`verification_uri_complete: ${verificationUriComplete}`, `user_code: ${userCode}`];
  if (connectorUrl) lines.push(`connector_url: ${connectorUrl}`);
  return `${lines.join("\n")}\n`;
}

async function readError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const code = payload && typeof payload.error === "string" ? payload.error : "";
  const description =
    payload && typeof payload.error_description === "string" ? payload.error_description.slice(0, 180) : "";
  return { code, description, payload };
}

async function postJson(url, { appId, token, grantType, headers = {}, body, fetchImpl }) {
  const requestHeaders = {
    "content-type": "application/json",
    "privy-app-id": appId,
    ...headers,
  };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (grantType) requestHeaders["privy-grant-type"] = grantType;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
  return response;
}

export async function requestDeviceCode({ appId, fetchImpl = fetch, base = authBase() }) {
  const response = await postJson(`${base}/api/oauth/v2/device_authorization`, {
    appId,
    body: {},
    fetchImpl,
  });
  if (response.status === 403) {
    throw new CliError(
      "Privy returned 403 device_auth_not_enabled. Enable CLI and agent access on the Privy app and set the verification URI.",
    );
  }
  if (!response.ok) {
    const error = await readError(response);
    throw new CliError(`device authorization failed (${response.status} ${error.code || "error"})`);
  }
  const payload = await response.json();
  for (const field of ["device_code", "user_code", "verification_uri_complete", "expires_in", "interval"]) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === "") {
      throw new CliError("device authorization response was missing a required field");
    }
  }
  return payload;
}

export async function pollDeviceToken({
  appId,
  deviceCode,
  intervalSeconds,
  expiresInSeconds,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  base = authBase(),
}) {
  let interval = Number(intervalSeconds) || 5;
  const deadline = now() + Number(expiresInSeconds) * 1000;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const response = await postJson(`${base}/api/oauth/v2/token`, {
      appId,
      body: { grant_type: DEVICE_GRANT, device_code: deviceCode },
      fetchImpl,
    });
    if (response.ok) {
      const payload = await response.json();
      if (!payload.access_token || !payload.refresh_token) {
        throw new CliError("token response did not include access and refresh tokens");
      }
      return payload;
    }
    const error = await readError(response);
    if (error.code === "authorization_pending") continue;
    if (error.code === "slow_down") {
      interval += 5;
      continue;
    }
    if (error.code === "access_denied") throw new CliError("the user denied agent access");
    if (error.code === "expired_token") throw new CliError("the device code expired. Run login again.");
    throw new CliError(`token request failed (${response.status} ${error.code || "error"})`);
  }
  throw new CliError("timed out waiting for approval. Run login again.");
}

export async function refreshAccessToken({ appId, refreshToken, fetchImpl = fetch, base = authBase() }) {
  const response = await postJson(`${base}/api/oauth/v2/token`, {
    appId,
    body: { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl,
  });
  if (!response.ok) {
    const error = await readError(response);
    if (error.code === "access_denied" || response.status === 401) {
      throw new CliError("the refresh token is no longer valid. Run login again.");
    }
    throw new CliError(`refresh failed (${response.status} ${error.code || "error"})`);
  }
  const payload = await response.json();
  if (!payload.access_token || !payload.refresh_token) {
    throw new CliError("refresh response did not include rotated tokens");
  }
  return payload;
}

function expiresAtMs(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw new CliError("signing key response did not include expires_at");
  return parsed;
}

export async function authenticateWallets({ appId, accessToken, fetchImpl = fetch, base = authBase() }) {
  const recipient = await createHpkeRecipient();
  const response = await postJson(`${base}/api/oauth/v2/wallets/authenticate`, {
    appId,
    token: accessToken,
    grantType: "device_code",
    body: {
      encryption_type: "HPKE",
      recipient_public_key: recipient.publicKeyBase64,
    },
    fetchImpl,
  });
  if (!response.ok) {
    const error = await readError(response);
    throw new CliError(`wallet authenticate failed (${response.status} ${error.code || "error"})`);
  }
  const payload = await response.json();
  const encrypted = payload.encrypted_authorization_key;
  if (!encrypted?.encapsulated_key || !encrypted?.ciphertext) {
    throw new CliError("wallet authenticate response did not include an encrypted signing key");
  }
  const authorizationKey = await recipient.decrypt(encrypted.encapsulated_key, encrypted.ciphertext);
  const wallets = Array.isArray(payload.wallets) ? payload.wallets : [];
  return {
    authorizationKey,
    expiresAt: expiresAtMs(payload.expires_at),
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      address: wallet.address,
      chainType: wallet.chain_type || wallet.chainType,
    })),
  };
}

export async function walletRpc({
  appId,
  accessToken,
  authorizationKey,
  walletId,
  body,
  idempotencyKey,
  fetchImpl = fetch,
  base = authBase(),
  now = () => Date.now(),
}) {
  const url = `${base}/api/oauth/v2/wallets/${encodeURIComponent(walletId)}/rpc`;
  const requestExpiry = String(now() + 5 * 60 * 1000);
  const payload = buildSignaturePayload({
    method: "POST",
    url,
    body,
    appId,
    idempotencyKey,
    requestExpiry,
  });
  const signature = signPayload(payload, authorizationKey);
  const response = await postJson(url, {
    appId,
    token: accessToken,
    grantType: "device_code",
    headers: {
      "privy-authorization-signature": signature,
      "privy-request-expiry": requestExpiry,
      ...(idempotencyKey ? { "privy-idempotency-key": idempotencyKey } : {}),
    },
    body,
    fetchImpl,
  });
  if (!response.ok) {
    const error = await readError(response);
    if (response.status === 401) throw new CliError("access token expired", 401);
    if (response.status === 403) throw new CliError("wallet is not accessible to this agent");
    throw new CliError(
      redact(`wallet rpc failed (${response.status} ${error.code || "error"} ${error.description})`.trim()),
    );
  }
  return response.json();
}

export function newIdempotencyKey() {
  return randomUUID();
}

export { DEVICE_GRANT };
