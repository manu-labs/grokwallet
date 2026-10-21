import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "./redact.js";
import { appIdFromEnv, ensureHome, homeDir } from "./home.js";

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function passphrase() {
  const value = process.env.GROKWALLET_PASSPHRASE;
  if (!value) {
    throw new CliError(
      "GROKWALLET_PASSPHRASE is not set. Save it as a masked secret and export it for this command.",
    );
  }
  return value;
}

export function encryptJson(value, secret = passphrase()) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32, SCRYPT);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      kdf: "scrypt",
      n: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

export function decryptJson(blob, secret = passphrase()) {
  if (!blob || blob.v !== 1 || blob.kdf !== "scrypt") {
    throw new CliError("session file is not a GrokWallet encrypted session");
  }
  const salt = Buffer.from(blob.salt, "base64");
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  const key = scryptSync(secret, salt, 32, {
    N: blob.n,
    r: blob.r,
    p: blob.p,
    maxmem: 64 * 1024 * 1024,
  });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new CliError("could not decrypt the session. Check GROKWALLET_PASSPHRASE.");
  } finally {
    key.fill(0);
  }
}

function atomicWrite(file, contents, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  chmodSync(file, mode);
}

function sessionPath() {
  return join(ensureHome(), "session.json");
}

function configPath() {
  return join(ensureHome(), "config.json");
}

export function readConfig() {
  const file = configPath();
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeConfig(patch) {
  const current = readConfig();
  const source = { ...current, ...patch };
  const next = {};
  if (source.appId) next.appId = source.appId;
  if (source.wcProjectId) next.wcProjectId = source.wcProjectId;
  atomicWrite(configPath(), `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

// Public Privy app id for this distribution. Not a secret. Env and ~/.grokwallet/config.json override it.
export const PUBLIC_APP_ID = "cmvh5kyg300qy0gl01ww23ixy";

export function resolveAppId() {
  return appIdFromEnv() || readConfig().appId || PUBLIC_APP_ID;
}

export function requireAppId() {
  const appId = resolveAppId();
  if (!appId || appId === "REPLACE_WITH_PRIVY_APP_ID") {
    throw new CliError(
      "Set GROKWALLET_APP_ID to the public Privy app id from the wallet owner. It is not a secret.",
    );
  }
  return appId;
}

function stripSecrets(session) {
  const next = { ...session };
  delete next.authorizationKey;
  delete next.deviceCode;
  delete next.privateKey;
  delete next.signingKey;
  return next;
}

export function saveSession(session) {
  const stored = stripSecrets(session);
  const blob = encryptJson(stored);
  const encoded = `${JSON.stringify(blob)}\n`;
  if (encoded.includes(stored.accessToken) || encoded.includes(stored.refreshToken)) {
    throw new CliError("refusing to write a session that contains a plaintext token");
  }
  atomicWrite(sessionPath(), encoded, 0o600);
}

export function loadSession() {
  const file = sessionPath();
  if (!existsSync(file)) return null;
  const blob = JSON.parse(readFileSync(file, "utf8"));
  return decryptJson(blob);
}

export function sessionMode() {
  const file = sessionPath();
  if (!existsSync(file)) return null;
  return statSync(file).mode & 0o777;
}

export function deleteSession() {
  const file = sessionPath();
  if (existsSync(file)) rmSync(file);
}

export function sessionFileExists() {
  return existsSync(sessionPath());
}

export function homeForTests() {
  return homeDir();
}
