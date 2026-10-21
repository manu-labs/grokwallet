import { CliError } from "./redact.js";
import { ethCall } from "./balances.js";
import { toHexQuantity } from "./units.js";

export const TRANSFER_SELECTOR = "a9059cbb";
export const TRANSFER_FROM_SELECTOR = "23b872dd";
const DECIMALS_DATA = "0x313ce567";
const SYMBOL_DATA = "0x95d89b41";
const MAX_CALLDATA_BYTES = 16384;

export function requireAddress(value, label) {
  const text = String(value).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new CliError(`${label} must be a 0x Ethereum address`);
  return text;
}

export function normalizeCalldata(value) {
  const text = String(value).trim();
  if (!/^0x[0-9a-fA-F]+$/.test(text) || (text.length - 2) % 2 !== 0) {
    throw new CliError("data must be even-length 0x hex");
  }
  const bytes = (text.length - 2) / 2;
  if (bytes > MAX_CALLDATA_BYTES) throw new CliError(`data is longer than ${MAX_CALLDATA_BYTES} bytes`);
  return `0x${text.slice(2).toLowerCase()}`;
}

export function calldataSelector(data) {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  return data.slice(2, 10).toLowerCase();
}

export function erc20SpendSelector(data) {
  const selector = calldataSelector(data);
  if (selector === TRANSFER_SELECTOR || selector === TRANSFER_FROM_SELECTOR) return selector;
  return null;
}

export function encodeErc20Transfer(to, amount) {
  const address = requireAddress(to, "recipient").slice(2).toLowerCase().padStart(64, "0");
  const raw = typeof amount === "bigint" ? amount : BigInt(amount);
  if (raw < 0n) throw new CliError("ERC-20 amount cannot be negative");
  const value = raw.toString(16).padStart(64, "0");
  return `0x${TRANSFER_SELECTOR}${address}${value}`;
}

export function buildEthSendBody({ caip2, to, valueWei, chainId, data }) {
  const transaction = {
    to,
    value: toHexQuantity(valueWei),
    chain_id: chainId,
  };
  if (data) transaction.data = data;
  return {
    method: "eth_sendTransaction",
    caip2,
    chain_type: "ethereum",
    params: { transaction },
  };
}

export function summarizeEthSend({ chainName, from, to, amountText, data }) {
  const lines = [`send ${amountText} ETH on ${chainName} from ${from} to ${to}`];
  if (data) {
    const bytes = (data.length - 2) / 2;
    lines.push(`calldata bytes: ${bytes}`);
    lines.push(`selector: 0x${calldataSelector(data)}`);
    lines.push(`data: ${data.length <= 202 ? data : `${data.slice(0, 202)}…`}`);
    lines.push(
      "native ETH value is checked against the ETH cap. This calldata is not covered by a token cap.",
    );
  }
  return lines.join("\n");
}

export function summarizeErc20({ chainName, from, token, to, amountText, symbol, decimals, raw, capHuman }) {
  const label = symbol ? `${amountText} ${symbol}` : `${amountText} tokens`;
  return [
    `send ${label} (ERC-20) on ${chainName}`,
    `token: ${token}`,
    `decimals: ${decimals}`,
    `raw amount: ${raw.toString()}`,
    `from: ${from}`,
    `to: ${to}`,
    `token cap: ${capHuman}`,
    "native value: 0 ETH",
  ].join("\n");
}

export function decodeUint256(hex) {
  const text = String(hex ?? "").trim();
  if (!/^0x[0-9a-fA-F]*$/.test(text) || text === "0x") throw new CliError("token contract returned no integer");
  return BigInt(text);
}

function uint256Word(buf, offset) {
  if (offset < 0 || offset + 32 > buf.length) return null;
  const word = buf.subarray(offset, offset + 32);
  for (let i = 0; i < 24; i += 1) {
    if (word[i] !== 0) return null;
  }
  return word.readBigUInt64BE(24);
}

export function decodeAbiString(hex) {
  const text = String(hex ?? "").trim();
  if (!/^0x[0-9a-fA-F]*$/.test(text) || (text.length - 2) % 2 !== 0) return null;
  const raw = text.slice(2);
  if (!raw) return null;
  const buf = Buffer.from(raw, "hex");
  const printable = (value) => /^[\x20-\x7e]+$/.test(value);
  if (buf.length === 32) {
    if (buf[0] === 0) return null;
    const end = buf.indexOf(0);
    const slice = end === -1 ? buf : buf.subarray(0, end);
    if (slice.length === 0 || buf.subarray(slice.length).some((byte) => byte !== 0)) return null;
    const decoded = slice.toString("utf8");
    return printable(decoded) ? decoded : null;
  }
  if (buf.length < 64) return null;
  const offset = uint256Word(buf, 0);
  if (offset == null || offset > BigInt(buf.length)) return null;
  const length = uint256Word(buf, Number(offset));
  if (length == null || length < 1n || length > 64n) return null;
  const start = Number(offset) + 32;
  const end = start + Number(length);
  if (end > buf.length) return null;
  const decoded = buf.subarray(start, end).toString("utf8");
  return printable(decoded) ? decoded : null;
}

export async function readErc20Decimals(rpc, token, fetchImpl = fetch) {
  const result = await ethCall(rpc, token, DECIMALS_DATA, fetchImpl);
  const value = decodeUint256(result);
  if (value > 36n) throw new CliError("token decimals() was outside 0..36");
  return Number(value);
}

export async function readErc20Symbol(rpc, token, fetchImpl = fetch) {
  try {
    const result = await ethCall(rpc, token, SYMBOL_DATA, fetchImpl);
    return decodeAbiString(result);
  } catch {
    return null;
  }
}
