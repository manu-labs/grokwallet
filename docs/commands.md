# Commands

Run from an extracted release:

```sh
node bin/grokwallet.js <command>
```

From a git checkout the path is `node bot/bin/grokwallet.js`. Flags below are the same.

`--yes` is required to sign or broadcast. `--dry-run` prints the same summary and runs the same cap checks, then stops. It does not replace `--yes`.

## grokwallet --version

Prints the package version and exits.

```text
0.2.7
```

## grokwallet doctor

Checks Node (`>=22.23.0 <23`), `~/.grokwallet/config.json`, whether a login session decrypts, and RPC reachability for ethereum, base, arbitrum, arbitrum-sepolia, and solana. Exit code 1 when any check fails. It does not print tokens, the passphrase, device codes, or keys.

```text
ok node 22.23.3
ok config: no config file; built-in app id and WalletConnect project id
fail login: not logged in
fix: Run: grokwallet login
ok rpc ethereum: ethereum.publicnode.com
ok rpc base: mainnet.base.org
ok rpc arbitrum: arb1.arbitrum.io
ok rpc arbitrum-sepolia: sepolia-rollup.arbitrum.io
ok rpc solana: api.mainnet-beta.solana.com
```

## grokwallet verify

Re-hashes files in the install directory against `SHA256SUMS` in that directory. A git checkout has no manifest.

```text
verified 1200 file(s)
```

On failure the first line names the changed or missing path. The second line says to download the release again.

## grokwallet login

Starts the Privy device flow. Stdout is the verification URL, the user code, and `connector_url`. The device code stays inside the process.

```sh
export GROKWALLET_PASSPHRASE="the masked secret"
node bin/grokwallet.js login
```

```text
verification_uri_complete: https://grokwallet.fun/?user_code=ABCD-1234
user_code: ABCD-1234
connector_url: https://grokwallet.fun/mcp/c/ABCD-1234
approved
ethereum 0xabc... wallet-id
solana So1... wallet-id
```

## grokwallet status

Prints logged in or logged out, the app id, access expiry, wallet addresses, and caps. It does not print tokens.

## grokwallet addresses

Refreshes wallets from Privy and prints `chainType address id`.

## grokwallet logout

Deletes the local session file. Revoke the grant on the approval page as well. Privy does not learn about this delete.

```text
logged_out
```

## grokwallet balance

```sh
node bin/grokwallet.js balance
node bin/grokwallet.js balance --chain arbitrum
node bin/grokwallet.js balance --chain base --token 0x0000000000000000000000000000000000000000
```

With no `--chain`, native balances are ethereum, base, and solana. Token caps are also read, on every chain when `--chain` is omitted and on that chain when it is set. `--token` reads one ERC-20 and requires an EVM chain (default ethereum).

```text
ethereum 0xabc... 1.5 ETH
base 0xabc... 0.2 ETH
solana So1... 3 SOL
base 0xabc... 10 USDC (USD Coin) token 0x3333...
```

When the contract does not return metadata the line uses `symbol unavailable` and `name unavailable`.

## grokwallet cap

```sh
node bin/grokwallet.js cap show
node bin/grokwallet.js cap set --eth 0.01 --sol 0.05 --token arbitrum:0x3333333333333333333333333333333333333333=100
node bin/grokwallet.js cap clear
node bin/grokwallet.js cap policy
```

```text
eth: 0.01 ETH
sol: 0.05 SOL
token arbitrum:0x3333333333333333333333333333333333333333: 100
```

`cap policy` prints Privy policy JSON for native ETH and SOL only. Creating that policy needs the app secret, which this CLI does not have. ERC-20 caps are local.

## grokwallet send-eth

```sh
node bin/grokwallet.js send-eth --to 0xabc... --amount 0.01 --chain ethereum --dry-run
node bin/grokwallet.js send-eth --to 0xabc... --amount 0.01 --chain ethereum --yes
node bin/grokwallet.js send-eth --to 0xabc... --amount 0 --data 0x1234 --chain arbitrum --yes
```

`--amount 0` is allowed only with `--data`. Calldata whose selector is ERC-20 `transfer` or `transferFrom` is refused; use `send-erc20`. The ETH cap applies to native value. If no ETH cap is set, the send is still allowed after `--yes`.

```text
send 0.01 ETH on ethereum from 0xabc... to 0xdef...
dry-run: nothing was signed or broadcast
```

A real send ends with `submitted ethereum 0x<hash>`.

## grokwallet send-erc20

```sh
node bin/grokwallet.js send-erc20 --chain arbitrum --token 0x3333... --to 0xabc... --amount 10 --dry-run
node bin/grokwallet.js send-erc20 --chain arbitrum --token 0x3333... --to 0xabc... --amount 10 --yes
```

Refuses when that chain and token have no cap. Decimals come from the contract.

```text
send 10 USDC (ERC-20) on arbitrum
token: 0x3333...
decimals: 6
raw amount: 10000000
from: 0xabc...
to: 0xdef...
token cap: 100
native value: 0 ETH
```

## grokwallet send-sol

```sh
node bin/grokwallet.js send-sol --to <address> --amount 0.01 --dry-run
node bin/grokwallet.js send-sol --to <address> --amount 0.01 --yes
```

```text
send 0.01 SOL from <from> to <to>
submitted solana <signature>
```

## grokwallet sign-message

```sh
node bin/grokwallet.js sign-message --chain ethereum --message hello --dry-run
node bin/grokwallet.js sign-message --chain ethereum --message-file path --yes
node bin/grokwallet.js sign-message --chain solana --message-file - --yes
```

`--message` and `--message-file` together are refused. `--message-file -` and `--message -` keep stdin bytes, including line breaks. The limit is 2000 characters.

```text
sign ethereum message from 0xabc...
---
hello
---
signature 0x...
```

## grokwallet sign-typed-data

```sh
node bin/grokwallet.js sign-typed-data --chain ethereum --data @file.json --dry-run
node bin/grokwallet.js sign-typed-data --chain ethereum --data @file.json --yes
```

`--chain` must be `ethereum`. The domain chain id is taken from the typed data and is not compared to a configured chain. The summary prints `domain.chainId`, `verifyingContract`, `primaryType`, and the message.

## grokwallet wc

```sh
node bin/grokwallet.js wc pair 'wc:...'
node bin/grokwallet.js wc pair --from-file uri.txt
node bin/grokwallet.js wc pair --from-file -
node bin/grokwallet.js wc pair --paste
node bin/grokwallet.js wc proposals
node bin/grokwallet.js wc approve-proposal 1 --yes
node bin/grokwallet.js wc reject-proposal 1
node bin/grokwallet.js wc requests
node bin/grokwallet.js wc approve 2 --dry-run
node bin/grokwallet.js wc approve 2 --yes
node bin/grokwallet.js wc reject 2
node bin/grokwallet.js wc sessions
node bin/grokwallet.js wc disconnect <topic>
node bin/grokwallet.js wc clear
```

`--timeout` on `wc pair` is a whole number of seconds from 1 to 120. The default is 30.

`wc pair` prints the proposal. The first lines are the origin and `verify: VALID`, `verify: UNKNOWN`, or `verify: MISMATCH`. A mismatch also prints `WARNING: verified origin does not match the dapp's claimed URL.`

`wc requests` adds `summary:` with a decoded preview, then the payload. `wc approve --dry-run` stops before Privy and before the relay response, and the request stays pending.

`wc clear` prints:

```text
cleared 1 session(s), 0 proposal(s), 2 request(s)
```

See [docs/walletconnect.md](walletconnect.md).
