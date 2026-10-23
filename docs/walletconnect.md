# WalletConnect

A dapp that can pair with a wallet over WalletConnect v2 can use this CLI as the wallet. The published build includes the public project id `bdfd32cda68514c6f0300c6f7a80320d`. Leave overrides unset to use it. `GROKWALLET_WC_PROJECT_ID` overrides `wcProjectId` in `~/.grokwallet/config.json`, and either overrides the built-in id. A replacement is 32 hex characters from [dashboard.reown.com](https://dashboard.reown.com).

The relay process does not hold the Privy token or the signing key. Approving a request signs through the same path as `sign-message`, `sign-typed-data`, or `send-eth`, and only after `--yes`.

## Pair

```sh
node bin/grokwallet.js wc pair 'wc:...'
node bin/grokwallet.js wc pair --from-file uri.txt
node bin/grokwallet.js wc pair --from-file -
node bin/grokwallet.js wc pair --paste
```

The URI must be `wc:<64 hex>@2?...&symKey=<64 hex>`. If `relay-protocol` is present it must be `irn`. Anything else is refused, and the error does not echo the URI or the symmetric key. `--from-file` accepts one URI, plus blank lines and `#` comments. `--paste` binds `127.0.0.1` on a random port, prints `paste_url:`, and accepts one valid URI before it closes. A rejected paste can be tried again until the page times out. The page uses the same black background and green accent as the approval page. It refuses connections that are not from loopback.

`wc pair` starts a background process if one is not already listening on `~/.grokwallet/wc/daemon.sock`. Pairing keys are stored mode `0600` under `~/.grokwallet/wc`.

## Review a proposal

```sh
node bin/grokwallet.js wc proposals
node bin/grokwallet.js wc approve-proposal 1 --yes
node bin/grokwallet.js wc reject-proposal 1
```

The first lines are the origin and the Verify result:

```text
origin: example.com
verify: VALID
```

`verify: UNKNOWN` means WalletConnect Verify did not attest the origin. The claimed name and URL are labeled untrusted. `verify: MISMATCH` means Verify's origin and the claimed URL do not agree, or Verify marked the origin invalid. That case also prints:

```text
WARNING: verified origin does not match the dapp's claimed URL.
```

Then the output lists required and optional chains, methods, and events, and what this CLI would actually grant. Required namespaces outside the supported EVM chains and methods cannot be approved. Optional unsupported chains and methods are dropped. Granted accounts are `eip155:<chainId>:<wallet address>`.

Approve the proposal id that was printed. If the proposal changes after the summary, nothing is approved.

## Review a request

```sh
node bin/grokwallet.js wc requests
node bin/grokwallet.js wc approve 2 --dry-run
node bin/grokwallet.js wc approve 2 --yes
node bin/grokwallet.js wc reject 2
```

Each pending request leads with origin and Verify, then the chain, the method, and `summary:` (a decoded preview of the message, typed data, or send). The raw payload follows. `MISMATCH` repeats the warning line.

`personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, and a one-call `wallet_sendCalls` use the same caps as the matching commands. Read methods such as `eth_accounts` still wait for `--yes`. `--dry-run` does not respond on the relay, so the request stays pending.

A request that is not answered before its expiry is dropped. The default local lifetime is 5 minutes when the event has no expiry. `wc requests` prints `expired N stale request(s)` when that happens.

If the same numeric id exists on two sessions, pass `topic:id`.

## Disconnect

```sh
node bin/grokwallet.js wc sessions
node bin/grokwallet.js wc disconnect <topic>
node bin/grokwallet.js wc clear
```

`wc clear` disconnects every session and deletes pending proposals, requests, and the short rejection log. It does not delete `wc/store.json`. Submitted call ids used by `wallet_getCallsStatus` are kept.
