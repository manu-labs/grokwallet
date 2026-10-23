# Security

GrokWallet is non-custodial. Privy holds the keys. This CLI holds an encrypted session and asks Privy to sign. It has no app secret. A person who clones the repo can read the public app id and the public WalletConnect project id. They cannot move the owner's funds with those values.

## Threat model

What this program is for: a bot, on a machine the owner chose, sends and signs only after a summary and an explicit `--yes`, and only inside a local spend cap.

What an attacker on that machine can do: read `~/.grokwallet`, ask the CLI to sign until the owner revokes the Privy session, and use any WalletConnect session the CLI has approved. Treat that disk as able to spend, up to the cap and any Privy policy, until revoke or until the refresh token expires.

What this program does not defend against: a Privy account compromise, a malicious approval in the browser, or a yes to a summary the owner did not read. Dapp name, URL, and calldata are untrusted. They cannot change which request id is approved. The daemon checks the payload hash again before it answers the relay.

## Approvals

`login` uses the Privy device flow. The approval page at `https://grokwallet.fun/` calls `device_verify`. The Connect card completes only after that page presents proof that `device_verify` succeeded. The CLI polls Privy for tokens. Those tokens are encrypted with `GROKWALLET_PASSPHRASE` before they touch disk.

Every send and signature prints a summary, then refuses with exit code 2 unless `--yes` is present. `--dry-run` prints that summary and runs the cap checks, and it does not sign or broadcast. WalletConnect requests use the same rule. Nothing is auto-approved, including `eth_accounts`.

`eth_sign` and other raw-hash methods are rejected when they arrive. They are not left pending.

## Spending caps

Caps live in the encrypted session. They are local. Privy does not enforce them unless the app owner installs a policy, and installing a policy needs the app secret.

| Action | Cap |
| --- | --- |
| `send-eth`, including `--data` | Native value against `cap set --eth`. If no ETH cap is set, the CLI still allows the send after `--yes` |
| `send-sol` | Lamports against `cap set --sol` |
| `send-erc20` | The human amount against `cap set --token chain:0xaddress=amount`, after `decimals()`. Refused when that cap is missing |
| `send-eth --data` whose selector is ERC-20 `transfer` or `transferFrom` | Refused. Use `send-erc20` |
| WalletConnect `eth_sendTransaction` or one-call `wallet_sendCalls` that moves an ERC-20 | The token cap. The dapp chose the calldata, so the CLI checks it in place instead of redirecting |
| `wallet_sendCalls` with more than one call | Refused |
| `sign-message`, `sign-typed-data` | No amount cap. The summary is still required |

`cap policy` prints Privy policy JSON for native ETH and SOL only. Token caps are not in that document.

## What is stored where

| Path | Mode | Contents |
| --- | --- | --- |
| `~/.grokwallet/session.json` | `0600` | Encrypted access token, refresh token, wallet ids, addresses, caps. Not the signing key. Not the device code |
| `~/.grokwallet/config.json` | `0600` | Optional `appId` and `wcProjectId` overrides |
| `~/.grokwallet/wc/store.json` | `0600` | WalletConnect pairing keys. Not the Ethereum key and not the Privy token. Not encrypted with the passphrase |
| `~/.grokwallet/wc/state.json` | `0600` | Pending proposals, requests, and session metadata |
| `~/.grokwallet/wc/daemon.sock` | `0600` | Local socket. The daemon does not hold the Privy token |

`GROKWALLET_HOME` moves this directory. The passphrase is an environment variable. The CLI never prints it. Errors are redacted for JWTs, pairing URIs, `symKey`, and the passphrase when it is at least 8 characters. Stack traces are printed only when `GROKWALLET_DEBUG` is set, and they are redacted the same way.

## Revoke and log out

1. `node bin/grokwallet.js logout` deletes the local session file.
2. On `https://grokwallet.fun/`, revoke the agent session so the refresh token stops working at Privy.
3. `node bin/grokwallet.js wc clear` disconnects WalletConnect sessions and drops pending proposals and requests. Pairing keys in `wc/store.json` remain until you delete `~/.grokwallet/wc`. Deleting that directory drops relay state. It does not delete the Privy session.
4. Rotate `GROKWALLET_PASSPHRASE` by logging in again after logout. Old ciphertext cannot be decrypted with a new passphrase.

The approval-page headers and Connect-card proof are described in [SECURITY.md](../SECURITY.md) and [docs/HOSTING.md](HOSTING.md).
