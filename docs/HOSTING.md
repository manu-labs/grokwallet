# Hosting

This is the list for the person who owns the GitHub repo, the Privy app, and the Cloudflare account. End users do not do these steps. Nothing in this list belongs in a commit except the public app id, and only after you decide the repository is allowed to contain it. This template ships with the placeholder `REPLACE_WITH_PRIVY_APP_ID` instead.

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
| Privy app id | GitHub Actions variable `PRIVY_APP_ID`. Also replace `REPLACE_WITH_PRIVY_APP_ID` in `template/grokwallet.json` before you share the template | No. It is in the browser bundle |
| Privy app client id, if the dashboard shows one | GitHub Actions variable `PRIVY_CLIENT_ID` | No |
| Pages project name, if it is not `grokwallet` | GitHub Actions variable `CLOUDFLARE_PAGES_PROJECT` | No |
| Privy app secret | Privy dashboard only | Yes. Do not put it on the bot, in the approval page, in GitHub Actions, or in git. This design does not use it |
| `GROKWALLET_PASSPHRASE` | Masked secret on the bot owner's account | Yes. Each owner chooses their own |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Yes. Never commit it |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Yes. Never commit it. It identifies the account; treat it as a secret anyway |
| `IPFS_PINNING_TOKEN` | GitHub Actions secret. A Pinata JWT that can call `pinFileToIPFS`. Leave it unset to skip IPFS | Yes. Never commit it |

## 3. GitHub Actions

Repository variable:

- `PRIVY_APP_ID` — the 25-character public app id

Optional repository variables:

- `PRIVY_CLIENT_ID` — public client id, or leave empty
- `CLOUDFLARE_PAGES_PROJECT` — Pages project name. The workflow uses `grokwallet` when this is empty

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

1. In the Cloudflare dashboard, open **Workers & Pages → Create → Pages → Upload assets** (direct upload). Name the project `grokwallet`, or another single token that you also save as the `CLOUDFLARE_PAGES_PROJECT` repository variable. Set the production branch to `main`. The workflow deploys with `--branch=main`. A deployment on that branch is the production deployment.
2. You can create the empty project from a machine that already has Wrangler, with the same account:

   ```sh
   npx wrangler@4.151.3 pages project create grokwallet --production-branch=main
   ```

   The first `pages deploy` from GitHub Actions also creates a project of that name if your token is allowed to. Creating it in the dashboard first makes the name and the production branch explicit.
3. Create an API token: **My Profile → API Tokens → Create Token → Custom token**. Permission: **Account → Cloudflare Pages → Edit**. Account resources: the account that owns the project. Copy the token into the `CLOUDFLARE_API_TOKEN` Actions secret. Copy the account id into `CLOUDFLARE_ACCOUNT_ID`.
4. Push the tag (or run the Publish workflow by hand). The job summary includes the deployment URL and the `*.pages.dev` alias (`pages-deployment-alias-url`).
5. Open the alias over HTTPS and confirm the approval page loads. The Privy SDK refuses embedded wallets on plain HTTP, except localhost. Direct upload serves the attested files as static assets, including the query string on `user_code`.

### Custom domain

Example: `wallet.example.com`.

1. Open the Pages project → **Custom domains** → **Set up a custom domain**.
2. Enter `wallet.example.com`.
3. If the DNS zone is on this Cloudflare account, accept the record Cloudflare offers (a CNAME from `wallet` to `<project>.pages.dev`, proxied). If DNS is elsewhere, add the CNAME they display at your DNS host.
4. Wait until the custom domain shows **Active** and the certificate is issued. Open `https://wallet.example.com/` and confirm the page loads.
5. Replace `https://wallet.example.com/` in `template/grokwallet.json` (the getting-started skill) with this origin if you use a different name. The CLI prints the verification URI Privy returns, so once the dashboard matches this domain, the CLI output is the URL to show the owner.

The workflow does not create the DNS record. Adding the domain is a dashboard step so the certificate and the zone stay under the account owner's control.

## 5. Point Privy at the custom domain

In the Privy dashboard, under **Authentication → Advanced**, set the verification URI to the Pages origin with a trailing slash:

`https://wallet.example.com/`

Privy returns that value to the CLI as `verification_uri`. The CLI appends the user code and prints `verification_uri_complete`. Owners must land on this Pages host, because that is the origin whose files match the attested build.

Use the `*.pages.dev` alias only as a temporary URI while the custom domain is still issuing a certificate. Replace it with the custom domain before you share the template. A public IPFS gateway is a poor verification URI: some gateways drop `?user_code=`, which the page needs.

## 6. IPFS, optional

The pin runs only when the `IPFS_PINNING_TOKEN` secret is set. The same `dist/site` directory that was uploaded to Pages is sent to Pinata (`POST https://api.pinata.cloud/pinning/pinFileToIPFS`, `cidVersion` 1). The job summary and the GitHub release include the CID (`IpfsHash`) and `https://gateway.pinata.cloud/ipfs/<CID>/`.

When the secret is absent, the pin step is skipped, Pages still updates, and the summary says `IPFS: skipped`.

To publish a content-addressed name beside the custom domain, add a TXT record on `_dnslink.wallet.example.com` with the value `dnslink=/ipfs/<CID>`. Update that record on every release that prints a new CID. DNSLink does not replace the verification URI. Compare the gateway to the release with [docs/VERIFY.md](VERIFY.md).

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
