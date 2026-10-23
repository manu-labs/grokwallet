# Changelog

## 0.2.7

- The approval page favicon now matches the header logo. The CLI is unchanged.

## 0.2.6

- The bot release tarball includes production dependencies. After checking `SHA256SUMS`, extract it and run `node bin/grokwallet.js`. No `npm ci` step.
- `grokwallet doctor` checks Node, the config file, login state, and RPC reachability, and prints a one-line fix for each failure.
- `grokwallet --version` prints the package version. `grokwallet verify` re-checks installed files against the manifest bundled in the release.
- `wc pair --from-file` reads a pairing URI from a file or stdin. `wc pair --paste` opens a one-time page on `127.0.0.1`.
- `wc proposals` and `wc requests` lead with the origin and Verify result (`VALID`, `UNKNOWN`, or `MISMATCH`), then the chains, methods, and a decoded summary.
- Stale pending proposals and requests expire on their own. `wc clear` disconnects sessions and drops pending items.
- `--dry-run` on send, sign, and `wc approve` prints the summary and cap result without signing or broadcasting.
- Errors are two lines, and stack traces stay hidden unless `GROKWALLET_DEBUG` is set.
- Token balances include the name and symbol when the contract provides them.
- Docs: `docs/commands.md`, `docs/security.md`, `docs/walletconnect.md`, `docs/troubleshooting.md`, and this changelog. Publish puts the matching changelog section on the GitHub release.

## 0.2.5

- The CLI ships a public WalletConnect project id. `GROKWALLET_WC_PROJECT_ID` still overrides `wcProjectId` in the local config, and either overrides the built-in id.

## 0.2.4

- Wallet-side WalletConnect v2 pairing. Each proposal and each request is approved by its own id with `--yes`.
- The same spend caps apply to `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, and a one-call `wallet_sendCalls`.
- Raw-hash methods are rejected. The summary shows the Verify origin and warns on a mismatch.

## 0.2.3

- `sign-typed-data` for EIP-712, including a domain chain id that is not one of the configured chains.
- `send-erc20` with a per-token cap, and `send-eth --data` for contract calls. ERC-20 transfer calldata in `send-eth --data` is refused.
- Arbitrum and Arbitrum Sepolia.
- `sign-message --message-file`, including stdin.

## 0.2.2

- The Connect card can finish only after the approval page proves that `device_verify` succeeded.
