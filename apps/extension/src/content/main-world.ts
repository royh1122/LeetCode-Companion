/**
 * Runs in the page's MAIN world at document_start (declared in the manifest,
 * so LeetCode's CSP doesn't apply). It wraps fetch and XMLHttpRequest and only
 * *observes* the page's own Submit / Run / result-polling requests, and the
 * page's own GraphQL request for a study plan's question list. It never
 * issues requests, never modifies requests or responses, and ignores every
 * other URL. Captured data is posted to the isolated content script.
 */
import { classifyLeetCodeRequest } from "@lcc/shared/leetcode";
import { asksForStudyPlan, interpret, type Intercepted } from "../lib/intercept";

declare global {
  interface Window {
    __lccHooked?: boolean;
  }
}

(() => {
  if (window.__lccHooked) return;
  window.__lccHooked = true;

  const post = (payload: Intercepted) => {
    try {
      window.postMessage({ __lcc: true, payload }, location.origin);
    } catch {
      /* never break the page */
    }
  };
  const safe = (fn: () => void | Promise<void>) => {
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => undefined);
    } catch {
      /* never break the page */
    }
  };

  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let url = "";
    let method = "GET";
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    } catch {
      /* ignore */
    }
    let kind: ReturnType<typeof classifyLeetCodeRequest> = null;
    let bodyPromise: Promise<string | null> = Promise.resolve(typeof init?.body === "string" ? init.body : null);
    try {
      // Anything that throws here (a malformed URL, a used body) must fall through to the real fetch.
      kind = url ? classifyLeetCodeRequest(method, new URL(url, location.href).href) : null;
      if (kind && kind.kind !== "check" && typeof init?.body !== "string" && input instanceof Request) {
        bodyPromise = input.clone().text().catch(() => null);
      }
    } catch {
      kind = null;
    }
    const p = origFetch.apply(this as typeof window, [input, init] as Parameters<typeof fetch>);
    if (kind) {
      p.then((res) =>
        safe(async () => {
          if (!res.ok) return;
          // Of all GraphQL calls, only the one asking for a study plan's question list is read.
          if (kind.kind === "graphql" && !asksForStudyPlan(await bodyPromise)) return;
          const [body, json] = await Promise.all([bodyPromise, res.clone().json().catch(() => null)]);
          const m = interpret(method, new URL(url, location.href).href, body, json);
          if (m) post(m);
        }),
      ).catch(() => undefined);
    }
    return p;
  } as typeof fetch;

  // ---- XMLHttpRequest ----
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  type Tagged = XMLHttpRequest & { __lcc?: { method: string; url: string } };
  XHR.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
    safe(() => {
      this.__lcc = { method: String(method).toUpperCase(), url: new URL(String(url), location.href).href };
    });
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
    safe(() => {
      const meta = this.__lcc;
      const k = meta && classifyLeetCodeRequest(meta.method, meta.url);
      if (!meta || !k) return;
      const reqBody = typeof body === "string" ? body : null;
      if (k.kind === "graphql" && !asksForStudyPlan(reqBody)) return;
      this.addEventListener("load", () =>
        safe(() => {
          if (this.status < 200 || this.status >= 300) return;
          const resp = this.responseType === "" || this.responseType === "text" ? this.responseText : this.responseType === "json" ? this.response : null;
          const m = interpret(meta.method, meta.url, reqBody, resp);
          if (m) post(m);
        }),
      );
    });
    return origSend.call(this, body);
  };

  try {
    window.postMessage({ __lcc: true, ready: true }, location.origin);
  } catch {
    /* ignore */
  }
})();
