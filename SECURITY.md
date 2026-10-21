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
- HMAC-signed authorization codes, access tokens, and refresh tokens that this function itself issued

The function cannot see, and the pages in `functions/` are written not to receive:

- the Privy device code
- Privy access or refresh tokens
- the HPKE signing key
- the owner's Privy session or user access token
- `GROKWALLET_PASSPHRASE`

`device_verify` still runs in the browser, from the static page to `https://auth.privy.io`. The request sends `Authorization: Bearer` from the Privy user token in that window and does not rely on cookies. The function does not call Privy and never sees that token. The page treats a redirect, an HTML body, or a JSON `error` as failure, shows the status, and does not continue. After a direct success it POSTs `/oauth/proof`. `/oauth/complete` redirects to the client only when that proof matches the same user code and the same authorization request. A completion request without the proof is HTTP 400 with body `access_denied` and no `Location`. Deny, after Privy accepts the denial, redirects the client with `error=access_denied` and no code. The access token it issues grants `link_status` only. That tool returns a fixed sentence. It does not read a balance or sign.

There is no KV. Authorization codes are therefore not single-use. They expire in 60 seconds, and redeeming one does not reveal a Privy credential. The access token grants `link_status` only and lasts 30 days. A refresh token lasts 90 days, is bound to the client id and the connector URL, and can only mint another `link_status` access token. Neither token is single-use, because nothing is stored. Dynamic client registration accepts any `https` redirect URI, and `http` only when the host is `localhost` or `127.0.0.1` (any port, any path). Other schemes and `http` to any other host are rejected. The accepted list is stored inside the HMAC-signed `client_id`. `/oauth/authorize` redirects only when `redirect_uri` is an exact member of that list. Any other `redirect_uri` is HTTP 400 and is not placed in a `Location` header.

Registration keeps `authorization_code` and, when the client asks for it, `refresh_token`. Other grant names are ignored. `response_types` must include `code`. `token_endpoint_auth_method` may be `none`, `client_secret_post`, or `client_secret_basic`. A secret method gets a `client_secret` derived from the HMAC key and the client id, and `/oauth/token` requires that secret. `none` gets no secret. Unknown metadata fields are ignored. The granted values are what the registration response returns.

`/oauth/authorize` also stores that redirect URI and the connector URL in the HMAC-signed authorization code. On `/oauth/token`, `resource` may be omitted. The connector URL saved at `/oauth/authorize` is used. If the client sends `resource`, it must be that same connector URL. The same rule applies to `grant_type=refresh_token`.

The approval page keeps `Content-Security-Policy` with `frame-ancestors 'none'` and `X-Frame-Options: DENY`, so the Connect card opens it as a top-level window. `connect-src`, `frame-src`, and `child-src` already allow `https://auth.privy.io`, which is where `device_verify` and the Privy embedded-wallet iframe run. The return from the page to `/oauth/complete` is a same-origin path built from a token shape check. The query value is not used as a URL. The page does not read `window.opener`. A browser window can show the page. An iframe of the approval page is still refused.

`GROKWALLET_OAUTH_HMAC_KEY` is a Pages secret. A person who can read it can mint Connect-card tokens. Those tokens still cannot call Privy.

## CLI spend limits

`send-eth` checks the native ETH value against the local ETH cap, including when `--data` is set. `send-erc20` reads `decimals()` from the token and refuses to broadcast unless `cap set --token chain:0xaddress=amount` was set for that chain and contract, and the amount is within it. ERC-20 `transfer` and `transferFrom` selectors in `send-eth --data` are refused so they cannot skip that cap. Other calldata is not amount-capped; the summary shows the selector and the data, and `--yes` is still required.

`sign-message` and `sign-typed-data` do not transfer a balance. They print the exact message or the typed-data domain, primary type, and message, and they refuse to sign without `--yes`. A typed-data signature can approve another signer. Hyperliquid `approveAgent` is one case: its domain `chainId` is `0x66eee`, which is not Ethereum. The ETH cap does not interpret that signature.

## Scope

In scope: the `grokwallet` CLI, the static approval page, the Pages Functions under `functions/`, the GitHub workflows, and the bot template in this repository.

Out of scope: Privy's hosted API, a public RPC endpoint, the owner's machine, and phishing pages that copy the approval UI. Report Privy platform issues to Privy.
