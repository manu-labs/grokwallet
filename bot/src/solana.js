import { CliError } from "./redact.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((char, index) => [char, index]));

export function base58Decode(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError("invalid base58 address");
  }
  let zeros = 0;
  while (value[zeros] === "1") zeros += 1;
  const bytes = [];
  for (let index = zeros; index < value.length; index += 1) {
    const digit = INDEX.get(value[index]);
    if (digit === undefined) throw new CliError("invalid base58 address");
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const decoded = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) decoded[decoded.length - 1 - i] = bytes[i];
  return decoded;
}

export function base58Encode(buffer) {
  let zeros = 0;
  while (zeros < buffer.length && buffer[zeros] === 0) zeros += 1;
  if (zeros === buffer.length) return "1".repeat(buffer.length);
  const digits = [0];
  for (let i = zeros; i < buffer.length; i += 1) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}

export function encodeCompactU16(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new CliError("compact-u16 out of range");
  }
  const out = [];
  let remaining = value;
  while (true) {
    let elem = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(elem);
      break;
    }
    out.push(elem | 0x80);
  }
  return Buffer.from(out);
}

function pubkey(value, label) {
  const decoded = base58Decode(value);
  if (decoded.length !== 32) throw new CliError(`${label} must decode to 32 bytes`);
  return decoded;
}

/**
 * Unsigned legacy Solana transaction: one System Program Transfer.
 * Layout is the wire format Privy signAndSendTransaction takes as base64,
 * including a single zeroed signature slot.
 */
export function buildSolTransfer({ from, to, lamports, recentBlockhash }) {
  const fromKey = pubkey(from, "sender");
  const toKey = pubkey(to, "recipient");
  if (fromKey.equals(toKey)) throw new CliError("recipient is the sender");
  const amount = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  if (amount <= 0n || amount > 0xffffffffffffffffn) throw new CliError("lamports out of range");
  const blockhash = pubkey(recentBlockhash, "blockhash");
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(amount, 4);
  const instruction = Buffer.concat([
    Buffer.from([2]),
    encodeCompactU16(2),
    Buffer.from([0, 1]),
    encodeCompactU16(data.length),
    data,
  ]);
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]),
    encodeCompactU16(3),
    fromKey,
    toKey,
    Buffer.alloc(32),
    blockhash,
    encodeCompactU16(1),
    instruction,
  ]);
  return Buffer.concat([encodeCompactU16(1), Buffer.alloc(64), message]).toString("base64");
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
