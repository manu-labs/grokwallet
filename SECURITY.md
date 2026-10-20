# Security

GrokWallet is a non-custodial agent wallet. A bug in the CLI, the approval page, or the bot template can move funds or sign a message the owner did not intend.

## Report a vulnerability

Use a private [GitHub Security Advisory](https://github.com/manu-labs/grokwallet/security/advisories/new) for this repository. Please include the commit you tested, the command or page, and the impact. Do not open a public issue for a vulnerability, and do not include tokens, passphrases, or live transaction hashes that identify a victim.

There is no bug bounty in this repository.

## What to expect

The maintainers will acknowledge a report that they can reproduce, and they will coordinate a fix before details are published. If you do not get a reply, open the advisory again with a short follow-up. Do not send the Privy app secret, a user access token, or a refresh token in the report. Those are not needed to describe a bug in this codebase.

## Scope

In scope: the `grokwallet` CLI, the static approval page, the GitHub workflows, and the bot template in this repository.

Out of scope: Privy's hosted API, a public RPC endpoint, the owner's machine, and phishing pages that copy the approval UI. Report Privy platform issues to Privy.
