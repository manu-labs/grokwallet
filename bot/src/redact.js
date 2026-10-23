const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const WC_URI = /wc:[^\s'"]+/gi;
const SYM_KEY = /symKey=[A-Za-z0-9._~+/=-]+/gi;

export function redact(value) {
  let text = String(value ?? "")
    .replace(JWT, "[redacted]")
    .replace(WC_URI, "wc:[redacted]")
    .replace(SYM_KEY, "symKey=[redacted]");
  const secret = process.env.GROKWALLET_PASSPHRASE;
  if (typeof secret === "string" && secret.length >= 8) text = text.split(secret).join("[redacted]");
  return text;
}

export class CliError extends Error {
  constructor(message, exitCode = 1, hint = "") {
    super(message);
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class DryRun extends Error {
  constructor() {
    super("dry-run");
    this.exitCode = 0;
  }
}
