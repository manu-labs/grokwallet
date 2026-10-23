# Contributing

Issues and pull requests are welcome. Keep changes focused. Do not name a specific dapp or exchange in code, docs, tests, or commit messages. Use "a dapp" or `example.com`.

## Setup

Node `22.23.3` is recorded in `.nvmrc`.

```sh
cd bot && npm ci && npm test && npm run lint
cd .. && node --test mcp/oauth.test.js && node --experimental-strip-types --test app/lib/oauth-return.test.ts
cd app && npm ci && npm run lint && NEXT_TELEMETRY_DISABLED=1 SOURCE_COMMIT=local npm run build
```

`app/.npmrc` sets `legacy-peer-deps=true` because `@privy-io/react-auth` pulls optional Solana peers that disagree on `@solana/kit`.

Do not call Privy with a real app id, app secret, or user token in tests or in CI. Unit tests inject a fake `fetch`. Do not commit `.env` files, Cloudflare API tokens, pinning tokens, or passphrases.

A git checkout has no release manifest. `node bot/bin/grokwallet.js verify` fails until you are running an extracted release. `npm ci` is how a checkout installs dependencies. The published `grokwallet-bot.tar.gz` already contains production `node_modules`, so release installs do not run `npm ci`.

The bot template skills in `template/grokwallet.json` should stay under about 6 KB each.

## Tests

`cd bot && npm test` runs `node --test`. `npm run lint` is `node --check` on `bin`, `src`, `src/wc`, and `test`.

WalletConnect tests use a fake sign client and a Unix socket. They do not open a relay. Doctor tests inject `fetch`. Do not point tests at a live RPC.

The Connect card tests live in `mcp/oauth.test.js` and `app/lib`. CI also builds the approval page twice and diffs `node scripts/hash-tree.mjs app/out`.

## Release

Publish (`.github/workflows/publish.yml`) runs when a tag matching `v*` is pushed, and when someone starts it by hand. Merging a pull request does not publish.

1. Bump the version in `bot/package.json`, the root `version` fields in `bot/package-lock.json`, `functions/_lib/_server.js`, `scripts/install-bot.sh`, the template skills, `README.md`, and `docs/HOSTING.md`.
2. Add a `CHANGELOG.md` section for that version. The release body starts with that section.
3. Merge to `main`.
4. Tag that commit. Do not move `v0.2.2`, `v0.2.3`, `v0.2.4`, or `v0.2.5`.

```sh
git tag -a v0.2.6 <merge-sha> -m "GrokWallet 0.2.6"
git push origin v0.2.6
```

The workflow installs production dependencies, writes `bot/SHA256SUMS` for those files, and packs `dist/grokwallet-bot.tar.gz` with GNU tar `--sort=name`, a source-date mtime, and numeric root ownership. `dist/SHA256SUMS` covers `grokwallet-app.tar.gz`, `grokwallet-bot.tar.gz`, and `approval-page.MANIFEST`. A tag push also opens the GitHub release. `workflow_dispatch` deploys the page and builds the archives, and it does not open the release.

`SOURCE_DATE_EPOCH` is the commit time, exported so the gzip header stays stable. Rebuilds need the same Node and npm as `.nvmrc` on Linux. The dependencies are pure JavaScript.

If you touch Privy calls, update `docs/PRIVY.md` and cite the current doc URL. If you change the static page, build it twice with the same `SOURCE_COMMIT` and diff the manifests.
