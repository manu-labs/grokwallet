import { CliError } from "./redact.js";
import { formatUnits, parseUnits, toHexQuantity, ETH_DECIMALS, SOL_DECIMALS } from "./units.js";

export function emptyCaps() {
  return { ethWei: null, solLamports: null };
}

export function normalizeCaps(caps = {}) {
  return {
    ethWei: caps.ethWei ? String(caps.ethWei) : null,
    solLamports: caps.solLamports ? String(caps.solLamports) : null,
  };
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
  return `eth: ${eth}\nsol: ${sol}`;
}

/**
 * Policy documents an app owner can create in the Privy dashboard.
 * The bot cannot POST /v1/policies: that route requires the app secret.
 * Default for an unmatched method is DENY, so these documents only allow the capped send.
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
