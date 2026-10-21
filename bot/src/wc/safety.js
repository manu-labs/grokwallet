import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { CliError } from "../redact.js";
import { readConfig } from "../session.js";

export const MAX_PAYLOAD_CHARS = 32768;

export const USER_REJECTED = { code: 5000, message: "User rejected." };
export const UNSUPPORTED_METHOD = { code: 5101, message: "Unsupported method." };
export const RAW_HASH_REFUSED = { code: 5101, message: "Raw hash signing is refused." };
export const USER_DISCONNECTED = { code: 6000, message: "User disconnected." };

const RAW_HASH_METHODS = new Set([
  "eth_sign",
  "eth_signtransaction",
  "eth_signtypeddata",
  "eth_signtypeddata_v1",
  "eth_signtypeddata_v3",
]);

const ALLOWED_METHODS = new Set([
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "wallet_sendCalls",
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "net_version",
  "wallet_switchEthereumChain",
  "wallet_getCapabilities",
  "wallet_getCallsStatus",
]);

export const SIGNING_METHODS = new Set([
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "wallet_sendCalls",
]);

export function classifyMethod(method) {
  const name = String(method ?? "");
  if (RAW_HASH_METHODS.has(name.toLowerCase())) {
    return { allow: false, rawHash: true, reason: "raw hash signing is refused" };
  }
  if (!ALLOWED_METHODS.has(name)) {
    return { allow: false, rawHash: false, reason: "unsupported method" };
  }
  return { allow: true, rawHash: false, reason: "" };
}

export function payloadHash(value) {
  const serialized = canonicalize(value);
  if (typeof serialized !== "string") throw new CliError("could not hash the WalletConnect payload");
  return createHash("sha256").update(serialized).digest("hex");
}

export function assertPairingUri(uri) {
  const text = String(uri ?? "").trim();
  const match = text.match(/^wc:([0-9a-fA-F]{64})@2\?([\s\S]+)$/);
  if (!match) throw new CliError("WalletConnect URI is not a v2 pairing URI");
  let params;
  try {
    params = new URLSearchParams(match[2]);
  } catch {
    throw new CliError("WalletConnect URI is not a v2 pairing URI");
  }
  const symKey = params.get("symKey") || "";
  if (!/^[0-9a-fA-F]{64}$/.test(symKey)) throw new CliError("WalletConnect URI is not a v2 pairing URI");
  const relay = params.get("relay-protocol");
  if (relay && relay !== "irn") throw new CliError("WalletConnect URI is not a v2 pairing URI");
  return { topic: match[1] };
}

export function requireWcProjectId() {
  const fromEnv = process.env.GROKWALLET_WC_PROJECT_ID?.trim() || "";
  const fromConfig = String(readConfig().wcProjectId || "").trim();
  const id = fromEnv || fromConfig;
  if (!/^[0-9a-fA-F]{32}$/.test(id)) {
    throw new CliError(
      "Set GROKWALLET_WC_PROJECT_ID to your WalletConnect project id, a 32-character hex value. Create one at https://dashboard.reown.com. This build does not include one. You can also set wcProjectId in ~/.grokwallet/config.json. Do not commit it.",
    );
  }
  return id;
}

export function normalizeVerify(context) {
  const verified = context?.verified && typeof context.verified === "object" ? context.verified : {};
  const validation = verified.validation === "VALID" || verified.validation === "INVALID" ? verified.validation : "UNKNOWN";
  return {
    origin: typeof verified.origin === "string" ? verified.origin.slice(0, 500) : "",
    validation,
    isScam: Boolean(verified.isScam),
  };
}

export function hostOf(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function originReport(verify, claimedUrl) {
  const verifiedHost = hostOf(verify?.origin);
  const claimedHost = hostOf(claimedUrl);
  const validation = verify?.validation || "UNKNOWN";
  let mismatch = validation === "INVALID";
  if (verifiedHost && claimedHost && verifiedHost !== claimedHost) mismatch = true;
  if (validation === "VALID" && (!verifiedHost || !claimedHost)) mismatch = true;
  let domain = "(unknown)";
  if (mismatch) domain = "MISMATCH";
  else if (verifiedHost) domain = verifiedHost;
  else if (claimedHost) domain = `${claimedHost} (unverified)`;
  return {
    domain,
    verifiedHost,
    claimedHost,
    validation,
    mismatch,
    unverified: validation !== "VALID",
    scam: Boolean(verify?.isScam),
  };
}

export function effectiveVerify(eventContext, sessionVerify) {
  const fromEvent = normalizeVerify(eventContext);
  if (fromEvent.validation !== "UNKNOWN" || fromEvent.origin) return fromEvent;
  return sessionVerify || fromEvent;
}

export function formatOrigin(record) {
  const origin = record.origin;
  const verify = record.verify;
  const lines = [`origin: ${origin.domain}`, `verify: ${verify.validation}`];
  if (verify.origin) lines.push(`verified origin: ${verify.origin}`);
  lines.push(`claimed name (untrusted): ${record.claimedName || "(absent)"}`);
  lines.push(`claimed url (untrusted): ${record.claimedUrl || "(absent)"}`);
  if (origin.scam) lines.push("WARNING: WalletConnect Verify marked this origin as a scam.");
  if (origin.mismatch) lines.push("WARNING: verified origin does not match the dapp's claimed URL.");
  else if (verify.validation !== "VALID") {
    lines.push("WARNING: WalletConnect did not verify this origin. The name and URL are claimed by the dapp.");
  }
  return lines.join("\n");
}

export function boundedText(value, limit, label) {
  const text = typeof value === "string" ? value : "";
  if (text.length > limit) throw new CliError(`${label} is too long`);
  return text;
}

export function hexChainId(chainId) {
  const value = Number(chainId);
  if (!Number.isSafeInteger(value) || value < 0) throw new CliError("chain id is not a supported integer");
  return `0x${value.toString(16)}`;
}

export function parseHexChainId(value) {
  const text = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]+$/.test(text)) throw new CliError("chain id must be a hex quantity");
  const big = BigInt(text);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CliError("chain id is too large");
  return Number(big);
}

export function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

export function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}
