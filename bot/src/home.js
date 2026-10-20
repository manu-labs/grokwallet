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
