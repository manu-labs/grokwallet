import { readFileSync } from "node:fs";
import { CliError, DryRun } from "./redact.js";
import { loadSession, requireAppId, resolveAppId, saveSession, deleteSession, writeConfig } from "./session.js";
import {
  authenticateWallets,
  formatLoginPrompt,
  newIdempotencyKey,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
  walletRpc,
} from "./privy.js";
import { chainConfig, chainNames, ethBalance, solBalance, solanaBlockhash } from "./balances.js";
import { connectorUrlForUserCode } from "./home.js";
import { buildSolTransfer } from "./solana.js";
import {
  assertWithinCap,
  assertWithinTokenCap,
  formatCaps,
  normalizeCaps,
  policyDocuments,
  setCapAmount,
  setTokenCap,
  tokenCapKey,
} from "./policy.js";
import { ETH_DECIMALS, SOL_DECIMALS, formatUnits, parseUnits } from "./units.js";
import {
  buildEthSendBody,
  encodeErc20Transfer,
  erc20SpendSelector,
  normalizeCalldata,
  readErc20Balance,
  readErc20Decimals,
  readErc20Name,
  readErc20Symbol,
  requireAddress,
  summarizeErc20,
  summarizeEthSend,
} from "./erc20.js";
import { resolveMessage, summarizeMessage } from "./message.js";
import { buildTypedDataBody, loadTypedData, summarizeTypedData } from "./typed-data.js";

function requireFlag(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === "") {
    throw new CliError(`missing --${name}`);
  }
  if (Array.isArray(value)) throw new CliError(`pass --${name} once`);
  return String(value);
}

function flagList(flags, name) {
  const value = flags[name];
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  if (items.some((item) => item === true || item === "")) throw new CliError(`missing --${name} value`);
  return items.map(String);
}

function readUtf8File(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new CliError(`could not read ${path}`);
  }
}

function readStdinUtf8() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    throw new CliError("could not read the message from stdin");
  }
}

export function requireSession() {
  const session = loadSession();
  if (!session?.accessToken || !session?.refreshToken) {
    throw new CliError("not logged in. Run: grokwallet login");
  }
  return session;
}

export function walletOf(session, chainType) {
  const matches = (session.wallets || []).filter((wallet) => wallet.chainType === chainType);
  if (matches.length === 0) {
    throw new CliError(
      `no ${chainType} wallet on this Privy account yet. Open the approval page while signed in so it can create one, then run addresses.`,
    );
  }
  return matches[0];
}

function applyTokenResponse(session, payload) {
  const expiresIn = Number(payload.expires_in || 900);
  const next = {
    ...session,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpiresAt: Date.now() + expiresIn * 1000,
  };
  saveSession(next);
  return next;
}

async function ensureAccess(session) {
  if (session.accessExpiresAt && session.accessExpiresAt > Date.now() + 60_000) return session;
  const payload = await refreshAccessToken({
    appId: session.appId,
    refreshToken: session.refreshToken,
  });
  return applyTokenResponse(session, payload);
}

export async function runWalletRpc(session, walletId, body, { idempotency = false } = {}) {
  return withSigningKey(session, (current, authorizationKey) =>
    walletRpc({
      appId: current.appId,
      accessToken: current.accessToken,
      authorizationKey,
      walletId,
      body,
      idempotencyKey: idempotency ? newIdempotencyKey() : undefined,
    }),
  );
}

async function withSigningKey(session, fn) {
  let current = await ensureAccess(session);
  const authed = await authenticateWallets({
    appId: current.appId,
    accessToken: current.accessToken,
  });
  current = {
    ...current,
    wallets: authed.wallets.length > 0 ? authed.wallets : current.wallets || [],
  };
  saveSession(current);
  try {
    return await fn(current, authed.authorizationKey);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 401) {
      const refreshed = applyTokenResponse(
        current,
        await refreshAccessToken({ appId: current.appId, refreshToken: current.refreshToken }),
      );
      const again = await authenticateWallets({
        appId: refreshed.appId,
        accessToken: refreshed.accessToken,
      });
      return fn(refreshed, again.authorizationKey);
    }
    throw error;
  }
}

function printWallets(wallets) {
  if (!wallets?.length) {
    process.stdout.write("no wallets yet\n");
    return;
  }
  for (const wallet of wallets) {
    process.stdout.write(`${wallet.chainType} ${wallet.address} ${wallet.id}\n`);
  }
}

export async function login() {
  const appId = requireAppId();
  writeConfig({ appId });
  const device = await requestDeviceCode({ appId });
  process.stdout.write(
    formatLoginPrompt({
      verificationUriComplete: device.verification_uri_complete,
      userCode: device.user_code,
      connectorUrl: connectorUrlForUserCode(device.user_code),
      expiresInSeconds: device.expires_in,
    }),
  );
  process.stderr.write(`waiting for approval for ${device.expires_in}s\n`);
  const tokens = await pollDeviceToken({
    appId,
    deviceCode: device.device_code,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  });
  let session = applyTokenResponse(
    { v: 1, appId, wallets: [], caps: normalizeCaps() },
    tokens,
  );
  const authed = await authenticateWallets({ appId, accessToken: session.accessToken });
  session = { ...session, wallets: authed.wallets };
  saveSession(session);
  process.stdout.write("approved\n");
  printWallets(session.wallets);
}

export function status() {
  const appId = resolveAppId();
  let session = null;
  try {
    session = loadSession();
  } catch (error) {
    if (error instanceof CliError && error.message.includes("decrypt")) throw error;
    throw error;
  }
  if (!session) {
    process.stdout.write(`logged_out\napp_id: ${appId || "unset"}\n`);
    return;
  }
  process.stdout.write("logged_in\n");
  process.stdout.write(`app_id: ${session.appId}\n`);
  process.stdout.write(`access_expires_at: ${session.accessExpiresAt || "unknown"}\n`);
  printWallets(session.wallets);
  process.stdout.write(`${formatCaps(session.caps)}\n`);
}

export async function addresses() {
  let session = requireSession();
  session = await ensureAccess(session);
  const authed = await authenticateWallets({ appId: session.appId, accessToken: session.accessToken });
  session = { ...session, wallets: authed.wallets };
  saveSession(session);
  printWallets(session.wallets);
}

async function writeTokenBalance(chain, wallet, token, fetchImpl) {
  let raw;
  try {
    raw = await readErc20Balance(chain.rpc, token, wallet, fetchImpl);
  } catch {
    process.stdout.write(`${chain.name} ${wallet} token ${token} balance unavailable\n`);
    return;
  }
  let decimals = 0;
  try {
    decimals = await readErc20Decimals(chain.rpc, token, fetchImpl);
  } catch {
    decimals = null;
  }
  const symbol = decimals == null ? null : await readErc20Symbol(chain.rpc, token, fetchImpl);
  const name = decimals == null ? null : await readErc20Name(chain.rpc, token, fetchImpl);
  const amount = decimals == null ? raw.toString() : formatUnits(raw, decimals);
  const symbolText = symbol || "symbol unavailable";
  const nameText = name || "name unavailable";
  process.stdout.write(`${chain.name} ${wallet} ${amount} ${symbolText} (${nameText}) token ${token}\n`);
}

export async function balance(flags, fetchImpl = fetch) {
  const session = requireSession();
  if (flags.token) {
    const chain = chainConfig(flags.chain ? String(flags.chain) : "ethereum");
    if (chain.kind !== "evm") {
      throw new CliError(
        "token balances are EVM only",
        1,
        "Pass --chain ethereum, base, arbitrum, or arbitrum-sepolia with --token.",
      );
    }
    const wallet = walletOf(session, "ethereum");
    await writeTokenBalance(chain, wallet.address, requireAddress(flags.token, "token"), fetchImpl);
    return;
  }
  const names = flags.chain ? [String(flags.chain)] : ["ethereum", "base", "solana"];
  for (const name of names) {
    const chain = chainConfig(name);
    if (chain.kind === "evm") {
      const wallet = walletOf(session, "ethereum");
      const wei = await ethBalance(wallet.address, chain.rpc, fetchImpl);
      process.stdout.write(`${name} ${wallet.address} ${formatUnits(wei, ETH_DECIMALS)} ETH\n`);
    } else {
      const wallet = walletOf(session, "solana");
      const lamports = await solBalance(wallet.address, chain.rpc, fetchImpl);
      process.stdout.write(`${name} ${wallet.address} ${formatUnits(lamports, SOL_DECIMALS)} SOL\n`);
    }
  }
  const tokens = Object.keys(normalizeCaps(session.caps).tokens).sort();
  for (const key of tokens) {
    const split = key.indexOf(":");
    const chainName = key.slice(0, split);
    const token = key.slice(split + 1);
    if (flags.chain && chainName !== String(flags.chain)) continue;
    const chain = chainConfig(chainName);
    const wallet = walletOf(session, "ethereum");
    await writeTokenBalance(chain, wallet.address, token, fetchImpl);
  }
}

export function requireYes(flags, summary) {
  process.stdout.write(`${summary}\n`);
  if (flags["dry-run"]) {
    process.stdout.write("dry-run: nothing was signed or broadcast\n");
    throw new DryRun();
  }
  if (!flags.yes) {
    throw new CliError(
      "refusing without --yes",
      2,
      "Show this summary in chat and wait for an explicit yes, then run the command again with --yes.",
    );
  }
}

export function prepareEthSend(flags) {
  const to = requireAddress(requireFlag(flags, "to"), "recipient");
  const chainName = flags.chain ? String(flags.chain) : "ethereum";
  const chain = chainConfig(chainName);
  if (chain.kind !== "evm") throw new CliError("send-eth chain must be an EVM chain");
  const data = flags.data === undefined ? null : normalizeCalldata(requireFlag(flags, "data"));
  if (data && erc20SpendSelector(data)) {
    throw new CliError(
      "this calldata is an ERC-20 transfer or transferFrom. Use send-erc20 so the per-token cap applies.",
    );
  }
  const amount = parseUnits(requireFlag(flags, "amount"), ETH_DECIMALS, { allowZero: Boolean(data) });
  const body = buildEthSendBody({
    caip2: chain.caip2,
    to,
    valueWei: amount,
    chainId: chain.chainId,
    data,
  });
  return { to, chain, chainName, amount, amountText: formatUnits(amount, ETH_DECIMALS), data, body };
}

export async function sendEth(flags) {
  const prepared = prepareEthSend(flags);
  const session = requireSession();
  const from = walletOf(session, "ethereum");
  assertWithinCap(session.caps, "eth", prepared.amount);
  requireYes(
    flags,
    summarizeEthSend({
      chainName: prepared.chainName,
      from: from.address,
      to: prepared.to,
      amountText: prepared.amountText,
      data: prepared.data,
    }),
  );
  const result = await withSigningKey(session, (current, authorizationKey) =>
    walletRpc({
      appId: current.appId,
      accessToken: current.accessToken,
      authorizationKey,
      walletId: from.id,
      body: prepared.body,
      idempotencyKey: newIdempotencyKey(),
    }),
  );
  const hash = result?.data?.hash || result?.hash || "";
  process.stdout.write(`submitted ${prepared.chainName} ${hash}\n`);
}

export async function prepareErc20Send(flags, { caps, fetchImpl = fetch } = {}) {
  const chainName = requireFlag(flags, "chain");
  const chain = chainConfig(chainName);
  if (chain.kind !== "evm") throw new CliError("send-erc20 chain must be an EVM chain");
  const token = requireAddress(requireFlag(flags, "token"), "token");
  const to = requireAddress(requireFlag(flags, "to"), "recipient");
  const amountText = requireFlag(flags, "amount");
  const key = tokenCapKey(chain.name, token);
  if (!normalizeCaps(caps).tokens[key]) assertWithinTokenCap(caps, chain.name, token, 0n, 0);
  const decimals = await readErc20Decimals(chain.rpc, token, fetchImpl);
  const raw = parseUnits(amountText, decimals);
  const capHuman = assertWithinTokenCap(caps, chain.name, token, raw, decimals);
  const symbol = await readErc20Symbol(chain.rpc, token, fetchImpl);
  const data = encodeErc20Transfer(to, raw);
  const body = buildEthSendBody({
    caip2: chain.caip2,
    to: token,
    valueWei: 0n,
    chainId: chain.chainId,
    data,
  });
  return {
    chain,
    chainName,
    token,
    to,
    amountText: formatUnits(raw, decimals),
    symbol,
    decimals,
    raw,
    capHuman,
    data,
    body,
  };
}

export async function sendErc20(flags) {
  const session = requireSession();
  const from = walletOf(session, "ethereum");
  const prepared = await prepareErc20Send(flags, { caps: session.caps });
  requireYes(flags, summarizeErc20({ ...prepared, from: from.address }));
  const result = await withSigningKey(session, (current, authorizationKey) =>
    walletRpc({
      appId: current.appId,
      accessToken: current.accessToken,
      authorizationKey,
      walletId: from.id,
      body: prepared.body,
      idempotencyKey: newIdempotencyKey(),
    }),
  );
  const hash = result?.data?.hash || result?.hash || "";
  process.stdout.write(`submitted ${prepared.chainName} ${hash}\n`);
}

export async function sendSol(flags) {
  const to = requireFlag(flags, "to");
  const amount = parseUnits(requireFlag(flags, "amount"), SOL_DECIMALS);
  const session = requireSession();
  const from = walletOf(session, "solana");
  assertWithinCap(session.caps, "sol", amount);
  requireYes(flags, `send ${formatUnits(amount, SOL_DECIMALS)} SOL from ${from.address} to ${to}`);
  const chain = chainConfig("solana");
  const recentBlockhash = await solanaBlockhash(chain.rpc);
  const transaction = buildSolTransfer({
    from: from.address,
    to,
    lamports: amount,
    recentBlockhash,
  });
  const body = {
    method: "signAndSendTransaction",
    caip2: chain.caip2,
    chain_type: "solana",
    params: { transaction, encoding: "base64" },
  };
  const result = await withSigningKey(session, (current, authorizationKey) =>
    walletRpc({
      appId: current.appId,
      accessToken: current.accessToken,
      authorizationKey,
      walletId: from.id,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),
  );
  const hash = result?.data?.hash || result?.hash || "";
  process.stdout.write(`submitted solana ${hash}\n`);
}

export async function signMessage(flags) {
  const chainName = requireFlag(flags, "chain");
  const message = resolveMessage(flags, { readFile: readUtf8File, readStdin: readStdinUtf8 });
  const session = requireSession();
  if (chainName === "ethereum") {
    const wallet = walletOf(session, "ethereum");
    requireYes(flags, summarizeMessage("ethereum", wallet.address, message));
    const body = {
      method: "personal_sign",
      chain_type: "ethereum",
      params: { message, encoding: "utf-8" },
    };
    const result = await withSigningKey(session, (current, authorizationKey) =>
      walletRpc({
        appId: current.appId,
        accessToken: current.accessToken,
        authorizationKey,
        walletId: wallet.id,
        body,
      }),
    );
    process.stdout.write(`signature ${result?.data?.signature || ""}\n`);
    return;
  }
  if (chainName === "solana") {
    const wallet = walletOf(session, "solana");
    requireYes(flags, summarizeMessage("solana", wallet.address, message));
    const body = {
      method: "signMessage",
      chain_type: "solana",
      params: { message: Buffer.from(message, "utf8").toString("base64"), encoding: "base64" },
    };
    const result = await withSigningKey(session, (current, authorizationKey) =>
      walletRpc({
        appId: current.appId,
        accessToken: current.accessToken,
        authorizationKey,
        walletId: wallet.id,
        body,
      }),
    );
    process.stdout.write(`signature ${result?.data?.signature || ""}\n`);
    return;
  }
  throw new CliError("sign-message chain must be ethereum or solana");
}

export async function signTypedData(flags) {
  const chainName = requireFlag(flags, "chain");
  if (chainName !== "ethereum") {
    throw new CliError(
      "sign-typed-data --chain must be ethereum. The domain chainId is taken from the typed data and is not checked against a configured chain.",
    );
  }
  const typed = loadTypedData(requireFlag(flags, "data"), {
    readFile: readUtf8File,
    readStdin: readStdinUtf8,
  });
  const session = requireSession();
  const wallet = walletOf(session, "ethereum");
  requireYes(flags, summarizeTypedData(typed, wallet.address));
  const body = buildTypedDataBody(typed);
  const result = await withSigningKey(session, (current, authorizationKey) =>
    walletRpc({
      appId: current.appId,
      accessToken: current.accessToken,
      authorizationKey,
      walletId: wallet.id,
      body,
    }),
  );
  process.stdout.write(`signature ${result?.data?.signature || ""}\n`);
}

export function cap(rest, flags) {
  const action = rest[0] || "show";
  if (action === "policy") {
    const session = requireSession();
    const docs = policyDocuments(session.caps);
    if (docs.length === 0) {
      throw new CliError(
        "set an ETH or SOL cap before printing a Privy policy. ERC-20 caps are enforced by this CLI only and are not part of that document.",
      );
    }
    process.stdout.write(`${JSON.stringify(docs, null, 2)}\n`);
    process.stderr.write(
      "Privy policy creation (POST /v1/policies) requires the app secret, which this CLI does not have. These documents are for the app owner to install in the dashboard. The CLI cap is enforced locally. ERC-20 caps are not in these documents.\n",
    );
    return;
  }
  if (action === "show") {
    const session = loadSession();
    process.stdout.write(`${formatCaps(session?.caps)}\n`);
    return;
  }
  if (action === "clear") {
    const session = requireSession();
    saveSession({ ...session, caps: normalizeCaps() });
    process.stdout.write("cap cleared\n");
    return;
  }
  if (action === "set") {
    const session = requireSession();
    let caps = normalizeCaps(session.caps);
    const tokens = flagList(flags, "token");
    if (!flags.eth && !flags.sol && tokens.length === 0) {
      throw new CliError("pass --eth, --sol, or --token chain:0xaddress=amount");
    }
    if (flags.eth) caps = setCapAmount(caps, "eth", flags.eth);
    if (flags.sol) caps = setCapAmount(caps, "sol", flags.sol);
    for (const spec of tokens) caps = setTokenCap(caps, spec);
    saveSession({ ...session, caps });
    process.stdout.write(`${formatCaps(caps)}\n`);
    return;
  }
  throw new CliError("cap command must be show, set, clear, or policy");
}

export function logout() {
  deleteSession();
  process.stdout.write("logged_out\n");
  process.stderr.write(
    "Local tokens were deleted. To revoke the grant on Privy, open the approval page and revoke the session there.\n",
  );
}

const evmChains = chainNames("evm").join("|");
const balanceChains = chainNames().join("|");

export const HELP = `grokwallet commands:
  login
  status
  addresses
  balance [--chain ${balanceChains}] [--token 0x...]
  send-eth --to 0x... --amount 0.01 [--chain ${evmChains}] [--data 0x...] [--dry-run] --yes
  send-erc20 --chain ${evmChains} --token 0x... --to 0x... --amount 10 [--dry-run] --yes
  send-sol --to <address> --amount 0.01 [--dry-run] --yes
  sign-message --chain ethereum|solana (--message <text> | --message-file <path|->) [--dry-run] --yes
  sign-typed-data --chain ethereum --data <json|@file> [--dry-run] --yes
  cap show|set|clear|policy [--eth 0.01] [--sol 0.01] [--token chain:0xaddress=amount]
  wc pair (<wc-uri> | --from-file <path|-> | --paste) [--timeout 30]
  wc proposals
  wc approve-proposal <id> --yes
  wc reject-proposal <id>
  wc requests
  wc approve <id> [--dry-run] --yes
  wc reject <id>
  wc sessions
  wc disconnect <topic>
  wc clear
  doctor
  verify
  logout

--version prints the package version.
--dry-run prints the summary and runs the cap checks, then stops before any signature or broadcast.
send-eth checks native ETH value against the ETH cap. --amount 0 is allowed only with --data.
send-erc20 reads token decimals from the contract and refuses unless a cap is set for that chain and token.
An ERC-20 transfer or transferFrom in send-eth --data is refused; use send-erc20.
sign-typed-data prints domain.chainId, verifyingContract, primaryType, and message, then asks Privy for eth_signTypedData_v4.
A domain chainId such as Hyperliquid 0x66eee is not compared to the wallet chain.
--message-file and --message-file - keep the file or stdin bytes, including line breaks.
wc pair keeps a background relay process. Each proposal and each request is approved by its own id.
personal_sign, eth_signTypedData_v4, eth_sendTransaction, and wallet_sendCalls use the same summaries and caps as the matching commands.
An ERC-20 transfer inside a WalletConnect send is capped per token. eth_sign and other raw-hash methods are refused.
A public WalletConnect project id is built in. GROKWALLET_WC_PROJECT_ID overrides wcProjectId in ~/.grokwallet/config.json, and either overrides the built-in id. Create one at https://dashboard.reown.com.
Stdout from login is the verification URL, the user code, and a connector URL.
The connector URL embeds only the public user code.
Tokens, the passphrase, the device code, and signing keys are never printed.
`;
