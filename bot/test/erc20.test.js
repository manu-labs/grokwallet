import assert from "node:assert/strict";
import test from "node:test";
import { prepareErc20Send, prepareEthSend } from "../src/commands.js";
import {
  decodeAbiString,
  encodeErc20Transfer,
  readErc20Decimals,
  TRANSFER_SELECTOR,
} from "../src/erc20.js";
import { assertWithinTokenCap, formatCaps, policyDocuments, setCapAmount, setTokenCap } from "../src/policy.js";
import { parseUnits } from "../src/units.js";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";

test("arbitrum send can carry calldata and a zero native value", () => {
  const prepared = prepareEthSend({
    to: BRIDGE,
    amount: "0",
    chain: "arbitrum",
    data: "0x1234abcd",
  });
  assert.equal(prepared.body.caip2, "eip155:42161");
  assert.equal(prepared.body.params.transaction.chain_id, 42161);
  assert.equal(prepared.body.params.transaction.value, "0x0");
  assert.equal(prepared.body.params.transaction.data, "0x1234abcd");
  assert.match(prepared.amountText, /^0$/);
  const sepolia = prepareEthSend({
    to: BRIDGE,
    amount: "0.01",
    chain: "arbitrum-sepolia",
  });
  assert.equal(sepolia.body.caip2, "eip155:421614");
  assert.equal(sepolia.body.params.transaction.chain_id, 421614);
  assert.equal(Object.hasOwn(sepolia.body.params.transaction, "data"), false);
  assert.throws(() => prepareEthSend({ to: BRIDGE, amount: "0", chain: "arbitrum" }));
  assert.throws(() => prepareEthSend({ to: BRIDGE, amount: "0.01", chain: "solana" }));
});

test("send-eth refuses ERC-20 transfer calldata so it cannot skip the token cap", () => {
  const data = encodeErc20Transfer(BRIDGE, 10_000_000n);
  assert.equal(data.slice(2, 10), TRANSFER_SELECTOR);
  assert.equal(data.slice(10, 74), BRIDGE.slice(2).toLowerCase().padStart(64, "0"));
  assert.equal(BigInt(`0x${data.slice(74)}`), 10_000_000n);
  assert.throws(() => prepareEthSend({ to: USDC, amount: "0", chain: "arbitrum", data }));
  assert.throws(() =>
    prepareEthSend({ to: USDC, amount: "0", chain: "arbitrum", data: `0x23b872dd${"00".repeat(32)}` }),
  );
  assert.throws(() => prepareEthSend({ to: USDC, amount: "0", chain: "arbitrum", data: "0xabc" }));
});

test("ERC-20 sends require a per-token cap and use on-chain decimals", async () => {
  const rawTen = parseUnits("10", 6);
  assert.throws(() => assertWithinTokenCap({}, "arbitrum", USDC, rawTen, 6));
  let caps = setTokenCap({}, `arbitrum:${USDC}=10`);
  caps = setCapAmount(caps, "eth", "0.02");
  assert.equal(assertWithinTokenCap(caps, "arbitrum", USDC.toLowerCase(), rawTen, 6), "10");
  assert.throws(() => assertWithinTokenCap(caps, "arbitrum", USDC, parseUnits("10.1", 6), 6));
  assert.throws(() => assertWithinTokenCap(caps, "base", USDC, rawTen, 6));
  const docs = policyDocuments(caps);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].chain_type, "ethereum");
  assert.equal(docs[0].rules[0].conditions[0].field, "value");
  assert.match(formatCaps(caps), /token arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831: 10/);

  const previous = process.env.GROKWALLET_ARBITRUM_RPC;
  process.env.GROKWALLET_ARBITRUM_RPC = "https://rpc.example.test";
  try {
    const prepared = await prepareErc20Send(
      { chain: "arbitrum", token: USDC, to: BRIDGE, amount: "10" },
      { caps, fetchImpl: fakeTokenRpc },
    );
    assert.equal(prepared.decimals, 6);
    assert.equal(prepared.symbol, "USDC");
    assert.equal(prepared.raw, rawTen);
    assert.equal(prepared.body.params.transaction.to, USDC);
    assert.equal(prepared.body.params.transaction.value, "0x0");
    assert.equal(prepared.body.params.transaction.chain_id, 42161);
    assert.equal(prepared.body.params.transaction.data, encodeErc20Transfer(BRIDGE, rawTen));
    assert.match(prepared.capHuman, /^10$/);
    await assert.rejects(
      () =>
        prepareErc20Send(
          { chain: "arbitrum", token: USDC, to: BRIDGE, amount: "10" },
          { caps: {}, fetchImpl: fakeTokenRpc },
        ),
      /no spend cap/,
    );
  } finally {
    if (previous === undefined) delete process.env.GROKWALLET_ARBITRUM_RPC;
    else process.env.GROKWALLET_ARBITRUM_RPC = previous;
  }
});

test("reads decimals and an ABI string symbol", async () => {
  const decimals = await readErc20Decimals("https://rpc.example.test", USDC, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.method, "eth_call");
    assert.equal(body.params[0].data, "0x313ce567");
    return { ok: true, status: 200, json: async () => ({ result: `0x${(6).toString(16).padStart(64, "0")}` }) };
  });
  assert.equal(decimals, 6);
  const word = (value) => value.toString(16).padStart(64, "0");
  const encoded = `0x${word(32n)}${word(4n)}${"55534443".padEnd(64, "0")}`;
  assert.equal(decodeAbiString(encoded), "USDC");
  assert.equal(decodeAbiString(`0x${Buffer.from("USDC").toString("hex").padEnd(64, "0")}`), "USDC");
});

function fakeTokenRpc(_url, init) {
  const body = JSON.parse(init.body);
  if (body.params[0].data === "0x313ce567") {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ result: `0x${(6).toString(16).padStart(64, "0")}` }),
    });
  }
  const word = (value) => value.toString(16).padStart(64, "0");
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ result: `0x${word(32n)}${word(4n)}${"55534443".padEnd(64, "0")}` }),
  });
}
