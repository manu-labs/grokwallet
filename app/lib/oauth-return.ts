const TOKEN = /^gw1\.[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{20,2000}$/;
const USER_CODE = /^[A-Za-z0-9]{4,16}(?:-[A-Za-z0-9]{4,16})?$/;

function shaped(token: string | null | undefined, userCode: string | null | undefined) {
  const txn = (token || "").trim();
  const code = (userCode || "").trim();
  if (!TOKEN.test(txn) || !USER_CODE.test(code)) return null;
  return { txn, code };
}

// True when this page load is the Connect card handoff. The value is not a URL.
export function hasConnectCard(token: string | null | undefined, userCode: string | null | undefined): boolean {
  return shaped(token, userCode) !== null;
}

// The return value is a same-origin path. It is never taken from the query as a URL.
// proof is the HMAC approval token minted after device_verify succeeds.
export function connectCardReturnPath(
  token: string | null | undefined,
  userCode: string | null | undefined,
  proof: string | null | undefined,
): string {
  const parts = shaped(token, userCode);
  const approval = (proof || "").trim();
  if (!parts || !TOKEN.test(approval)) return "";
  return `/oauth/complete?txn=${encodeURIComponent(parts.txn)}&user_code=${encodeURIComponent(parts.code)}&proof=${encodeURIComponent(approval)}`;
}

export function connectCardDenyPath(token: string | null | undefined, userCode: string | null | undefined): string {
  const parts = shaped(token, userCode);
  if (!parts) return "";
  return `/oauth/complete?txn=${encodeURIComponent(parts.txn)}&user_code=${encodeURIComponent(parts.code)}&deny=1`;
}
