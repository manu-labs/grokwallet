import { chainConfig, chainNames } from "../balances.js";
import { requireAddress } from "../erc20.js";
import { CliError } from "../redact.js";
import {
  boundedText,
  classifyMethod,
  effectiveVerify,
  formatOrigin,
  originReport,
  payloadHash,
  pendingExpiry,
} from "./safety.js";

const ALLOWED_EVENTS = new Set(["chainChanged", "accountsChanged"]);

export function evmCaip2Set() {
  return new Set(chainNames("evm").map((name) => chainConfig(name).caip2));
}

function unique(values) {
  return [...new Set(values)];
}

function clip(value, limit) {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? text.slice(0, limit) : text;
}

export function flattenNamespaces(namespaces) {
  const chains = [];
  const methods = [];
  const events = [];
  const other = [];
  if (!namespaces || typeof namespaces !== "object" || Array.isArray(namespaces)) {
    return { chains, methods, events, other };
  }
  for (const [key, value] of Object.entries(namespaces)) {
    if (!value || typeof value !== "object") continue;
    if (key !== "eip155") {
      other.push(key);
      continue;
    }
    for (const chain of value.chains || []) chains.push(String(chain));
    for (const method of value.methods || []) methods.push(String(method));
    for (const event of value.events || []) events.push(String(event));
  }
  return {
    chains: unique(chains),
    methods: unique(methods),
    events: unique(events),
    other: unique(other),
  };
}

export function freezeProposal(event) {
  if (!event || !Number.isInteger(event.id)) throw new CliError("session proposal is missing an id");
  const params = event.params || {};
  const metadata = params.proposer?.metadata || {};
  const claimedName = boundedText(metadata.name, 300, "dapp name");
  const claimedUrl = boundedText(metadata.url, 500, "dapp URL");
  const verify = effectiveVerify(event.verifyContext, null);
  const required = flattenNamespaces(params.requiredNamespaces);
  const optional = flattenNamespaces(params.optionalNamespaces);
  const record = {
    id: event.id,
    pairingTopic: typeof params.pairingTopic === "string" ? params.pairingTopic : "",
    claimedName,
    claimedUrl,
    verify,
    origin: originReport(verify, claimedUrl),
    required,
    optional,
  };
  record.payloadHash = payloadHash({
    id: record.id,
    claimedName,
    claimedUrl,
    verifyOrigin: verify.origin,
    verifyValidation: verify.validation,
    verifyScam: verify.isScam,
    required,
    optional,
  });
  record.expiresAt = pendingExpiry(event);
  return record;
}

export function planSessionApproval(record, address) {
  const wallet = requireAddress(address, "wallet");
  const required = record.required;
  const optional = record.optional;
  const supported = evmCaip2Set();
  if (required.other.length > 0) {
    return { ok: false, reason: `required namespace is not supported: ${required.other.join(", ")}` };
  }
  for (const chain of required.chains) {
    if (!supported.has(chain)) return { ok: false, reason: `required chain is not supported: ${chain}` };
  }
  for (const method of required.methods) {
    const decision = classifyMethod(method);
    if (!decision.allow) return { ok: false, reason: `required method is not supported: ${method}` };
  }
  for (const event of required.events) {
    if (!ALLOWED_EVENTS.has(event)) return { ok: false, reason: `required event is not supported: ${event}` };
  }
  const chains = unique([...required.chains, ...optional.chains.filter((chain) => supported.has(chain))]);
  if (chains.length === 0) return { ok: false, reason: "proposal does not request a supported EVM chain" };
  const methods = unique([...required.methods, ...optional.methods.filter((method) => classifyMethod(method).allow)]);
  if (methods.length === 0) return { ok: false, reason: "proposal does not request a supported method" };
  const events = unique([...required.events, ...optional.events.filter((event) => ALLOWED_EVENTS.has(event))]);
  const accounts = chains.map((chain) => `${chain}:${wallet}`);
  return {
    ok: true,
    chains,
    methods,
    events,
    accounts,
    namespaces: { eip155: { chains, accounts, methods, events } },
    skippedChains: optional.chains.filter((chain) => !supported.has(chain)),
    skippedMethods: optional.methods.filter((method) => !classifyMethod(method).allow),
    skippedNamespaces: optional.other,
  };
}

function list(values) {
  return values && values.length > 0 ? values.join(", ") : "(none)";
}

export function formatProposal(record, address) {
  const plan = address ? planSessionApproval(record, address) : null;
  const lines = [
    formatOrigin(record),
    `proposal: ${record.id}`,
    `required chains: ${list(record.required.chains)}`,
    `required methods: ${list(record.required.methods)}`,
    `required events: ${list(record.required.events)}`,
    `optional chains: ${list(record.optional.chains)}`,
    `optional methods: ${list(record.optional.methods)}`,
    `optional events: ${list(record.optional.events)}`,
  ];
  if (record.required.other.length > 0) lines.push(`other required namespaces: ${record.required.other.join(", ")}`);
  if (!plan) return lines.join("\n");
  if (!plan.ok) {
    lines.push(`will grant: refused`);
    lines.push(`refused: ${plan.reason}`);
    return lines.join("\n");
  }
  lines.push(`will grant chains: ${list(plan.chains)}`);
  lines.push(`will grant methods: ${list(plan.methods)}`);
  lines.push(`will grant accounts: ${list(plan.accounts)}`);
  if (plan.skippedChains.length > 0) lines.push(`not granted chains: ${plan.skippedChains.join(", ")}`);
  if (plan.skippedMethods.length > 0) lines.push(`not granted methods: ${plan.skippedMethods.join(", ")}`);
  return lines.join("\n");
}

export function sessionView({ topic, peer, namespaces, verify, claimedName, claimedUrl }) {
  const chains = [];
  const methods = [];
  const accounts = [];
  for (const value of Object.values(namespaces || {})) {
    for (const account of value.accounts || []) {
      accounts.push(String(account));
      const parts = String(account).split(":");
      if (parts.length >= 3) chains.push(`${parts[0]}:${parts[1]}`);
    }
    for (const chain of value.chains || []) chains.push(String(chain));
    for (const method of value.methods || []) methods.push(String(method));
  }
  const name = clip(claimedName || peer?.metadata?.name || "", 300);
  const url = clip(claimedUrl || peer?.metadata?.url || "", 500);
  const verified = verify || { origin: "", validation: "UNKNOWN", isScam: false };
  return {
    topic,
    claimedName: name,
    claimedUrl: url,
    verify: verified,
    origin: originReport(verified, url),
    chains: unique(chains),
    methods: unique(methods),
    accounts: unique(accounts),
  };
}

export function formatSession(session) {
  return [
    formatOrigin(session),
    `session: ${session.topic}`,
    `chains: ${list(session.chains)}`,
    `methods: ${list(session.methods)}`,
    `accounts: ${list(session.accounts)}`,
  ].join("\n");
}
