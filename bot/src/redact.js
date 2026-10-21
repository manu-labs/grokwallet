const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const WC_URI = /wc:[^\s'"]+/gi;
const SYM_KEY = /symKey=[A-Za-z0-9._~+/=-]+/gi;

export function redact(value) {
  return String(value ?? "")
    .replace(JWT, "[redacted]")
    .replace(WC_URI, "wc:[redacted]")
    .replace(SYM_KEY, "symKey=[redacted]");
}

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
