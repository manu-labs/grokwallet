const TOKEN = /^gw1\.[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{20,2000}$/;
const USER_CODE = /^[A-Za-z0-9]{4,16}(?:-[A-Za-z0-9]{4,16})?$/;

// The return value is a same-origin path. It is never taken from the query as a URL.
export function connectCardReturnPath(token: string | null | undefined, userCode: string | null | undefined): string {
  const txn = (token || "").trim();
  const code = (userCode || "").trim();
  if (!TOKEN.test(txn) || !USER_CODE.test(code)) return "";
  return `/oauth/complete?txn=${encodeURIComponent(txn)}&user_code=${encodeURIComponent(code)}`;
}
