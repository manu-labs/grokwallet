import { CliError } from "./redact.js";
import { chainNames } from "./balances.js";
import { formatUnits, parseUnits, toHexQuantity, ETH_DECIMALS, SOL_DECIMALS } from "./units.js";

export function emptyCaps() {
  return { ethWei: null, solLamports: null, tokens: {} };
}

export function normalizeCaps(caps = {}) {
  const tokens = {};
  const source = caps.tokens && typeof caps.tokens === "object" && !Array.isArray(caps.tokens) ? caps.tokens : {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value) tokens[key] = value;
  }
  return {
    ethWei: caps.ethWei ? String(caps.ethWei) : null,
    solLamports: caps.solLamports ? String(caps.solLamports) : null,
    tokens,
  };
}

export function tokenCapKey(chain, address) {
  return `${chain}:${String(address).toLowerCase()}`;
}

export function assertWithinCap(caps, asset, amount) {
  const normalized = normalizeCaps(caps);
  if (asset === "eth") {
    if (!normalized.ethWei) return;
    if (amount > BigInt(normalized.ethWei)) {
      throw new CliError(
        `amount exceeds the ETH spend cap of ${formatUnits(BigInt(normalized.ethWei), ETH_DECIMALS)} ETH`,
      );
    }
    return;
  }
  if (asset === "sol") {
    if (!normalized.solLamports) return;
    if (amount > BigInt(normalized.solLamports)) {
      throw new CliError(
        `amount exceeds the SOL spend cap of ${formatUnits(BigInt(normalized.solLamports), SOL_DECIMALS)} SOL`,
      );
    }
    return;
  }
  throw new CliError("unknown asset for spend cap");
}

export function assertWithinTokenCap(caps, chain, address, rawAmount, decimals) {
  const normalized = normalizeCaps(caps);
  const key = tokenCapKey(chain, address);
  const human = normalized.tokens[key];
  if (!human) {
    throw new CliError(
      `no spend cap for ${key}. Set one with: cap set --token ${key}=<amount>. ERC-20 sends are refused until a cap is set for that chain and token.`,
    );
  }
  let capRaw;
  try {
    capRaw = parseUnits(human, decimals);
  } catch {
    throw new CliError(
      `token cap ${human} for ${key} cannot be applied with this token's ${decimals} decimals. Set the cap again with at most ${decimals} decimal places.`,
    );
  }
  if (rawAmount > capRaw) {
    throw new CliError(`amount exceeds the token cap of ${human} for ${key}`);
  }
  return human;
}

export function parseTokenCapSpec(spec) {
  const names = chainNames("evm").slice().sort((left, right) => right.length - left.length);
  const match = String(spec)
    .trim()
    .match(new RegExp(`^(${names.join("|")}):(0x[0-9a-fA-F]{40})=(\\d+(?:\\.\\d+)?)$`));
  if (!match) {
    throw new CliError(
      `token cap must look like arbitrum:0x<40 hex>=<amount>. Chains: ${names.join(", ")}.`,
    );
  }
  const amount = match[3];
  const fraction = amount.split(".")[1] || "";
  if (fraction.length > 36) throw new CliError("token cap has more than 36 decimal places");
  if (/^0+(?:\.0+)?$/.test(amount)) throw new CliError("token cap must be greater than zero");
  const address = match[2].toLowerCase();
  return { chain: match[1], address, amount, key: `${match[1]}:${address}` };
}

export function setTokenCap(caps, spec) {
  const parsed = parseTokenCapSpec(spec);
  const next = normalizeCaps(caps);
  next.tokens[parsed.key] = parsed.amount;
  return next;
}

export function setCapAmount(caps, asset, decimalAmount) {
  const next = normalizeCaps(caps);
  if (asset === "eth") next.ethWei = parseUnits(decimalAmount, ETH_DECIMALS).toString();
  else if (asset === "sol") next.solLamports = parseUnits(decimalAmount, SOL_DECIMALS).toString();
  else throw new CliError("cap asset must be eth or sol");
  return next;
}

export function formatCaps(caps) {
  const normalized = normalizeCaps(caps);
  const eth = normalized.ethWei ? `${formatUnits(BigInt(normalized.ethWei), ETH_DECIMALS)} ETH` : "not set";
  const sol = normalized.solLamports
    ? `${formatUnits(BigInt(normalized.solLamports), SOL_DECIMALS)} SOL`
    : "not set";
  const lines = [`eth: ${eth}`, `sol: ${sol}`];
  const keys = Object.keys(normalized.tokens).sort();
  if (keys.length === 0) lines.push("tokens: not set");
  for (const key of keys) lines.push(`token ${key}: ${normalized.tokens[key]}`);
  return lines.join("\n");
}

/**
 * Policy documents an app owner can create in the Privy dashboard.
 * The bot cannot POST /v1/policies: that route requires the app secret.
 * Default for an unmatched method is DENY, so these documents only allow the capped send.
 * ERC-20 caps stay local. A native value condition does not limit token calldata.
 */
export function policyDocuments(caps) {
  const normalized = normalizeCaps(caps);
  const docs = [];
  if (normalized.ethWei) {
    docs.push({
      version: "1.0",
      name: "GrokWallet ETH cap",
      chain_type: "ethereum",
      rules: [
        {
          name: "Cap native value",
          method: "eth_sendTransaction",
          action: "ALLOW",
          conditions: [
            {
              field_source: "ethereum_transaction",
              field: "value",
              operator: "lte",
              value: toHexQuantity(BigInt(normalized.ethWei)),
            },
          ],
        },
      ],
    });
  }
  if (normalized.solLamports) {
    docs.push({
      version: "1.0",
      name: "GrokWallet SOL cap",
      chain_type: "solana",
      rules: [
        {
          name: "Cap System Transfer",
          method: "signAndSendTransaction",
          action: "ALLOW",
          conditions: [
            {
              field_source: "solana_system_program_instruction",
              field: "Transfer.lamports",
              operator: "lte",
              value: normalized.solLamports,
            },
          ],
        },
      ],
    });
  }
  return docs;
}
