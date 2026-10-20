import { CliError } from "./redact.js";

export function parseUnits(amount, decimals) {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new CliError("amount must be a positive decimal such as 0.01");
  }
  const [whole, frac = ""] = text.split(".");
  if (frac.length > decimals) {
    throw new CliError(`amount has more than ${decimals} decimal places`);
  }
  const base = 10n ** BigInt(decimals);
  const value = BigInt(whole) * base + BigInt((frac + "0".repeat(decimals)).slice(0, decimals));
  if (value <= 0n) throw new CliError("amount must be greater than zero");
  return value;
}

export function formatUnits(amount, decimals) {
  const value = typeof amount === "bigint" ? amount : BigInt(amount);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = frac ? `${whole.toString()}.${frac}` : whole.toString();
  return negative ? `-${text}` : text;
}

export function toHexQuantity(value) {
  const amount = typeof value === "bigint" ? value : BigInt(value);
  if (amount < 0n) throw new CliError("hex quantity cannot be negative");
  return `0x${amount.toString(16)}`;
}

export function fromHexQuantity(hex) {
  const text = String(hex).trim();
  if (!/^0x[0-9a-fA-F]+$/.test(text)) throw new CliError("expected a hex quantity");
  return BigInt(text);
}

export const ETH_DECIMALS = 18;
export const SOL_DECIMALS = 9;
