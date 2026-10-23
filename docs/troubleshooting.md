# Troubleshooting

Errors are two lines. The first says what failed. The second says what to do. Set `GROKWALLET_DEBUG=1` to add a redacted stack trace. Do not paste that trace if it might still contain a local path you consider private. The CLI strips JWTs, pairing URIs, `symKey`, and `GROKWALLET_PASSPHRASE` when that value is at least 8 characters.

## doctor

Run `node bin/grokwallet.js doctor`. Each failure is a `fail` line plus a `fix:` line.

| fail line | What to do |
| --- | --- |
| `node: ... is outside >=22.23.0 <23` | Install Node 22.23.x. See `.nvmrc` |
| `config: file is not JSON` | Fix or delete `~/.grokwallet/config.json`. Built-in public ids are used when it is absent |
| `config: wcProjectId is not 32 hex characters` | Remove `wcProjectId` or set a 32-hex override |
| `login: not logged in` | `grokwallet login` |
| `login: GROKWALLET_PASSPHRASE is not set` | Export the passphrase. Do not paste it into chat |
| `login: session could not be decrypted` | Use the passphrase from login, or log in again |
| `rpc <chain>: <host> did not answer` | Check the network, or set the chain's `GROKWALLET_*_RPC` variable |

`doctor` prints the RPC hostname, not the full URL, so a key in the query string is not shown.

## RPC

Default endpoints are the public URLs in the README and in `bot/src/balances.js`. Overrides:

- `GROKWALLET_ETHEREUM_RPC`
- `GROKWALLET_BASE_RPC`
- `GROKWALLET_ARBITRUM_RPC`
- `GROKWALLET_ARBITRUM_SEPOLIA_RPC`
- `GROKWALLET_SOLANA_RPC`

A balance or send that says `request failed` or `returned HTTP` is the same class of problem. `doctor` checks `eth_chainId` on EVM chains and `getSlot` on Solana.

## Login expiry

`status` prints `access_expires_at`. The CLI refreshes the access token when it is close to expiry. If refresh fails, log in again. Logout deletes only the local file. Also revoke the session at `https://grokwallet.fun/` so Privy stops honoring the refresh token.

`waiting for approval` ends when the device code expires. Run `login` again. Do not reuse an old user code.

## Checksums

`sha256sum -c SHA256SUMS` must print `grokwallet-bot.tar.gz: OK` before you extract. If it fails, download both files again from the same release. Do not mix a tarball from one tag with `SHA256SUMS` from another.

After extract, `node bin/grokwallet.js verify` checks the files on disk. `verify failed: changed ...` or `missing ...` means the tree was edited or the extract was partial. Delete the directory and extract again. Do not run `npm ci` inside a release; that replaces the vendored `node_modules` and `verify` will fail on purpose.

A git checkout prints `this install has no SHA256SUMS manifest`. That is expected. Use `npm ci` there, and use `verify` on release extracts.

## WalletConnect

`WalletConnect URI is not a v2 pairing URI`: the file or paste was not one `wc:` URI. The error does not repeat the value.

`paste page timed out`: run `wc pair --paste` again or use `--from-file`.

`pairing timed out before a session proposal arrived`: the dapp did not propose a session. Pair again from the dapp.

`the request changed after the summary`: do not approve. List requests again and approve the new id only if the new summary is the one you want.

`that request id is not unique`: pass `topic:id`.

`no pending request with that id` after a wait: it expired or `wc clear` removed it. List requests again.

`walletconnect daemon did not start`: read `~/.grokwallet/wc/daemon.log`. It is mode `0600` and should not contain the project id, the pairing URI, or the passphrase. A project id in a thrown error is replaced with `[project-id]`.
