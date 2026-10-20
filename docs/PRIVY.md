# Privy API contract

Checked against Privy's docs and the public OpenAPI document `https://api.privy.io/v1/openapi.json` on 20 October 2026. No call in development used a real app id, app secret, or user token.

This repo does not use [`@privy-io/agent-wallet-cli`](https://docs.privy.io/recipes/agent-integrations/agent-cli). That CLI logs into Privy's agent sandbox at `https://agents.privy.io` and stores a session for Privy's own app. GrokWallet has to run against the publisher's Privy app, with a publisher-hosted approval page and no app secret on the bot. The device flow below is the one Privy documents for that case: https://docs.privy.io/recipes/agent-integrations/agent-authorization

## Calls the CLI makes

All of these go to `https://auth.privy.io` unless `GROKWALLET_AUTH_BASE` is set. Each request sends `privy-app-id`.

| Step | Request | Source |
| --- | --- | --- |
| Start login | `POST /api/oauth/v2/device_authorization` with body `{}` | Agent authorization recipe. Response shape matches OpenAPI schema `DeviceAuthorizationResponse` |
| Poll | `POST /api/oauth/v2/token` | Recipe and OpenAPI `OAuthTokenDeviceCodeRequestBody` |
| Refresh | `POST /api/oauth/v2/token` with `grant_type: "refresh_token"` | Recipe and OpenAPI |
| Signing key | `POST /api/oauth/v2/wallets/authenticate` with `Authorization: Bearer`, `privy-grant-type: device_code`, and an HPKE public key | Agent authorization recipe only. Not in the OpenAPI path list |
| Wallet RPC | `POST /api/oauth/v2/wallets/{wallet_id}/rpc` with the bearer token, `privy-grant-type: device_code`, and `privy-authorization-signature` | Agent authorization recipe |

The recipe's poll example uses `grant_type: "device_code"`. The OpenAPI discriminator and `@privy-io/node` 0.34.0 use the RFC 8628 value `urn:ietf:params:oauth:grant-type:device_code`. The CLI sends the URN. Pending errors follow the recipe and the OpenAPI enum: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`. On `slow_down` the CLI adds 5 seconds to the interval.

`POST /v1/wallets/{wallet_id}/rpc` on `https://api.privy.io` is the standard wallet RPC. OpenAPI marks it `appSecretAuth` (HTTP Basic with the app id and app secret) plus `privy-authorization-signature`. The agent-authorization recipe instead tells a secret-less agent to call the `/api/oauth/v2/wallets/{id}/rpc` path. The CLI uses that path. The signature payload's `url` is the URL that is actually called.

## Signing

Signature payload, from https://docs.privy.io/controls/authorization-keys/using-owners/sign/direct-implementation and from `formatRequestForAuthorizationSignature` in `@privy-io/node` 0.34.0:

- `version`: `1`
- `method`, full `url` with no trailing slash, `body`
- `headers`: `privy-app-id`, plus `privy-idempotency-key` and `privy-request-expiry` only when those headers are sent
- An empty object body is signed as `""`
- Canonicalize with RFC 8785 (`canonicalize@2.1.0`), then ECDSA P-256 SHA-256, base64 DER

The recipe also sends `privy-grant-type: device_code`. The Node SDK's signed header set does not include that name. The CLI sends the header and does not put it in the signature payload, matching the SDK. This is an assumption. If Privy requires the header inside the signature, wallet RPC will fail until the payload includes it.

The signing key is HPKE, mode BASE, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, as documented on https://docs.privy.io/api-reference/wallets/authenticate and implemented in the Node SDK. The CLI generates the recipient key with `@hpke/core` 1.7.5 and `@hpke/chacha20poly1305` 1.7.1, exports SPKI base64 for `recipient_public_key`, and keeps the decrypted key in memory only. `expires_at` in the recipe example is an ISO timestamp. OpenAPI types it as epoch milliseconds. The CLI accepts both.

The decrypted key is a PKCS#8 string. `wallet-auth:` and `wallet-api:` prefixes are stripped before signing, which is what the Node SDK does.

## RPC bodies

Taken from OpenAPI, which marks `additionalProperties: false`. The recipe's examples omit some of these fields.

- `eth_sendTransaction` requires `caip2` and `params.transaction`. Value is a hex quantity because wei can exceed a JSON number. `chain_id` is `1` or `8453` (Base). https://docs.privy.io/api-reference/wallets/ethereum/eth-send-transaction
- `personal_sign` requires `params.message` and `params.encoding` (`utf-8`). https://docs.privy.io/recipes/agent-integrations/agent-authorization
- `signAndSendTransaction` requires `caip2` (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) and a base64 legacy transaction. https://docs.privy.io/api-reference/wallets/solana/sign-and-send-transaction
- `signMessage` on Solana requires `params.message` as base64 and `params.encoding: "base64"`.

Balances are not read from Privy. `GET /v1/wallets/{id}/balance` requires the app secret. The CLI calls public RPCs: `eth_getBalance`, and Solana `getBalance`. Defaults are `https://ethereum.publicnode.com`, `https://mainnet.base.org`, and `https://api.mainnet-beta.solana.com`.

## Approval page

`POST /api/oauth/v2/device_verify` with `user_code` and `action` of `approve` or `deny`, plus the user's bearer token. Listed in both the recipe and the OpenAPI. The page also calls `GET` and `DELETE /api/oauth/v2/grants` so the owner can revoke a session. Those two are in the recipe. The OpenAPI describes the grant objects (`created_at` as a date-time string) but does not list the paths. The recipe shows `created_at` as a unix number. The page displays the id and grant type and does not depend on the timestamp format.

Wallet creation uses the React SDK, not the secret-requiring `POST /v1/wallets`:

https://docs.privy.io/basics/react/advanced/automatic-wallet-creation

`useCreateWallet` from `@privy-io/react-auth` and from `@privy-io/react-auth/solana` runs on Approve if a chain is still missing. The Solana entry imports `@solana/kit` and `@solana-program/memo`, so those are direct dependencies of `app/`. The page does not set `loginMethods`, so the dashboard chooses email, social, or wallet login. It does not mount Telegram login or the funding kit.

The production checklist's CSP and X-Frame items are delivered as Cloudflare Pages headers. The base directive list is https://docs.privy.io/security/implementation-guide/content-security-policy and the checklist text is https://docs.privy.io/security/implementation-guide/security-checklist. Sources added on top of that base policy, and why, are listed in [HOSTING.md](HOSTING.md).

## Policies

`POST https://api.privy.io/v1/policies` requires Basic auth with the app secret. https://docs.privy.io/api-reference/policies/create

The user-owned device flow, as documented, does not give the bot a way to create or attach a policy. `grokwallet cap` enforces a local ceiling and `grokwallet cap policy` prints policy JSON for the app owner. Evaluation rules, including default deny: https://docs.privy.io/controls/policies/overview

## What was not verified live

- That `auth.privy.io` and `api.privy.io` both serve `/api/oauth/v2/token` and `/api/oauth/v2/device_verify`. The recipe names `auth.privy.io`. The OpenAPI server is `api.privy.io`. The CLI defaults to the recipe's host.
- That `POST /api/oauth/v2/device_authorization` and `POST /api/oauth/v2/wallets/authenticate` and `POST /api/oauth/v2/wallets/{id}/rpc` are deployed as the recipe describes. They are not paths in the OpenAPI document fetched from `https://api.privy.io/v1/openapi.json`.
- That omitting `privy-grant-type` from the signature payload is what the server checks.
- HPKE against a real Privy response. The unit test seals and opens with the same library.
- Pinata, Cloudflare Pages, the GitHub attestation, and a real device approval. Those need the owner's accounts. The publish workflow is written to upload the attested `dist/site` tree and to skip the pin when `IPFS_PINNING_TOKEN` is unset. That path was not executed against Cloudflare or Pinata.
