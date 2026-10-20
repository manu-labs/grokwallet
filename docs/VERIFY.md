# Verify a build

Anyone can check that a published approval page and CLI came from a commit in this repository, and that the site Cloudflare Pages is serving matches that attested output. You do not need the Cloudflare token, the pinning token, the passphrase, or a Privy secret.

The publish workflow builds the static page once. It packs `app/out` as `grokwallet-app.tar.gz`, attests that archive, extracts it to `dist/site`, and uploads `dist/site` to Cloudflare Pages. When `IPFS_PINNING_TOKEN` is set, it pins that same directory. A hash match against `approval-page.MANIFEST` means the host is serving the attested files.

## 1. Attestation

Install the [GitHub CLI](https://cli.github.com/). Download the release assets `grokwallet-app.tar.gz`, `grokwallet-bot.tar.gz`, `approval-page.MANIFEST`, and `SHA256SUMS`, then:

```sh
gh attestation verify grokwallet-app.tar.gz --repo manu-labs/grokwallet
gh attestation verify grokwallet-bot.tar.gz --repo manu-labs/grokwallet
gh attestation verify approval-page.MANIFEST --repo manu-labs/grokwallet
gh attestation verify SHA256SUMS --repo manu-labs/grokwallet
sha256sum -c SHA256SUMS
```

`gh attestation verify` checks the Sigstore provenance from `.github/workflows/publish.yml` (`actions/attest-build-provenance`). A match means GitHub Actions for this repo built that file from the recorded commit. The checksum file covers the two tarballs and `approval-page.MANIFEST`.

The predicate includes the commit SHA. Check that SHA out when you rebuild. The workflow deploys the extracted `grokwallet-app.tar.gz` and does not build the page again for Pages or for IPFS.

## 2. Rebuild the approval page

The page is a Next.js static export. The public app id is compiled into the JavaScript, so the rebuild has to use the same id the release notes print. It is public. The workflow reads it from the `PRIVY_APP_ID` repository variable.

```sh
git clone https://github.com/manu-labs/grokwallet.git
cd grokwallet
git checkout <commit-from-the-attestation>
# Node from .nvmrc (22.23.3)
export NEXT_TELEMETRY_DISABLED=1
export SOURCE_COMMIT=$(git rev-parse HEAD)
export NEXT_PUBLIC_PRIVY_APP_ID="<app id printed in the release>"
# export NEXT_PUBLIC_PRIVY_CLIENT_ID=...   # only if the release used one
cd app
npm ci
npm run build
cd ..
node scripts/hash-tree.mjs app/out > rebuilt.MANIFEST
diff -u approval-page.MANIFEST rebuilt.MANIFEST
```

`npm ci` uses `app/package-lock.json`. `SOURCE_COMMIT` is the Next.js build id, which is also embedded in the page. CI builds the page twice and fails if those manifests differ.

`grokwallet-app.tar.gz` is the `app/out` directory, packed with GNU tar `--sort=name`, a source date from the commit, and numeric owner 0. After you extract it, `approval-page.MANIFEST` should match `node scripts/hash-tree.mjs` on the extracted `out` directory:

```sh
mkdir -p /tmp/grokwallet-site && tar -xzf grokwallet-app.tar.gz -C /tmp/grokwallet-site
node scripts/hash-tree.mjs /tmp/grokwallet-site/out > extracted.MANIFEST
diff -u approval-page.MANIFEST extracted.MANIFEST
```

## 3. Compare the served files with the attested manifest

`scripts/verify-site.mjs` downloads each path in the manifest and compares the response body to that sha256. Node's `fetch` decodes `Content-Encoding`, so a gzip-compressed response is hashed as the file bytes.

Check the custom domain and the Pages alias printed in the release:

```sh
node scripts/verify-site.mjs https://grokwallet.fun approval-page.MANIFEST
node scripts/verify-site.mjs https://grokwallet.pages.dev approval-page.MANIFEST
```

Use the alias from the release if the project name is not `grokwallet`. A matching line (`matched N files`) means every file Pages returned is byte-for-byte the attested build. A `FAIL hash` or `FAIL 404` line means that path differs from the manifest: stop trusting that host until you can explain the difference.

The script requests each file at its path (`/index.html`, `/_next/static/...`). It does not send `user_code`. After the hashes match, open `https://grokwallet.fun/?user_code=ABCD-EFGH` in a browser and confirm the code is still in the page address. That checks the query string, which the hash compare does not cover.

The footer of the page shows the commit baked in at build time. It should equal the attestation subject.

## 4. Compare the IPFS copy

Skip this section when the release says `IPFS: skipped`. That release did not have `IPFS_PINNING_TOKEN`. Pages is still covered by sections 1–3.

When the release prints a CID, the pin was `dist/site` from the attested archive (`POST https://api.pinata.cloud/pinning/pinFileToIPFS`, `cidVersion` 1, paths relative to that directory). Run the same compare against a gateway:

```sh
node scripts/verify-site.mjs "https://gateway.pinata.cloud/ipfs/<CID>" approval-page.MANIFEST
```

A match means the gateway served the attested bytes. It does not, by itself, recompute the CID. A local `ipfs add -r` CID matches Pinata's CID only when the UnixFS layout matches, including CID version 1 and the same relative paths with no extra root folder name. Re-running `scripts/pin-ipfs.sh` on a directory whose manifest matches, with the same Pinata options, should return the same CID. This repository does not claim a CID from a different packer. If one gateway rewrites HTML, try another gateway or a local Kubo node and compare again. The attestation plus the manifest is the statement of what was built. The CID is the address Pinata assigned to that directory.

DNSLink is a TXT record, `_dnslink.<host>`, with value `dnslink=/ipfs/<CID>`. Update it when a release replaces the CID. That record is not covered by the attestation. Read it from DNS and compare it to the release. The Privy verification URI stays on the Pages custom domain, where query strings are preserved.

## 5. Rebuild the CLI

```sh
tar -xzf grokwallet-bot.tar.gz
cd grokwallet-bot   # or the extracted bot directory
npm ci
npm test
```

The tarball excludes `node_modules`. The lockfile pins the three runtime dependencies (`canonicalize`, `@hpke/core`, `@hpke/chacha20poly1305`). Tests cover session encryption and the authorization-signature canonical payload. They do not call Privy.
