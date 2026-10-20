import canonicalize from "canonicalize";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { CliError } from "./redact.js";

const SIGNED_HEADER_NAMES = ["privy-app-id", "privy-idempotency-key", "privy-request-expiry"];

/**
 * Build the authorization-signature payload Privy's SDK signs.
 * Header set matches @privy-io/node formatRequestForAuthorizationSignature:
 * privy-app-id, and privy-idempotency-key / privy-request-expiry only when present.
 * An empty object body is signed as "" (SDK special case).
 */
export function buildSignaturePayload({ method, url, body, appId, idempotencyKey, requestExpiry }) {
  if (!appId) throw new CliError("missing app id for authorization signature");
  if (typeof url !== "string" || url.endsWith("/")) {
    throw new CliError("authorization signature URL must not have a trailing slash");
  }
  const headers = { "privy-app-id": appId };
  if (idempotencyKey) headers["privy-idempotency-key"] = idempotencyKey;
  if (requestExpiry !== undefined && requestExpiry !== null && requestExpiry !== "") {
    headers["privy-request-expiry"] = String(requestExpiry);
  }
  for (const name of Object.keys(headers)) {
    if (!SIGNED_HEADER_NAMES.includes(name)) {
      throw new CliError(`refusing to sign unexpected header ${name}`);
    }
  }
  let signedBody = body;
  if (signedBody && typeof signedBody === "object" && !Array.isArray(signedBody) && Object.keys(signedBody).length === 0) {
    signedBody = "";
  }
  return {
    version: 1,
    method,
    url,
    body: signedBody,
    headers,
  };
}

export function canonicalizePayload(payload) {
  const serialized = canonicalize(payload);
  if (typeof serialized !== "string") {
    throw new CliError("failed to canonicalize the authorization payload");
  }
  return serialized;
}

export function signPayload(payload, pkcs8Base64) {
  const serialized = canonicalizePayload(payload);
  const privateKey = createPrivateKey({
    key: pemFromPkcs8(pkcs8Base64),
    format: "pem",
  });
  return sign("sha256", Buffer.from(serialized, "utf8"), privateKey).toString("base64");
}

export function verifyPayload(payload, signatureBase64, pkcs8Base64) {
  const serialized = canonicalizePayload(payload);
  const publicKey = createPublicKey(createPrivateKey({ key: pemFromPkcs8(pkcs8Base64), format: "pem" }));
  return verify(
    "sha256",
    Buffer.from(serialized, "utf8"),
    publicKey,
    Buffer.from(signatureBase64, "base64"),
  );
}

export function pemFromPkcs8(value) {
  const stripped = String(value)
    .replace(/^wallet-auth:/, "")
    .replace(/^wallet-api:/, "")
    .replace(/\s+/g, "");
  const lines = stripped.match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

export { SIGNED_HEADER_NAMES };
