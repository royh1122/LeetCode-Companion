import type { Config } from "../lib/controller";
import { send } from "../lib/messages";

const server = document.getElementById("server") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status")!;

function show(text: string, tone: "good" | "bad" | "neutral") {
  status.replaceChildren();
  const s = document.createElement("span");
  s.className = `chip ${tone}`;
  s.textContent = text;
  status.append(s);
}

async function load() {
  const c = await send<Config>({ type: "config:get" });
  server.value = c.serverUrl;
  token.value = c.token;
}

document.getElementById("form")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  let url = server.value.trim().replace(/\/+$/, "");
  try {
    const u = new URL(url);
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("The dashboard must run on this computer (localhost / 127.0.0.1).");
    url = u.origin;
  } catch (err) {
    show(err instanceof Error ? err.message : "Invalid URL", "bad");
    return;
  }
  await send({ type: "config:set", config: { serverUrl: url, token: token.value.trim() } });
  show("Testing…", "neutral");
  const r = await send<{ ok: boolean; error?: { message: string } }>({ type: "ping" });
  if (r.ok) {
    show("Connected and paired ✓", "good");
    void send({ type: "sync:now" });
  } else show(`Saved, but the test failed: ${r.error?.message ?? "unknown error"}`, "bad");
});

void load();
