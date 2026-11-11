import type { ExtensionContext, ExtensionSessionState, SyncEventResult } from "@lcc/shared";

export type ApiError = { kind: "offline" | "unauthorized" | "server" | "bad_request"; message: string };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface Api {
  ping(): Promise<ApiResult<{ ok: true; serverTime: number }>>;
  context(slug: string): Promise<ApiResult<ExtensionContext & { recommendations: Record<string, string> | null }>>;
  session(id: string): Promise<ApiResult<ExtensionSessionState | null>>;
  sendEvents(events: unknown[]): Promise<ApiResult<{ results: (SyncEventResult & { sessionId?: string })[] }>>;
  importList(list: unknown): Promise<ApiResult<{ slug: string; name: string; count: number }>>;
}

export interface ApiConfig {
  serverUrl: string;
  token: string;
  version: string;
}

/** Talks only to the configured local dashboard. Never to any third party. */
export function httpApi(getConfig: () => Promise<ApiConfig>, fetchImpl: typeof fetch = fetch): Api {
  async function call<T>(path: string, init?: RequestInit, notFoundIsNull = false): Promise<ApiResult<T>> {
    const cfg = await getConfig();
    if (!cfg.token) return { ok: false, error: { kind: "unauthorized", message: "Not paired: add the token in the extension options." } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchImpl(`${cfg.serverUrl.replace(/\/+$/, "")}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}`, "X-LCC-Version": cfg.version, ...(init?.headers ?? {}) },
      });
      if (res.status === 401) return { ok: false, error: { kind: "unauthorized", message: "The dashboard rejected the pairing token." } };
      if (res.status === 404 && notFoundIsNull) return { ok: true, data: null as T };
      if (res.status >= 500) return { ok: false, error: { kind: "server", message: `Dashboard error ${res.status}` } };
      if (!res.ok) return { ok: false, error: { kind: "bad_request", message: `Request failed (${res.status})` } };
      return { ok: true, data: (await res.json()) as T };
    } catch (e) {
      return { ok: false, error: { kind: "offline", message: e instanceof Error ? e.message : "Network error" } };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ping: () => call("/api/ext/ping"),
    context: (slug) => call(`/api/ext/context?slug=${encodeURIComponent(slug)}`),
    session: (id) => call(`/api/ext/sessions/${encodeURIComponent(id)}`, undefined, true),
    sendEvents: (events) => call("/api/ext/events", { method: "POST", body: JSON.stringify({ events }) }),
    importList: (list) => call("/api/ext/lists", { method: "POST", body: JSON.stringify({ list }) }),
  };
}
