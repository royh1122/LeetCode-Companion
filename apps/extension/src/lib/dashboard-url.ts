/**
 * The dashboard address the extension talks to. Any http(s) address is allowed: on this computer
 * (the default) or, in server mode, on a private network (Tailscale, home Wi-Fi). Code and notes go
 * only to the address the user entered and paired with.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** "my-laptop.ts.net:8443/settings" → "http://my-laptop.ts.net:8443"; throws a readable error otherwise. */
export function normalizeDashboardUrl(input: string): string {
  let raw = input.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("Enter the dashboard address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`"${input.trim()}" is not a valid address.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The dashboard address must start with http:// or https://.");
  if (u.username || u.password) throw new Error("The dashboard address must not contain a user name or password.");
  return u.origin;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Addresses the manifest's required host permissions already cover; any other needs a runtime grant. */
export function hasBuiltInAccess(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

/** True when the address is valid (see normalizeDashboardUrl). */
export function isDashboardUrl(url: string): boolean {
  try {
    normalizeDashboardUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits what the user typed or pasted: the dashboard's "Add a device" line is "<address>  <CODE>",
 * but either part may come alone. A code is the last token when it looks like XXXX-XXXX.
 */
export function splitPairingInput(address: string, code: string): { address: string; code: string } {
  const parts = `${address} ${code}`.trim().split(/\s+/).filter(Boolean);
  const isCode = (s: string) => /^[0-9a-z]{4}-?[0-9a-z]{4}$/i.test(s);
  const codePart = [...parts].reverse().find(isCode) ?? "";
  const addressPart = parts.find((p) => p !== codePart && !isCode(p)) ?? "";
  return { address: addressPart, code: codePart };
}
