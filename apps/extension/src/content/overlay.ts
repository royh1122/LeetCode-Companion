import type { TabState } from "../lib/controller";

/**
 * Tiny, unobtrusive UI injected into LeetCode inside a closed Shadow DOM so
 * neither side's CSS leaks. Offer card when a problem isn't tracked yet; a
 * small status pill while tracking. Built with DOM APIs (no innerHTML from data).
 */
interface Handlers {
  start: () => void;
  resume: (id: string) => void;
  ignore: () => void;
  history: () => void;
}

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let collapsed = false;

const CSS = `
:host { all: initial; }
.wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0b0b0b; }
.card { width: 300px; background: #fff; border: 1px solid #e4e4e2; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.14); padding: 12px; }
.title { font-weight: 600; margin: 0 0 2px; }
.sub { color: #52514e; font-size: 12px; margin: 0 0 10px; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
button { all: unset; cursor: pointer; border-radius: 6px; padding: 5px 10px; font-size: 12px; font-weight: 500; border: 1px solid #e4e4e2; background: #fff; color: #0b0b0b; }
button:hover { background: #f4f4f3; }
button.primary { background: #2a78d6; border-color: #2a78d6; color: #fff; }
button.primary:hover { filter: brightness(1.08); }
button:focus-visible { outline: 2px solid #2a78d6; outline-offset: 2px; }
.pill { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #e4e4e2; border-radius: 999px; padding: 4px 10px; box-shadow: 0 2px 10px rgba(0,0,0,.1); font-size: 12px; cursor: pointer; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #0ca30c; }
.x { position: absolute; top: 8px; right: 10px; border: none; padding: 2px 6px; color: #8a8985; }
@media (prefers-color-scheme: dark) {
  .wrap { color: #f0efec; }
  .card, .pill, button { background: #1a1a19; border-color: #2e2e2b; color: #f0efec; }
  button:hover { background: #222220; }
  .sub { color: #c3c2b7; }
}
`;

function ensureRoot() {
  if (root && host?.isConnected) return root;
  host = document.createElement("lcc-companion");
  root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);
  (document.body ?? document.documentElement).appendChild(host);
  return root;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, children: (Node | string)[] = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function renderOverlay(state: TabState | null, h: Handlers) {
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", () => renderOverlay(state, h), { once: true });
    return;
  }
  const r = ensureRoot();
  r.querySelector(".wrap")?.remove();
  if (!state || state.mode === "idle" || state.mode === "ignored" || !state.slug) return;
  const wrap = el("div", { className: "wrap" });
  if (state.mode === "bound") {
    const pill = el("div", { className: "pill", title: "LeetCode Companion is tracking this session. Open the side panel from the toolbar icon to take notes and finish." }, [
      el("span", { className: "dot" }),
      collapsed ? "" : "Tracking session",
    ]);
    pill.setAttribute("role", "status");
    pill.addEventListener("click", () => {
      collapsed = !collapsed;
      renderOverlay(state, h);
    });
    wrap.append(pill);
  } else {
    const p = state.context?.problem;
    const name = p?.title ?? state.title ?? state.slug;
    const sub = p ? (p.sessionCount ? `${p.sessionCount} previous session${p.sessionCount === 1 ? "" : "s"} · ${p.mastery.replace("_", " ")}` : "First time — not practiced yet") : state.context === null ? "Dashboard offline — the session will sync later" : "Not in your library yet";
    const card = el("div", { className: "card" });
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "LeetCode Companion");
    const close = el("button", { className: "x", textContent: "×", title: "Ignore this visit" });
    close.setAttribute("aria-label", "Ignore this visit");
    close.addEventListener("click", h.ignore);
    const row = el("div", { className: "row" });
    if (state.resumable) {
      const b = el("button", { className: "primary", textContent: `Resume (started ${ago(state.resumable.startedAt)})` });
      b.addEventListener("click", () => h.resume(state.resumable!.id));
      // Only one open session per problem: resume it (finish or abandon it from the side panel or dashboard).
      row.append(b);
    } else {
      const b = el("button", { className: "primary", textContent: "Start session" });
      b.addEventListener("click", h.start);
      row.append(b);
    }
    const hist = el("button", { textContent: "History" });
    hist.addEventListener("click", h.history);
    const ign = el("button", { textContent: "Ignore" });
    ign.addEventListener("click", h.ignore);
    row.append(hist, ign);
    card.append(close, el("p", { className: "title", textContent: `Track “${name}”?` }), el("p", { className: "sub", textContent: sub }), row);
    card.style.position = "relative";
    wrap.append(card);
  }
  r.append(wrap);
}
