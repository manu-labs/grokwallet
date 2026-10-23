"use client";

import { PrivyProvider, useCreateWallet, usePrivy } from "@privy-io/react-auth";
import { useCreateWallet as useCreateSolanaWallet } from "@privy-io/react-auth/solana";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { deviceVerifySucceeded } from "../lib/device-verify";
import { connectCardDenyPath, connectCardReturnPath, hasConnectCard } from "../lib/oauth-return";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
const CLIENT_ID = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || "";
const AUTH_BASE = (process.env.NEXT_PUBLIC_PRIVY_AUTH_BASE || "https://auth.privy.io").replace(/\/$/, "");
const CONFIGURED = Boolean(APP_ID) && APP_ID !== "REPLACE_WITH_PRIVY_APP_ID";

type LinkedWallet = {
  type?: string;
  chainType?: string;
  walletClientType?: string;
  address?: string;
};

type Grant = {
  id: string;
  grant_type?: string;
  created_at?: string | number;
  last_used_at?: string | number;
};

function embeddedAddress(accounts: LinkedWallet[], chainType: string) {
  return (
    accounts.find(
      (account) =>
        account.type === "wallet" &&
        account.chainType === chainType &&
        account.walletClientType === "privy" &&
        account.address,
    )?.address || ""
  );
}

type IconName = "wallet" | "shield" | "chip" | "eye" | "signature" | "transfer" | "lock" | "code";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    wallet: <><path d="M20 8V6a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v10H6a3 3 0 0 1-3-3V7" /><path d="M20 12h-5a2 2 0 0 0 0 4h5" /><path d="M16 14h.01" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    chip: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 5v14m6-14v14M5 10h4m6 4h4M9 12h6" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    signature: <><path d="m13 5 6 6M4 20l4-1 13-13a2.1 2.1 0 0 0-3-3L5 16l-1 4Zm9 0h7" /></>,
    transfer: <><path d="M4 7h15l-3-3m3 3-3 3M20 17H5l3-3m-3 3 3 3" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" /></>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Brand() {
  return <a className="brand" href="/" aria-label="GrokWallet home"><span className="brand-icon" aria-hidden="true"><i /><i /></span>GrokWallet<span className="brand-dot">.</span></a>;
}

function Intro() {
  return <section className="intro">
    <h1>A crypto wallet<br />for your<br /><em>Grokbot.</em></h1>
    <p className="intro-copy">Connect your wallet. Give your Grok bot the freedom to act — with you in control.</p>
    <div className="wallet-art" aria-hidden="true">
      <div className="wallet-art-top"><span className="brand-icon card-brand-icon"><i /><i /></span><span>GrokWallet</span><span className="wallet-chip"><Icon name="chip" /></span></div>
      <div className="wallet-art-bottom"><span>YOURS. ALWAYS.</span><span>ETH <b>·</b> SOL</span></div>
    </div>
    <div className="ownership"><span><Icon name="shield" /></span><div><strong>Your keys stay with Privy.</strong><p>Your agent gets access. You keep ownership.</p></div></div>
  </section>;
}

function Approval() {
  const params = useSearchParams();
  const userCode = params.get("user_code")?.trim() || "";
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { createWallet: createEthereumWallet } = useCreateWallet();
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const accounts = (user?.linkedAccounts || []) as LinkedWallet[];
  const ethereum = embeddedAddress(accounts, "ethereum");
  const solana = embeddedAddress(accounts, "solana");

  async function ensureWallets() {
    if (!ethereum) {
      try {
        await createEthereumWallet();
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : "";
        if (!/already/i.test(text)) throw cause;
      }
    }
    if (!solana) {
      try {
        await createSolanaWallet();
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : "";
        if (!/already/i.test(text)) throw cause;
      }
    }
  }

  async function verify(action: "approve" | "deny") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (action === "approve") await ensureWallets();
      const token = await getAccessToken();
      console.info("device_verify", action, "user_token", Boolean(token));
      if (!token) throw new Error("Privy did not return a user access token. Log in again in this window.");
      const response = await fetch(`${AUTH_BASE}/api/oauth/v2/device_verify`, {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          "privy-app-id": APP_ID,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user_code: userCode, action }),
      });
      const redirected = response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
      const bodyText = redirected ? "" : await response.text();
      console.info("device_verify", action, response.status, response.type);
      if (!deviceVerifySucceeded(response.status, bodyText, redirected)) {
        console.error("device_verify failed", action, response.status, bodyText.slice(0, 180));
        const statusText = redirected ? "redirect" : String(response.status);
        throw new Error(
          action === "approve"
            ? `Approval was rejected (${statusText}). The code may be expired. Ask the agent to run login again.`
            : `Denial was rejected (${statusText}).`,
        );
      }
      const oauthReturn = params.get("oauth_return");
      if (action === "deny") {
        const deny = connectCardDenyPath(oauthReturn, userCode);
        if (deny) {
          setMessage("Denied. Returning that to the Connect card.");
          window.location.assign(deny);
          return;
        }
        setMessage("Denied. The agent cannot use this account.");
        return;
      }
      if (hasConnectCard(oauthReturn, userCode)) {
        const proofResponse = await fetch("/oauth/proof", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ txn: oauthReturn, user_code: userCode }),
        });
        const proofPayload = (await proofResponse.json().catch(() => null)) as { proof?: string; error?: string } | null;
        console.info("oauth_proof", proofResponse.status);
        if (!proofResponse.ok || !proofPayload?.proof) {
          throw new Error(`Could not record this approval (${proofResponse.status}).`);
        }
        const back = connectCardReturnPath(oauthReturn, userCode, proofPayload.proof);
        if (!back) throw new Error("Could not return to the Connect card.");
        setMessage("Approved. Returning to the Connect card.");
        window.location.assign(back);
        return;
      }
      setMessage("Approved. You can return to the chat.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadGrants() {
    setBusy(true);
    setError("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Privy did not return a user access token.");
      const response = await fetch(`${AUTH_BASE}/api/oauth/v2/grants`, {
        headers: { "privy-app-id": APP_ID, authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Could not list sessions (${response.status}).`);
      const payload = (await response.json()) as { data?: Grant[] };
      setGrants(payload.data || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not list sessions.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Privy did not return a user access token.");
      const response = await fetch(`${AUTH_BASE}/api/oauth/v2/grants/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "privy-app-id": APP_ID, authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Could not revoke that session (${response.status}).`);
      setMessage("Session revoked. Its refresh token no longer works. A current access token can last up to 15 minutes.");
      await loadGrants();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the session.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header><Brand /><a className="mark" href="https://www.privy.io/" target="_blank" rel="noopener noreferrer"><span /> Secured by Privy</a></header>
      <div className="approval-layout">
      <Intro />
      <div className="approval-panel">
      <section className="card">
        <div className="card-heading"><span className="connection-icon"><Icon name="wallet" /></span><span className="network-badge">ETHEREUM + SOLANA</span></div>
        <div className="eyebrow card-eyebrow">LET’S GET CONNECTED</div>
        <h2>Meet your agent’s<br />new wallet.</h2>
        <p className="muted card-copy">Sign in to connect the wallets on your Privy account to your Grok bot.</p>
        <div className="permission-list">
          <div><Icon name="eye" /><p>View your addresses & balances</p></div>
          <div><Icon name="signature" /><p>Request signatures</p></div>
          <div><Icon name="transfer" /><p>Send transactions from your wallets</p></div>
        </div>
        <div className="code-panel"><span className="field-label">VERIFICATION CODE</span>
        {userCode ? <><div className="code">{userCode}</div><p className="muted">Make sure this matches the code in your chat.</p></> : <p className="muted">Open the connection link from your bot to get started.</p>}
        </div>
        {hasConnectCard(params.get("oauth_return"), userCode) ? (
          <p className="muted">
            This window was opened by the Connect card. Log in and approve here. Privy is called from this window with
            your user token. After a successful approval it returns to the card. Deny closes the card.
          </p>
        ) : null}
        {!ready ? <p>Checking your Privy session.</p> : null}
        {ready && !authenticated ? (
          <div className="row">
            <button
              className="primary"
              type="button"
              onClick={() => {
                try {
                  Promise.resolve(login()).catch((cause: unknown) => {
                    const text = cause instanceof Error ? cause.message : "Privy login failed in this window.";
                    console.error("privy login failed", text);
                    setError(text);
                  });
                } catch (cause) {
                  const text = cause instanceof Error ? cause.message : "Privy login failed in this window.";
                  console.error("privy login failed", text);
                  setError(text);
                }
              }}
            >
              Continue with Privy <Icon name="lock" />
            </button>
          </div>
        ) : null}
        {authenticated ? (
          <>
            <ul className="wallets">
              <li><span>Ethereum</span><span>{ethereum || "will be created on approve"}</span></li>
              <li><span>Solana</span><span>{solana || "will be created on approve"}</span></li>
            </ul>
            <div className="row">
              <button className="primary" type="button" disabled={busy || !userCode} onClick={() => verify("approve")}>
                Approve
              </button>
              <button className="danger" type="button" disabled={busy || !userCode} onClick={() => verify("deny")}>
                Deny
              </button>
              <button type="button" disabled={busy} onClick={() => logout()}>
                Log out
              </button>
            </div>
          </>
        ) : null}
        {message ? <p className="success" role="status">{message}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <p className="card-footnote">Your private keys stay inside Privy.<br />Manage or revoke agent sessions after signing in.</p>
      </section>
      {authenticated ? (
        <section className="card">
          <h2>Agent sessions</h2>
          <p className="muted">Revoke a session here if you want the agent to stop. This uses your login, not an app secret.</p>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => loadGrants()}>
              Show sessions
            </button>
          </div>
          {grants ? (
            <ul className="grants">
              {grants.length === 0 ? <li>No active sessions.</li> : null}
              {grants.map((grant) => (
                <li key={grant.id}>
                  <span>{grant.grant_type || "device_code"} {grant.id}</span>
                  <button type="button" disabled={busy} onClick={() => revoke(grant.id)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      </div></div>
      <footer><span>GrokWallet <span className="footer-slash">/</span> Built for a more capable agent.</span><a href="https://github.com/manu-labs/grokwallet" target="_blank" rel="noreferrer"><Icon name="code" /> Open source</a></footer>
    </main>
  );
}

export function Authorize() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!CONFIGURED) {
    return (
      <main>
        <header>
          <h1>GrokWallet</h1>
          <div className="mark">Not configured</div>
        </header>
        <section className="card">
          <p>
            This build has no public Privy app id. Set NEXT_PUBLIC_PRIVY_APP_ID and rebuild the static export.
            Do not put an app secret in this page.
          </p>
        </section>
      </main>
    );
  }

  if (!mounted) {
    return (
      <main>
        <header>
          <h1>GrokWallet</h1>
          <div className="mark">Approval</div>
        </header>
        <section className="card">
          <p>Loading the approval page.</p>
        </section>
      </main>
    );
  }

  return (
    <PrivyProvider
      appId={APP_ID}
      {...(CLIENT_ID ? { clientId: CLIENT_ID } : {})}
      config={{
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          solana: { createOnLogin: "users-without-wallets" },
        },
        appearance: { theme: "dark", accentColor: "#10c77a" },
      }}
    >
      <Approval />
    </PrivyProvider>
  );
}
