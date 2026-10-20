# Hosting

This is the list for the person who owns the GitHub repo, the Privy app, and the Cloudflare account. End users do not do these steps. The public Privy app id for this distribution is `cmvh5kyg300qy0gl01ww23ixy`. It is in the bot template and it is the CLI default. `.env.example` stays a generic placeholder.

The approval page is a static export. The publish workflow builds it once, attests that output, uploads those exact files to Cloudflare Pages, and pins the same files to IPFS when a pinning token is configured. Cloudflare Pages is the host owners open. IPFS is the content-addressed copy used to check that host.

The page calls Privy from the browser with the owner's user access token (`POST https://auth.privy.io/api/oauth/v2/device_verify`). The agent-authorization recipe shows that call with `privy-app-id` and `Authorization: Bearer <user access token>` only. No server-side secret is required, so the site stays a static export.

https://docs.privy.io/recipes/agent-integrations/agent-authorization

## 1. Create the Privy app

1. Create an app in the [Privy dashboard](https://dashboard.privy.io).
2. Open **Authentication → Advanced** and turn on **Enable for CLI and agent access**.
   Source: https://docs.privy.io/recipes/agent-integrations/agent-authorization
3. Enable the login methods you want owners to use (email, social, or a wallet). The page calls `login()` from `@privy-io/react-auth`.
4. Leave embedded wallet creation available for Ethereum and Solana. The page sets `createOnLogin: "users-without-wallets"` for both chains.
   Source: https://docs.privy.io/basics/react/advanced/automatic-wallet-creation
5. Set the verification URI after the Pages custom domain is active. That step is [below](#5-point-privy-at-the-custom-domain). Privy returns this URI to the CLI as `verification_uri`. The page reads `user_code` from the query string.

The React SDK rejects an app id that is not exactly 25 characters. Copy the id from the dashboard and check the length before saving it.

## 2. Public values and secrets

| Value | Where it lives | Secret? |
| --- | --- | --- |
| Privy app id | `cmvh5kyg300qy0gl01ww23ixy` in `template/grokwallet.json` and the CLI default. The Pages build reads the GitHub Actions variable `PRIVY_APP_ID`, which must be this same value | No. It is in the browser bundle |
| Privy app client id, if the dashboard shows one | GitHub Actions variable `PRIVY_CLIENT_ID` | No |
| Pages project name, if it is not `grokwallet` | GitHub Actions variable `CLOUDFLARE_PAGES_PROJECT` | No |
| Privy app secret | Privy dashboard only | Yes. Do not put it on the bot, in the approval page, in GitHub Actions, or in git. This design does not use it |
| `GROKWALLET_PASSPHRASE` | Masked secret on the bot owner's account | Yes. Each owner chooses their own |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Yes. Never commit it |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Yes. Never commit it. It identifies the account; treat it as a secret anyway |
| `IPFS_PINNING_TOKEN` | GitHub Actions secret. A Pinata JWT that can call `pinFileToIPFS`. Leave it unset to skip IPFS | Yes. Never commit it |

## 3. GitHub Actions

Repository variable:

- `PRIVY_APP_ID` — `cmvh5kyg300qy0gl01ww23ixy`

Optional repository variables:

- `PRIVY_CLIENT_ID` — public client id, or leave empty
- `CLOUDFLARE_PAGES_PROJECT` — Pages project name. Leave it empty. The workflow default is `grokwallet`, and that project's alias is `https://grokwallet.pages.dev`

Repository secrets:

- `CLOUDFLARE_API_TOKEN` — API token with **Account → Cloudflare Pages → Edit**
- `CLOUDFLARE_ACCOUNT_ID` — the account id from the Cloudflare dashboard (Workers & Pages, right-hand side)
- `IPFS_PINNING_TOKEN` — optional Pinata JWT. Create it in the Pinata dashboard with permission to pin files. Store it only as an Actions secret. If this secret is absent, the publish job still deploys to Pages and records `IPFS: skipped`

CI (`.github/workflows/ci.yml`) runs on pull requests and on `main`. It does not need the app id, Cloudflare credentials, or the pinning token. It lints, tests, and builds the static page twice to compare file hashes.

Publish (`.github/workflows/publish.yml`) runs when you push a tag `v*` and when you start it by hand. It builds the page once with `PRIVY_APP_ID`, packs `app/out` into `grokwallet-app.tar.gz`, attests that archive (and the CLI archive, the manifest, and `SHA256SUMS`) with `actions/attest-build-provenance`, extracts the attested archive, and uploads that directory with `cloudflare/wrangler-action` (`pages deploy`, Wrangler `4.151.3`). When `IPFS_PINNING_TOKEN` is set, it pins that same directory and writes the CID to the job summary. A tag also opens a GitHub release. The job stops before the build if either Cloudflare secret is missing.

The bot template tells the agent to install tag `v0.1.0`. The first publish should be that tag, from the commit whose template you are distributing:

```sh
git tag v0.1.0
git push origin v0.1.0
```

If you need a different tag, change the tag in `template/grokwallet.json` in the same commit, then tag that commit.

## 4. Cloudflare Pages

Create the project before the first publish. The workflow uses direct upload. It does not connect the GitHub repo to Pages' built-in builds, so Pages does not compile the site a second time.

1. In the Cloudflare dashboard, open **Workers & Pages → Create → Pages → Upload assets** (direct upload). Name the project `grokwallet`. That matches the workflow default (`--project-name=grokwallet` when `CLOUDFLARE_PAGES_PROJECT` is empty), so the alias is `https://grokwallet.pages.dev`. Set the production branch to `main`. The workflow deploys with `--branch=main`. A deployment on that branch is the production deployment.
2. You can create the empty project from a machine that already has Wrangler, with the same account:

   ```sh
   npx wrangler@4.151.3 pages project create grokwallet --production-branch=main
   ```

   The first `pages deploy` from GitHub Actions also creates a project of that name if your token is allowed to. Creating it in the dashboard first makes the name and the production branch explicit.
3. Create an API token: **My Profile → API Tokens → Create Token → Custom token**. Permission: **Account → Cloudflare Pages → Edit**. Account resources: the account that owns the project. Copy the token into the `CLOUDFLARE_API_TOKEN` Actions secret. Copy the account id into `CLOUDFLARE_ACCOUNT_ID`.
4. Push the tag (or run the Publish workflow by hand). The job summary includes the deployment URL and the `*.pages.dev` alias (`pages-deployment-alias-url`).
5. Open the alias over HTTPS and confirm the approval page loads. The Privy SDK refuses embedded wallets on plain HTTP, except localhost. Direct upload serves the attested files as static assets, including the query string on `user_code`.

### Custom domain

The approval page is the apex `grokwallet.fun`, served by this Pages project. The Privy verification URI is `https://grokwallet.fun/`.

An apex custom domain has to be a zone on Cloudflare DNS, on the same account as the Pages project. Point the registrar nameservers at Cloudflare. Pages then creates a CNAME at the zone apex (`grokwallet.fun` → `<project>.pages.dev`). A DNS host outside Cloudflare cannot place a CNAME on the apex, so this name stays unattached while the zone lives elsewhere.

https://developers.cloudflare.com/pages/configuration/custom-domains/

1. Add `grokwallet.fun` to this Cloudflare account and set the registrar nameservers to the ones Cloudflare shows for that zone.
2. Open the Pages project → **Custom domains** → **Set up a domain**.
3. Enter `grokwallet.fun` and confirm the DNS record Cloudflare offers.
4. Wait until the custom domain shows **Active** and the certificate is issued. Open `https://grokwallet.fun/` and confirm the page loads.
5. The getting-started skill already names `https://grokwallet.fun/`. The CLI prints the verification URI Privy returns. Once the dashboard uses that origin, the printed URL is the one to show the owner.

Optional `www` redirect: send `www.grokwallet.fun` to the apex so a `www` visit still reaches the verification URI, and keep `user_code` on the query string. In **Bulk Redirects**, add a list row with source `www.grokwallet.fun`, target `https://grokwallet.fun`, status `301`, and the parameters **Preserve query string**, **Subpath matching**, **Preserve path suffix**, and **Include subdomains**. Attach that list to a bulk redirect rule. In DNS, add a proxied `A` record named `www` to `192.0.2.1` (Cloudflare's documented placeholder address for a proxied redirect; traffic is answered by Cloudflare, not by that address). Check with `curl --head -i https://www.grokwallet.fun/?user_code=ABCD-EFGH` and confirm a 301 to `https://grokwallet.fun/?user_code=ABCD-EFGH`.

https://developers.cloudflare.com/pages/how-to/www-redirect/

The Privy verification URI stays `https://grokwallet.fun/`. Leave `www` off that setting.

The workflow does not create the DNS record. Adding the domain is a dashboard step so the certificate and the zone stay under the account owner's control.

### Security headers

`npm run build` writes `app/out/_headers` after the Next.js export. Cloudflare Pages reads that file from the upload and attaches the headers to every path. The file is part of the attested archive and the manifest. Pages does not need to serve `/_headers` as a page. The IPFS copy still contains the file so its bytes can be compared.

The policy is the base Content Security Policy from Privy's CSP guide, plus `X-Frame-Options: DENY`. `frame-ancestors 'none'` is in the CSP. Together they are the two production-checklist items (CSP for the embedded-wallet iframe, and X-Frame options). Privy's dashboard links the second item to an integration security guide. The current docs for that checklist are:

- https://docs.privy.io/security/implementation-guide/content-security-policy
- https://docs.privy.io/security/implementation-guide/security-checklist

The base policy allows `https://auth.privy.io`, `https://*.rpc.privy.systems`, `https://explorer-api.walletconnect.com`, `https://verify.walletconnect.com`, `https://verify.walletconnect.org`, `https://challenges.cloudflare.com`, the WalletConnect relays, and `wss://www.walletlink.org`. This page also allows the following, because the installed SDK calls them and the page does not override them:

| Source | Why it is in the policy |
| --- | --- |
| `wss://*.rpc.privy.systems` | `@privy-io/react-auth` 3.50.0 opens Solana RPC websockets. The guide lists the `https` wildcard only |
| `https://api.mainnet-beta.solana.com`, `https://api.devnet.solana.com`, `https://api.testnet.solana.com` | The CSP guide says to add these when the app is on Solana and no RPC override is set. `useCreateWallet` for Solana does not set one |
| `https://www.walletlink.org` | The SDK references the `https` origin. The guide lists the `wss` origin |
| `https://echo.walletconnect.com` | `@walletconnect/core`, pulled in by the React SDK, posts WalletConnect events there. Wallet login is one of the methods this page can show |
| `https://hcaptcha.com` and `https://*.hcaptcha.com` | The SDK ships `HCaptchaWrapper`. The guide lists these when the captcha provider is hCaptcha. Turnstile (`https://challenges.cloudflare.com`) stays in the policy because it is in the base configuration |

`script-src` does not use `'unsafe-inline'` or `'unsafe-eval'`. It lists a sha256 for each Next.js inline bootstrap script in that export. `style-src` keeps `'unsafe-inline'` because the guide requires it and styled-components injects styles at runtime. `https://grokwallet.fun` is listed next to `'self'`. Telegram login and the funding kit are not mounted, so their hosts are not listed.

The same file sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a Permissions-Policy that turns off camera, microphone, geolocation, and payment, and `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Passkeys stay available because `publickey-credentials-get` is left unset. `includeSubDomains` covers `www.grokwallet.fun` once that name is on HTTPS.

After the first deploy, confirm the headers and then tick the two dashboard checkboxes:

```sh
curl -sI https://grokwallet.fun/ | grep -iE 'content-security-policy|x-frame-options|strict-transport-security|x-content-type-options|referrer-policy|permissions-policy'
```

Also add `https://grokwallet.fun` under **Configuration → App settings** allowed domains before production login. The security checklist says an origin that is not on that list is rejected.

https://docs.privy.io/security/implementation-guide/security-checklist

## 5. Point Privy at the custom domain

In the Privy dashboard, under **Authentication → Advanced**, set the verification URI to the Pages origin with a trailing slash:

`https://grokwallet.fun/`

Privy returns that value to the CLI as `verification_uri`. The CLI appends the user code and prints `verification_uri_complete`. Owners must land on this Pages host, because that is the origin whose files match the attested build.

Use the `*.pages.dev` alias only as a temporary URI while the certificate for `grokwallet.fun` is still issuing. The template already names `https://grokwallet.fun/` as the approval page. A public IPFS gateway is a poor verification URI: some gateways drop `?user_code=`, which the page needs.

## 6. IPFS, optional

The pin runs only when the `IPFS_PINNING_TOKEN` secret is set. The same `dist/site` directory that was uploaded to Pages is sent to Pinata (`POST https://api.pinata.cloud/pinning/pinFileToIPFS`, `cidVersion` 1). The job summary and the GitHub release include the CID (`IpfsHash`) and `https://gateway.pinata.cloud/ipfs/<CID>/`.

When the secret is absent, the pin step is skipped, Pages still updates, and the summary says `IPFS: skipped`.

To publish a content-addressed name beside the apex, add a TXT record on `_dnslink.grokwallet.fun` with the value `dnslink=/ipfs/<CID>`. Update that record on every release that prints a new CID. DNSLink does not replace the verification URI. Compare the gateway to the release with [docs/VERIFY.md](VERIFY.md).

## 7. Optional Privy spend policy

`grokwallet cap set` stores a ceiling in the encrypted session and the CLI refuses larger sends. That does not bind a modified CLI.

To enforce a ceiling inside Privy, create a policy in the dashboard (or `POST /v1/policies`, which requires the app secret) and attach it to the wallet. `grokwallet cap policy` prints documents in the shape of the Ethereum and Solana examples:

- https://docs.privy.io/controls/policies/example-policies/ethereum
- https://docs.privy.io/controls/policies/example-policies/solana

If any rule is an `ALLOW`, methods with no matching rule are denied. A value cap on `eth_sendTransaction` also blocks `personal_sign` unless you add a rule for it. Give the policy an owner of the user, not an empty owner. An unowned policy can be changed with the app secret alone.

https://docs.privy.io/controls/policies/overview

## 8. Key rotation

| Secret | How to rotate |
| --- | --- |
| Cloudflare API token | Create a new token with the same Pages Edit permission, update `CLOUDFLARE_API_TOKEN`, then roll or delete the old token in the Cloudflare dashboard. Existing deployments stay up |
| Cloudflare account id | It changes only if you move the project to another account. Update `CLOUDFLARE_ACCOUNT_ID` and the Pages project together |
| Pinata JWT | Create a new JWT, update the `IPFS_PINNING_TOKEN` Actions secret, delete the old JWT. Previous CIDs stay pinned until you unpin them in Pinata. Clearing the secret skips future pins and leaves Pages as the host |
| Owner passphrase | The owner logs out (`grokwallet logout`), sets a new `GROKWALLET_PASSPHRASE`, and runs `login` again. Logout deletes the local file. It does not revoke Privy. Revoke old sessions on the approval page |
| Privy app secret | Rotate it in the dashboard if you have ever created one. This repo does not use it. Rotation does not by itself revoke agent grants |
| Agent grant | The owner presses Revoke on the approval page, which calls `DELETE /api/oauth/v2/grants/{id}`. The refresh token stops working. An already issued access token can keep working until it expires, up to 15 minutes |
| Approval page | Tag a new release. The workflow uploads the new attested tree to the `main` branch of the Pages project. If you pin IPFS, update the DNSLink TXT record to the new CID. The custom domain and the Privy verification URI stay the same |

There is no app signing key in this repository to rotate. Wallet keys stay inside Privy, on the owner's account.
