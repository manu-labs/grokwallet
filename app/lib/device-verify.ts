// A device_verify call succeeded only when Privy answered this request itself.
// A redirect (including an opaque redirect) and an error body are failures.
export function deviceVerifySucceeded(status: number, bodyText: string, redirected: boolean): boolean {
  if (redirected) return false;
  if (status !== 200 && status !== 204) return false;
  const text = bodyText.trim();
  if (!text) return true;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return true;
  const record = payload as { error?: unknown; success?: unknown };
  if (typeof record.error === "string" && record.error) return false;
  if (record.success === false) return false;
  return true;
}
