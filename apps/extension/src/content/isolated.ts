/**
 * Isolated-world content script on leetcode.com. Responsibilities:
 *  - detect the current problem (initial load, refresh, SPA navigation)
 *  - send activity heartbeats (visibility, focus, last input time)
 *  - relay captured submit/run/result data from the MAIN-world hook
 *  - show a small, dismissible prompt to start/resume tracking
 *  - on a study-plan page, pass on the plan's question list (the side panel offers to import it)
 * It reads no page content besides the URL, the document title, the problem
 * number shown in the title, and on study-plan pages the plan data LeetCode
 * embeds in the page (<script id="__NEXT_DATA__">).
 */
import { parseProblemSlug } from "@lcc/shared/leetcode";
import { HEARTBEAT_MS } from "../lib/activity";
import type { TabState } from "../lib/controller";
import { isInterceptedMessage, studyPlanFromNextData } from "../lib/intercept";
import { send } from "../lib/messages";
import { pageTitle } from "../lib/page-info";
import { renderOverlay } from "./overlay";

const HASH_RE = /lcc-session=([0-9a-f-]{16,64})/i;
// Read the hash as early as possible (document_start) before the SPA rewrites the URL.
let hashSessionId: string | null = HASH_RE.exec(location.hash)?.[1] ?? null;
let currentSlug: string | null = null;
/** False until the worker has taken the current page's report; retried every second until it has. */
let pageReported = false;
let reporting = false;
/** Tab title still showing the previous problem after in-app navigation (see pageTitle). */
let staleTitle: string | null = null;
let lastTitle = document.title;
let captureReady = false;
let lastInputAt = Date.now();
let state: TabState | null = null;
let contextAlive = true;

function alive() {
  try {
    return contextAlive && !!chrome.runtime?.id;
  } catch {
    contextAlive = false;
    return false;
  }
}

async function safeSend<T>(msg: Parameters<typeof send>[0]): Promise<T | null> {
  if (!alive()) return null;
  try {
    return await send<T>(msg);
  } catch {
    return null;
  }
}

/** Called on load and every second: reports a new problem, a failed report again, or a title that was held back. */
async function reportPage() {
  if (reporting) return;
  const slug = parseProblemSlug(location.href);
  if (slug !== currentSlug) {
    // In-app navigation: LeetCode changes the address first and the tab title a moment later.
    staleTitle = currentSlug !== null && slug !== null && document.title === lastTitle ? document.title : null;
    currentSlug = slug;
    pageReported = false;
  } else if (pageReported) {
    // Already reported; only the new problem's title appearing is worth another report.
    if (staleTitle === null || document.title === staleTitle) return;
    staleTitle = null;
  }
  lastTitle = document.title;
  const { title, frontendId } = pageTitle(document.title, staleTitle);
  reporting = true;
  try {
    const s = await safeSend<TabState>({ type: "page", slug, title, frontendId, hashSessionId });
    // A lost report would leave the worker thinking this tab is elsewhere, and it would then drop
    // this page's submissions: keep trying until it gets through.
    if (!s || currentSlug !== slug) return;
    pageReported = true;
    hashSessionId = null; // only meaningful for the first load
    setState(s);
  } finally {
    reporting = false;
  }
}

function setState(s: TabState | null) {
  state = s;
  renderOverlay(state, {
    start: async () => setState(await safeSend<TabState>({ type: "start" })),
    resume: async (id) => setState(await safeSend<TabState>({ type: "resume", sessionId: id })),
    ignore: async () => setState(await safeSend<TabState>({ type: "ignore" })),
    history: () => void safeSend({ type: "open-dashboard", path: state?.slug ? `/problems/${state.slug}` : "/" }),
  });
}

function heartbeat() {
  if (!alive() || !currentSlug) return;
  void safeSend({ type: "heartbeat", visible: document.visibilityState === "visible", focused: document.hasFocus(), lastInputAt, captureReady });
}

// Relay messages from the MAIN-world hook (same window only).
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  if (!isInterceptedMessage(e.data)) return;
  if ("ready" in e.data) {
    captureReady = true;
    return;
  }
  void safeSend({ type: "intercepted", payload: e.data.payload });
});

const markInput = () => {
  lastInputAt = Date.now();
};
for (const ev of ["keydown", "mousedown", "wheel", "touchstart", "pointermove"] as const) {
  window.addEventListener(ev, markInput, { capture: true, passive: true });
}
document.addEventListener("visibilitychange", heartbeat);
window.addEventListener("focus", heartbeat);
window.addEventListener("blur", heartbeat);

if (alive()) {
  chrome.runtime.onMessage.addListener((msg: { type: string; state?: TabState }) => {
    if (msg?.type === "tab:state" && msg.state) setState(msg.state);
  });
}

let planCheckedFor: string | null = null;
/** Full page load of a study plan: the list is embedded in the page instead of requested. */
function checkEmbeddedPlan() {
  if (location.pathname === planCheckedFor) return;
  planCheckedFor = location.pathname;
  const list = studyPlanFromNextData(document.getElementById("__NEXT_DATA__")?.textContent, location.pathname);
  if (list) void safeSend({ type: "intercepted", payload: { type: "studyplan", list } });
}

function boot() {
  void reportPage();
  checkEmbeddedPlan();
  // SPA navigation: LeetCode changes problems without a full page load.
  setInterval(() => {
    if (!alive()) return;
    void reportPage();
    checkEmbeddedPlan();
  }, 1000);
  setInterval(heartbeat, HEARTBEAT_MS);
  setTimeout(heartbeat, 2000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
