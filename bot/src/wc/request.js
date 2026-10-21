import { randomBytes } from "node:crypto";
import { chainByCaip2, ethReceipt } from "../balances.js";
import {
  buildEthSendBody,
  decodeErc20Spend,
  erc20SpendSelector,
  normalizeCalldata,
  readErc20Decimals,
  readErc20Symbol,
  requireAddress,
  summarizeErc20,
  summarizeEthSend,
} from "../erc20.js";
import { MAX_MESSAGE_CHARS, summarizeMessage } from "../message.js";
import { assertWithinCap, assertWithinTokenCap } from "../policy.js";
import { CliError } from "../redact.js";
import { buildTypedDataBody, MAX_TYPED_DATA_CHARS, normalizeTypedData, summarizeTypedData } from "../typed-data.js";
import { ETH_DECIMALS, formatUnits, fromHexQuantity } from "../units.js";
import {
  classifyMethod,
  effectiveVerify,
  formatOrigin,
  hexChainId,
  isAddress,
  MAX_PAYLOAD_CHARS,
  originReport,
  parseHexChainId,
  payloadHash,
  sameAddress,
} from "./safety.js";

const GAS_KEYS = ["gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce"];

export function freezeRequest(event, session) {
  if (!event || !Number.isInteger(event.id)) throw new CliError("request is missing an id");
  if (typeof event.topic !== "string" || event.topic.length === 0) throw new CliError("request is missing a topic");
  const request = event.params?.request;
  const method = request?.method;
  const params = request?.params;
  const chainId = event.params?.chainId;
  if (typeof method !== "string" || method.length === 0) throw new CliError("request is missing a method");
  if (typeof chainId !== "string" || !chainId.startsWith("eip155:")) throw new CliError("request chain is not eip155");
  if (!session?.chains?.includes(chainId)) throw new CliError("request chain was not granted on this session");
  const decision = classifyMethod(method);
  if (!decision.allow) {
    throw new CliError(decision.rawHash ? "raw hash signing is refused" : "unsupported method");
  }
  let encoded;
  try {
    encoded = JSON.stringify(params);
  } catch {
    throw new CliError("request payload is not JSON");
  }
  if (encoded === undefined || encoded.length > MAX_PAYLOAD_CHARS) throw new CliError("request payload is too large");
  const verify = effectiveVerify(event.verifyContext, session.verify);
  const claimedName = session.claimedName || "";
  const claimedUrl = session.claimedUrl || "";
  const record = {
    key: `${event.topic}:${event.id}`,
    id: event.id,
    topic: event.topic,
    chainId,
    method,
    params,
    claimedName,
    claimedUrl,
    verify,
    origin: originReport(verify, claimedUrl),
    sessionChains: session.chains.slice(),
    sessionAccounts: session.accounts.slice(),
  };
  record.payloadHash = payloadHash({
    id: record.id,
    topic: record.topic,
    chainId,
    method,
    params,
    claimedName,
    claimedUrl,
    verifyOrigin: verify.origin,
    verifyValidation: verify.validation,
    verifyScam: verify.isScam,
    sessionChains: record.sessionChains,
    sessionAccounts: record.sessionAccounts,
  });
  return record;
}

export function formatRequest(record) {
  const chain = chainByCaip2(record.chainId);
  const chainText = chain ? `${record.chainId} (${chain.name})` : record.chainId;
  return [
    formatOrigin(record),
    `request: ${record.id}`,
    `topic: ${record.topic}`,
    `chain: ${chainText}`,
    `method: ${record.method}`,
    "payload:",
    JSON.stringify(record.params, null, 2),
  ].join("\n");
}

function requireChain(caip2) {
  const chain = chainByCaip2(caip2);
  if (!chain || chain.kind !== "evm") throw new CliError(`request chain is not supported: ${caip2}`);
  return chain;
}

function assertAccount(record, address) {
  const account = `${record.chainId}:${address}`;
  const ok = record.sessionAccounts.some((item) => sameAddress(item, account) || sameAddress(item.split(":").at(-1), address));
  if (!ok) throw new CliError("this wallet was not granted for that chain on this session");
}

function decodePersonalMessage(message) {
  if (typeof message !== "string" || message.length === 0) throw new CliError("personal_sign message is empty");
  if (/^0x[0-9a-fA-F]*$/.test(message)) {
    if (message.length === 2 || (message.length - 2) % 2 !== 0) {
      throw new CliError("personal_sign hex message is not even-length bytes");
    }
    const bytes = Buffer.from(message.slice(2), "hex");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new CliError("personal_sign message is not UTF-8. This CLI signs UTF-8 personal_sign only.");
    }
    if (text.length === 0) throw new CliError("personal_sign message is empty");
    return text;
  }
  return message;
}

function personalSign(record, address) {
  assertAccount(record, address);
  const params = record.params;
  if (!Array.isArray(params) || params.length < 2) throw new CliError("personal_sign params are not a message and an address");
  const [first, second] = params;
  let message;
  let requested;
  if (isAddress(second) && !isAddress(first)) {
    message = first;
    requested = second;
  } else if (isAddress(first) && !isAddress(second)) {
    requested = first;
    message = second;
  } else {
    throw new CliError("personal_sign params do not identify one message and one address");
  }
  if (!sameAddress(requested, address)) throw new CliError("personal_sign address does not match this wallet");
  const text = decodePersonalMessage(message);
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new CliError(`message is longer than ${MAX_MESSAGE_CHARS} characters`);
  }
  return {
    summary: summarizeMessage("ethereum", address, text),
    action: {
      type: "rpc",
      body: {
        method: "personal_sign",
        chain_type: "ethereum",
        params: { message: text, encoding: "utf-8" },
      },
      idempotency: false,
      interpret: "signature",
    },
  };
}

function typedSign(record, address) {
  assertAccount(record, address);
  const params = record.params;
  if (!Array.isArray(params) || params.length < 2) throw new CliError("eth_signTypedData_v4 params are not an address and typed data");
  const [first, second] = params;
  let requested;
  let data;
  if (isAddress(first) && !isAddress(second)) {
    requested = first;
    data = second;
  } else if (isAddress(second) && !isAddress(first)) {
    requested = second;
    data = first;
  } else {
    throw new CliError("eth_signTypedData_v4 params do not identify one address and the typed data");
  }
  if (!sameAddress(requested, address)) throw new CliError("eth_signTypedData_v4 address does not match this wallet");
  const text = typeof data === "string" ? data : JSON.stringify(data);
  if (typeof text !== "string" || text.length > MAX_TYPED_DATA_CHARS) {
    throw new CliError(`typed data is longer than ${MAX_TYPED_DATA_CHARS} characters`);
  }
  let parsed = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data.charCodeAt(0) === 0xfeff ? data.slice(1) : data);
    } catch {
      throw new CliError("typed data is not JSON");
    }
  }
  const typed = normalizeTypedData(parsed);
  return {
    summary: summarizeTypedData(typed, address),
    action: {
      type: "rpc",
      body: buildTypedDataBody(typed),
      idempotency: false,
      interpret: "signature",
    },
  };
}

function valueOf(tx) {
  if (tx.value === undefined || tx.value === null || tx.value === "0x" || tx.value === "0x0") return 0n;
  return fromHexQuantity(tx.value);
}

function gasNote(tx) {
  if (GAS_KEYS.some((key) => tx[key] !== undefined)) {
    return "dapp gas and nonce fields are ignored. Privy fills those.";
  }
  return "";
}

async function prepareCall({ chain, to, valueWei, data, address, caps, fetchImpl }) {
  const recipient = requireAddress(to, "recipient");
  const notes = [];
  let tokenSummary = "";
  if (data && erc20SpendSelector(data)) {
    const spend = decodeErc20Spend(data);
    const decimals = await readErc20Decimals(chain.rpc, recipient, fetchImpl);
    const capHuman = assertWithinTokenCap(caps, chain.name, recipient, spend.amount, decimals);
    const symbol = await readErc20Symbol(chain.rpc, recipient, fetchImpl);
    tokenSummary = summarizeErc20({
      chainName: chain.name,
      from: address,
      token: recipient,
      to: spend.to,
      amountText: formatUnits(spend.amount, decimals),
      symbol,
      decimals,
      raw: spend.amount,
      capHuman,
    });
    if (spend.from) notes.push(`transferFrom owner: ${spend.from}`);
  }
  assertWithinCap(caps, "eth", valueWei);
  if (valueWei === 0n && !data) throw new CliError("transaction has no value and no data");
  const body = buildEthSendBody({
    caip2: chain.caip2,
    to: recipient,
    valueWei,
    chainId: chain.chainId,
    data,
  });
  const native = summarizeEthSend({
    chainName: chain.name,
    from: address,
    to: recipient,
    amountText: formatUnits(valueWei, ETH_DECIMALS),
    data: tokenSummary ? null : data,
  });
  let summary = tokenSummary || native;
  if (tokenSummary && valueWei > 0n) {
    summary = tokenSummary.replace(
      "native value: 0 ETH",
      `native value: ${formatUnits(valueWei, ETH_DECIMALS)} ETH`,
    );
  }
  summary = [summary, ...notes].filter(Boolean).join("\n");
  return { summary, body, data };
}

async function sendTransaction(record, address, caps, fetchImpl) {
  const chain = requireChain(record.chainId);
  assertAccount(record, address);
  const tx = Array.isArray(record.params) ? record.params[0] : null;
  if (!tx || typeof tx !== "object" || Array.isArray(tx)) throw new CliError("eth_sendTransaction is missing the transaction");
  if (tx.from && !sameAddress(tx.from, address)) throw new CliError("eth_sendTransaction from does not match this wallet");
  if (!tx.to) throw new CliError("eth_sendTransaction is missing a recipient");
  const valueWei = valueOf(tx);
  const data = tx.data === undefined || tx.data === null || tx.data === "0x" ? null : normalizeCalldata(tx.data);
  const prepared = await prepareCall({
    chain,
    to: tx.to,
    valueWei,
    data,
    address,
    caps,
    fetchImpl,
  });
  const extra = gasNote(tx);
  return {
    summary: [prepared.summary, extra].filter(Boolean).join("\n"),
    action: { type: "rpc", body: prepared.body, idempotency: true, interpret: "hash", chainName: chain.name },
  };
}

async function sendCalls(record, address, caps, fetchImpl) {
  const chain = requireChain(record.chainId);
  assertAccount(record, address);
  const batch = Array.isArray(record.params) ? record.params[0] : null;
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) throw new CliError("wallet_sendCalls is missing the batch");
  if (!Array.isArray(batch.calls) || batch.calls.length === 0) throw new CliError("wallet_sendCalls has no calls");
  if (batch.calls.length !== 1) {
    throw new CliError("wallet_sendCalls with more than one call is refused. Reject this request.");
  }
  if (batch.from && !sameAddress(batch.from, address)) throw new CliError("wallet_sendCalls from does not match this wallet");
  if (batch.chainId !== undefined) {
    const requested = parseHexChainId(batch.chainId);
    if (requested !== chain.chainId) throw new CliError("wallet_sendCalls chainId does not match the request chain");
  }
  const call = batch.calls[0];
  if (!call || typeof call !== "object" || !call.to) throw new CliError("wallet_sendCalls is missing a recipient");
  const valueWei = valueOf(call);
  const data = call.data === undefined || call.data === null || call.data === "0x" ? null : normalizeCalldata(call.data);
  const prepared = await prepareCall({ chain, to: call.to, valueWei, data, address, caps, fetchImpl });
  const batchId = newBatchId();
  return {
    summary: `${prepared.summary}\nwallet_sendCalls: 1 call. A batch of more than one call is refused. atomic batch: ${batch.atomicRequired === true ? "required, single call" : "not requested"}`,
    action: {
      type: "rpc",
      body: prepared.body,
      idempotency: true,
      interpret: "calls",
      chainName: chain.name,
      batchId,
      caip2: chain.caip2,
      chainIdHex: hexChainId(chain.chainId),
    },
  };
}

function readResult(record, address) {
  const chain = requireChain(record.chainId);
  assertAccount(record, address);
  if (record.method === "eth_chainId") {
    return {
      summary: `return chain id ${hexChainId(chain.chainId)} for ${chain.name}. This does not sign or send.`,
      action: { type: "result", result: hexChainId(chain.chainId) },
    };
  }
  if (record.method === "net_version") {
    return {
      summary: `return network id ${chain.chainId} for ${chain.name}. This does not sign or send.`,
      action: { type: "result", result: String(chain.chainId) },
    };
  }
  if (record.method === "eth_accounts" || record.method === "eth_requestAccounts") {
    return {
      summary: `return the approved account ${address} on ${chain.name}. This does not sign or send.`,
      action: { type: "result", result: [address] },
    };
  }
  if (record.method === "wallet_switchEthereumChain") {
    const requested = record.params?.[0]?.chainId;
    const chainId = parseHexChainId(requested);
    const next = chainByCaip2(`eip155:${chainId}`);
    if (!next || !record.sessionChains.includes(next.caip2)) {
      throw new CliError("that chain was not granted on this session");
    }
    return {
      summary: `acknowledge a switch to ${next.name} (${next.caip2}). This does not sign or send.`,
      action: { type: "result", result: null },
    };
  }
  if (record.method === "wallet_getCapabilities") {
    const caps = {};
    for (const caip of record.sessionChains) {
      const granted = chainByCaip2(caip);
      if (!granted) continue;
      caps[hexChainId(granted.chainId)] = { atomic: { status: "unsupported" } };
    }
    return {
      summary: `return wallet capabilities for ${address}. Atomic batches are unsupported. This does not sign or send.`,
      action: { type: "result", result: { [address.toLowerCase()]: caps } },
    };
  }
  throw new CliError("unsupported method");
}

async function callsStatus(record, callRecord, fetchImpl) {
  const chain = requireChain(record.chainId);
  const id = Array.isArray(record.params) ? record.params[0] : record.params?.id;
  if (!callRecord || callRecord.id !== id) throw new CliError("no submitted WalletConnect batch with that id");
  if (callRecord.caip2 !== chain.caip2) throw new CliError("batch chain does not match this request");
  let receipt = null;
  try {
    receipt = await ethReceipt(callRecord.hash, chain.rpc, fetchImpl);
  } catch {
    receipt = null;
  }
  if (!receipt) {
    return {
      summary: `report batch ${id} as pending. submitted hash: ${callRecord.hash}. This does not sign or send.`,
      action: {
        type: "result",
        result: {
          version: "2.0.0",
          id,
          chainId: hexChainId(chain.chainId),
          status: 100,
          atomic: false,
        },
      },
    };
  }
  return {
    summary: `report batch ${id} as confirmed. submitted hash: ${callRecord.hash}. This does not sign or send.`,
    action: {
      type: "result",
      result: {
        version: "2.0.0",
        id,
        chainId: hexChainId(chain.chainId),
        status: 200,
        atomic: false,
        receipts: [
          {
            transactionHash: callRecord.hash,
            status: receipt.status,
            blockHash: receipt.blockHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            logs: Array.isArray(receipt.logs) ? receipt.logs : [],
          },
        ],
      },
    },
  };
}

export async function prepareWcRequest(record, { address, caps, fetchImpl = fetch, callRecord = null } = {}) {
  const wallet = requireAddress(address, "wallet");
  const decision = classifyMethod(record.method);
  if (!decision.allow) throw new CliError(decision.rawHash ? "raw hash signing is refused" : "unsupported method");
  let detail;
  if (record.method === "personal_sign") detail = personalSign(record, wallet);
  else if (record.method === "eth_signTypedData_v4") detail = typedSign(record, wallet);
  else if (record.method === "eth_sendTransaction") detail = await sendTransaction(record, wallet, caps, fetchImpl);
  else if (record.method === "wallet_sendCalls") detail = await sendCalls(record, wallet, caps, fetchImpl);
  else if (record.method === "wallet_getCallsStatus") detail = await callsStatus(record, callRecord, fetchImpl);
  else detail = readResult(record, wallet);
  return {
    summary: `${formatRequest(record)}\n${detail.summary}`,
    action: detail.action,
  };
}

export function newBatchId() {
  return `0x${randomBytes(32).toString("hex")}`;
}
