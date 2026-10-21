import { CliError } from "./redact.js";

export const MAX_TYPED_DATA_CHARS = 32768;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatScalar(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function formatChainId(value) {
  if (value === undefined) return { chainId: undefined, text: "(absent)" };
  const parsed = parseChainId(value);
  if (parsed == null) return { chainId: value, text: formatScalar(value) };
  return { chainId: parsed, text: `0x${parsed.toString(16)} (${parsed.toString()})` };
}

function parseChainId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(text) && !/^\d+$/.test(text)) return null;
  const big = BigInt(text);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(big);
}

export function normalizeTypedData(value) {
  if (!isPlainObject(value)) throw new CliError("typed data must be a JSON object");
  const source = isPlainObject(value.typed_data) ? value.typed_data : value;
  if (!isPlainObject(source.domain)) throw new CliError("typed data is missing domain");
  if (!isPlainObject(source.types)) throw new CliError("typed data is missing types");
  if (!isPlainObject(source.message)) throw new CliError("typed data is missing message");
  const camel = source.primaryType;
  const snake = source.primary_type;
  if (camel !== undefined && snake !== undefined && camel !== snake) {
    throw new CliError("primaryType and primary_type disagree");
  }
  const primaryType = camel ?? snake;
  if (typeof primaryType !== "string" || primaryType.length === 0) {
    throw new CliError("typed data is missing primaryType");
  }
  if (!Array.isArray(source.types[primaryType])) {
    throw new CliError(`typed data types are missing ${primaryType}`);
  }
  const described = formatChainId(source.domain.chainId);
  const domain = { ...source.domain };
  if (described.chainId !== undefined) domain.chainId = described.chainId;
  return {
    domain,
    types: source.types,
    message: source.message,
    primaryType,
    chainIdText: described.text,
  };
}

export function loadTypedData(raw, { readFile, readStdin } = {}) {
  let text = String(raw);
  if (text.startsWith("@")) {
    const path = text.slice(1);
    if (!path) throw new CliError("missing typed data file path");
    if (path === "-") {
      if (!readStdin) throw new CliError("stdin is not available for typed data");
      text = readStdin();
    } else {
      if (!readFile) throw new CliError("could not read typed data file");
      text = readFile(path);
    }
  }
  if (typeof text !== "string") throw new CliError("typed data must be a string");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length > MAX_TYPED_DATA_CHARS) {
    throw new CliError(`typed data is longer than ${MAX_TYPED_DATA_CHARS} characters`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("typed data is not JSON");
  }
  return normalizeTypedData(parsed);
}

export function summarizeTypedData(typed, address) {
  const domain = typed.domain;
  const lines = [
    `sign typed data (eth_signTypedData_v4) from ${address}`,
    `primaryType: ${typed.primaryType}`,
  ];
  const fields = typed.types[typed.primaryType];
  if (fields.length > 0) {
    lines.push(`fields: ${fields.map((field) => `${field?.name} ${field?.type}`).join(", ")}`);
  }
  lines.push(`domain.chainId: ${typed.chainIdText}`);
  lines.push(
    `domain.verifyingContract: ${domain.verifyingContract === undefined ? "(absent)" : formatScalar(domain.verifyingContract)}`,
  );
  for (const key of Object.keys(domain)) {
    if (key === "chainId" || key === "verifyingContract") continue;
    lines.push(`domain.${key}: ${formatScalar(domain[key])}`);
  }
  if (typed.message.signatureChainId !== undefined) {
    lines.push(`message.signatureChainId: ${formatScalar(typed.message.signatureChainId)}`);
  }
  lines.push("message:");
  lines.push(JSON.stringify(typed.message, null, 2));
  return lines.join("\n");
}

export function buildTypedDataBody(typed) {
  return {
    method: "eth_signTypedData_v4",
    chain_type: "ethereum",
    params: {
      typed_data: {
        domain: typed.domain,
        types: typed.types,
        primary_type: typed.primaryType,
        message: typed.message,
      },
    },
  };
}
