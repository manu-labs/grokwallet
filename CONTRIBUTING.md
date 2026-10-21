# Contributing

Issues and pull requests are welcome. Please keep changes focused.

## Setup

Node `22.23.3` is recorded in `.nvmrc`.

```sh
cd bot && npm ci && npm test && npm run lint
cd .. && node --test mcp/oauth.test.js && node --experimental-strip-types --test app/lib/oauth-return.test.ts
cd app && npm ci && npm run lint && NEXT_TELEMETRY_DISABLED=1 SOURCE_COMMIT=local npm run build
```

`app/.npmrc` sets `legacy-peer-deps=true` because `@privy-io/react-auth` pulls optional Solana peers that disagree on `@solana/kit`.

Do not call Privy with a real app id, app secret, or user token in tests or in CI. Unit tests inject a fake `fetch`. Do not commit `.env` files, Cloudflare API tokens, pinning tokens, or passphrases.

## Pull requests

Describe what changed and how you checked it. If you touch the Privy calls, update `docs/PRIVY.md` and cite the current doc URL. If you change the static page, build it twice with the same `SOURCE_COMMIT` and diff `node scripts/hash-tree.mjs app/out`.

The bot template skills in `template/grokwallet.json` should stay under about 6 KB each.
