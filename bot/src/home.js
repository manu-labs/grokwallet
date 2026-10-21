import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function homeDir() {
  return process.env.GROKWALLET_HOME || join(homedir(), ".grokwallet");
}

export function ensureHome() {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function authBase() {
  return (process.env.GROKWALLET_AUTH_BASE || "https://auth.privy.io").replace(/\/$/, "");
}

export function appIdFromEnv() {
  const fromEnv = process.env.GROKWALLET_APP_ID?.trim();
  return fromEnv || "";
}

export function publicOrigin() {
  const raw = (process.env.GROKWALLET_PUBLIC_ORIGIN || "https://grokwallet.fun").trim().replace(/\/$/, "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return "https://grokwallet.fun";
    }
    return url.origin;
  } catch {
    return "https://grokwallet.fun";
  }
}

const USER_CODE = /^[A-Za-z0-9]{4,16}(?:-[A-Za-z0-9]{4,16})?$/;

export function connectorUrlForUserCode(userCode, origin = publicOrigin()) {
  const code = String(userCode || "").trim();
  if (!USER_CODE.test(code)) return "";
  return `${origin}/mcp/c/${encodeURIComponent(code)}`;
}
