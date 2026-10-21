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
      <header>
        <h1>GrokWallet</h1>
        <div className="mark">Approval</div>
      </header>
      <section className="card">
        <h2>An agent wants to use your wallets</h2>
        <p>
          Approving lets that agent see your Ethereum and Solana addresses, request signatures, and send transactions
          from wallets owned by your Privy account. The agent does not receive your password, this site&apos;s source
          has no app secret, and the wallet private key stays inside Privy.
        </p>
        <p className="muted">Confirm the code below matches the code in your chat before you approve.</p>
        {userCode ? <div className="code">{userCode}</div> : <p>No user code was in this link. Open the URL the agent printed.</p>}
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
              Log in with Privy
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
        {message ? <p>{message}</p> : null}
        {error ? <p className="error">{error}</p> : null}
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
      <footer>
        Build {process.env.NEXT_PUBLIC_BUILD_COMMIT || "local"}. This page only stores the public Privy app id.
      </footer>
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
        appearance: { theme: "light", accentColor: "#1d6b43" },
      }}
    >
      <Approval />
    </PrivyProvider>
  );
}
