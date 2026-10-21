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

## Connect card

The optional connector is a Cloudflare Pages Function on the same project as the approval page. The CLI prints `https://grokwallet.fun/mcp/c/<user_code>`. The only wallet identifier in that URL is the public user code, which is already shown to the owner.

The function can see:

- the public user code
- the OAuth client's registered redirect URIs
- the PKCE challenge and, at `/oauth/token`, the PKCE verifier
- HMAC-signed authorization codes and access tokens that this function itself issued

The function cannot see, and the pages in `functions/` are written not to receive:

- the Privy device code
- Privy access or refresh tokens
- the HPKE signing key
- the owner's Privy session or user access token
- `GROKWALLET_PASSPHRASE`

`device_verify` still runs in the browser, from the static page to `https://auth.privy.io`. The function does not call Privy. The access token it issues grants `link_status` only. That tool returns a fixed sentence. It does not read a balance or sign.

There is no KV. Authorization codes are therefore not single-use. They expire in 60 seconds, and redeeming one does not reveal a Privy credential. Redirects are allowed only to the Grok Bot callbacks listed in [docs/HOSTING.md](docs/HOSTING.md), and only when that exact URI was registered for the client. A `redirect_uri` that fails the check is not placed in a `Location` header.

The approval page keeps `Content-Security-Policy` with `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The return from the page to `/oauth/complete` is a same-origin path built from a token shape check. The query value is not used as a URL. A browser window can show the page. An iframe of the approval page is still refused.

`GROKWALLET_OAUTH_HMAC_KEY` is a Pages secret. A person who can read it can mint Connect-card tokens. Those tokens still cannot call Privy.

## Scope

In scope: the `grokwallet` CLI, the static approval page, the Pages Functions under `functions/`, the GitHub workflows, and the bot template in this repository.

Out of scope: Privy's hosted API, a public RPC endpoint, the owner's machine, and phishing pages that copy the approval UI. Report Privy platform issues to Privy.
