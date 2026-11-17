import type { Config } from "../lib/controller";
import { hasBuiltInAccess, isLoopbackUrl, normalizeDashboardUrl, splitPairingInput } from "../lib/dashboard-url";
import { deviceNameFromUserAgent } from "../lib/device-name";
import { send } from "../lib/messages";

const server = document.getElementById("server") as HTMLInputElement;
const code = document.getElementById("code") as HTMLInputElement;
const status = document.getElementById("status")!;
const paired = document.getElementById("paired")!;
const httpNote = document.getElementById("http-note")!;

function show(text: string, tone: "good" | "bad" | "neutral") {
  status.replaceChildren();
  const s = document.createElement("span");
  s.className = `chip ${tone}`;
  s.textContent = text;
  status.append(s);
}

/** Pasting the dashboard's "<address>  <CODE>" line into either field fills both. */
function splitPaste() {
  const parts = splitPairingInput(server.value, code.value);
  if (parts.address) server.value = parts.address;
  if (parts.code) code.value = parts.code;
  updateHttpNote();
}

function updateHttpNote() {
  let url = "";
  try {
    url = normalizeDashboardUrl(server.value);
  } catch {
    /* not an address yet */
  }
  httpNote.hidden = !url.startsWith("http:") || isLoopbackUrl(url);
}

async function load() {
  const c = await send<Config>({ type: "config:get" });
  server.value = c.serverUrl;
  paired.textContent = c.token ? `This browser is paired with ${c.serverUrl}. Pair again only if the dashboard asks you to, or to switch dashboards.` : "This browser is not paired yet.";
  updateHttpNote();
}

server.addEventListener("input", splitPaste);
code.addEventListener("input", splitPaste);

document.getElementById("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  splitPaste();
  let url: string;
  try {
    url = normalizeDashboardUrl(server.value);
  } catch (err) {
    show(err instanceof Error ? err.message : "Invalid address", "bad");
    return;
  }
  if (!code.value.trim()) {
    show("Enter the pairing code from the dashboard (Settings → Devices → Add a device).", "bad");
    return;
  }
  server.value = url;
  // Asking for access to the address must happen right in the click (Chrome requires a user gesture),
  // so before any await. http://127.0.0.1 and http://localhost are covered by the manifest already.
  const access = hasBuiltInAccess(url) ? Promise.resolve(true) : requestAccess(url);
  void pair(url, access);
});

function requestAccess(url: string): Promise<boolean> {
  try {
    return chrome.permissions.request({ origins: [`${url}/*`] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

async function pair(url: string, access: Promise<boolean>) {
  if (!(await access)) {
    show(`The extension needs your permission to reach ${url}. Click Pair again and allow it.`, "bad");
    return;
  }
  show("Pairing…", "neutral");
  const name = deviceNameFromUserAgent(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints, brave: "brave" in navigator });
  let r: { ok: boolean; name?: string; message?: string };
  try {
    r = await send<{ ok: boolean; name?: string; message?: string }>({ type: "pair", serverUrl: url, code: code.value.trim(), name });
  } catch (err) {
    show(err instanceof Error ? err.message : "Pairing failed", "bad");
    return;
  }
  if (!r.ok) {
    show(r.message ?? "Pairing failed", "bad");
    return;
  }
  code.value = "";
  const ping = await send<{ ok: boolean; error?: { message: string } }>({ type: "ping" });
  if (ping.ok) {
    show(`Paired as "${r.name}" ✓ (rename it in the dashboard's Settings → Devices)`, "good");
    void send({ type: "sync:now" });
  } else show(`Paired, but the connection test failed: ${ping.error?.message ?? "unknown error"}`, "bad");
  void load();
}

void load();
