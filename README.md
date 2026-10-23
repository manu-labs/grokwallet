# GrokWallet

GrokWallet is a non-custodial CLI for an owner's Ethereum and Solana wallets. A bot can read balances, show receive addresses, send ETH, SOL, or an ERC-20, and sign messages or typed data. The bot never holds the wallet keys and never holds a Privy app secret.

The owner approves the bot once in a browser. Privy keeps the keys. This program stores only encrypted tokens in `~/.grokwallet` and asks Privy to sign. Every send or signature prints a summary and waits for `--yes`, and it stops at the local spend cap.

The public Privy app id shipped with this repo is `cmvh5kyg300qy0gl01ww23ixy`. The public WalletConnect project id is `bdfd32cda68514c6f0300c6f7a80320d`. Neither value is a secret. `GROKWALLET_APP_ID` overrides the app id. `GROKWALLET_WC_PROJECT_ID` overrides `wcProjectId` in `~/.grokwallet/config.json`, and either overrides the built-in WalletConnect project id.

## Five-minute quickstart

The pinned release is `v0.2.6`. If that GitHub release does not exist yet, stop.

```sh
curl -fsSL -o grokwallet-bot.tar.gz https://github.com/manu-labs/grokwallet/releases/download/v0.2.6/grokwallet-bot.tar.gz
curl -fsSL -o SHA256SUMS https://github.com/manu-labs/grokwallet/releases/download/v0.2.6/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf grokwallet-bot.tar.gz
cd grokwallet-bot
node bin/grokwallet.js --version
node bin/grokwallet.js verify
```

The archive already contains production dependencies. Do not run `npm ci`.

```sh
export GROKWALLET_PASSPHRASE="a long secret that stays out of the chat"
node bin/grokwallet.js doctor
node bin/grokwallet.js login
node bin/grokwallet.js addresses
node bin/grokwallet.js cap set --eth 0.01 --sol 0.05
node bin/grokwallet.js send-eth --to 0x... --amount 0.01 --chain ethereum --dry-run
node bin/grokwallet.js send-eth --to 0x... --amount 0.01 --chain ethereum --yes
```

`login` prints a verification URL, a user code, and a connector URL. Approve in the Connect card, or open the page, check the code, and press Approve. `doctor` prints one line for each check and a `fix:` line when something is wrong. `--dry-run` prints the summary and the cap result, and it does not sign or broadcast.

A source checkout is different from a release. From a git tree, install with `cd bot && npm ci` and run `node bin/grokwallet.js`. `verify` reports that a git checkout has no release manifest.

## Verify a release

1. Download `grokwallet-bot.tar.gz`, `grokwallet-app.tar.gz`, `approval-page.MANIFEST`, and `SHA256SUMS` from the same GitHub release.
2. Run `sha256sum -c SHA256SUMS`. Every published asset is listed there.
3. Extract the bot archive and run `node bin/grokwallet.js verify`. That re-hashes the installed files against the manifest inside the archive.
4. The approval page is a separate attested tree. See [docs/VERIFY.md](docs/VERIFY.md).

## Read next

| Doc | What it covers |
| --- | --- |
| [docs/commands.md](docs/commands.md) | Every command, flag, example, and sample output |
| [docs/security.md](docs/security.md) | Threat model, caps, what is stored, how to revoke |
| [docs/walletconnect.md](docs/walletconnect.md) | Pairing, proposals, Verify, requests, disconnect |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Doctor output, RPC, login expiry, checksum failures |
| [docs/HOSTING.md](docs/HOSTING.md) | What the repo owner configures |
| [docs/PRIVY.md](docs/PRIVY.md) | Privy calls this repo makes |
| [CHANGELOG.md](CHANGELOG.md) | v0.2.2 through v0.2.6 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local dev, tests, and the release tag |

The bot template is [`template/grokwallet.json`](template/grokwallet.json). The approval page is `https://grokwallet.fun/`.
