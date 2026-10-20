# Security

GrokWallet is a non-custodial agent wallet. A bug in the CLI, the approval page, or the bot template can move funds or sign a message the owner did not intend.

## Report a vulnerability

Use a private [GitHub Security Advisory](https://github.com/manu-labs/grokwallet/security/advisories/new) for this repository. Please include the commit you tested, the command or page, and the impact. Do not open a public issue for a vulnerability, and do not include tokens, passphrases, or live transaction hashes that identify a victim.

There is no bug bounty in this repository.

## What to expect

The maintainers will acknowledge a report that they can reproduce, and they will coordinate a fix before details are published. If you do not get a reply, open the advisory again with a short follow-up. Do not send the Privy app secret, a user access token, or a refresh token in the report. Those are not needed to describe a bug in this codebase.

## Approval page headers

The static export ships a Cloudflare Pages `_headers` file. On `https://grokwallet.fun/` that file sets a Content Security Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a Permissions-Policy, and HSTS (`max-age=31536000; includeSubDomains`). The CSP includes `frame-ancestors 'none'`. The allowed hosts are Privy's base policy for `@privy-io/react-auth`, plus the Solana, WalletConnect, and hCaptcha hosts this page's SDK calls. The exact list and the doc URLs are in [docs/HOSTING.md](docs/HOSTING.md).

`script-src` allows same-origin scripts, Cloudflare Turnstile, hCaptcha, and the sha256 of each Next.js inline bootstrap script from that build. It does not allow `'unsafe-inline'` or `'unsafe-eval'`. A change to the inline HTML changes those hashes, which is why `_headers` is generated during `npm run build` and included in the attested manifest.

These headers are enforced by Cloudflare Pages. The IPFS copy stores the same `_headers` bytes so they can be compared; a public gateway does not apply them. Report a missing header or an overly broad `script-src` through the advisory link above.

## Scope

In scope: the `grokwallet` CLI, the static approval page, the GitHub workflows, and the bot template in this repository.

Out of scope: Privy's hosted API, a public RPC endpoint, the owner's machine, and phishing pages that copy the approval UI. Report Privy platform issues to Privy.
