import { CliError } from "./redact.js";
import { fromHexQuantity } from "./units.js";

export const CHAINS = {
  ethereum: {
    kind: "evm",
    chainId: 1,
    caip2: "eip155:1",
    symbol: "ETH",
    decimals: 18,
    defaultRpc: "https://ethereum.publicnode.com",
    env: "GROKWALLET_ETHEREUM_RPC",
  },
  base: {
    kind: "evm",
    chainId: 8453,
    caip2: "eip155:8453",
    symbol: "ETH",
    decimals: 18,
    defaultRpc: "https://mainnet.base.org",
    env: "GROKWALLET_BASE_RPC",
  },
  solana: {
    kind: "solana",
    chainId: null,
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    symbol: "SOL",
    decimals: 9,
    defaultRpc: "https://api.mainnet-beta.solana.com",
    env: "GROKWALLET_SOLANA_RPC",
  },
};

export function chainConfig(name) {
  const chain = CHAINS[name];
  if (!chain) throw new CliError("chain must be ethereum, base, or solana");
  return { name, ...chain, rpc: process.env[chain.env] || chain.defaultRpc };
}

async function rpcCall(url, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError(`balance RPC request failed for ${url}`);
  }
  if (!response.ok) throw new CliError(`balance RPC returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new CliError("balance RPC returned an error");
  return payload.result;
}

export async function ethBalance(address, rpc, fetchImpl = fetch) {
  const result = await rpcCall(
    rpc,
    { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] },
    fetchImpl,
  );
  return fromHexQuantity(result);
}

export async function solBalance(address, rpc, fetchImpl = fetch) {
  const result = await rpcCall(
    rpc,
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address, { commitment: "confirmed" }] },
    fetchImpl,
  );
  if (!result || typeof result.value !== "number") throw new CliError("solana balance response was missing value");
  return BigInt(result.value);
}

export async function solanaBlockhash(rpc, fetchImpl = fetch) {
  const result = await rpcCall(
    rpc,
    { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] },
    fetchImpl,
  );
  const blockhash = result?.value?.blockhash;
  if (!blockhash) throw new CliError("solana RPC did not return a blockhash");
  return blockhash;
}
