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

/** Talks only to the dashboard this browser is paired with. Never to any third party. */
export function httpApi(getConfig: () => Promise<ApiConfig>, fetchImpl: typeof fetch = fetch): Api {
  async function call<T>(path: string, init?: RequestInit, notFoundIsNull = false): Promise<ApiResult<T>> {
    const cfg = await getConfig();
    if (!cfg.token) return { ok: false, error: { kind: "unauthorized", message: "Not paired: pair this browser in the extension options." } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchImpl(`${cfg.serverUrl.replace(/\/+$/, "")}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}`, "X-LCC-Version": cfg.version, ...(init?.headers ?? {}) },
      });
      if (res.status === 401) return { ok: false, error: { kind: "unauthorized", message: "The dashboard doesn't recognise this browser (it was removed or never paired). Pair it again in the extension options." } };
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

export type PairResult = { ok: true; token: string; deviceId: string; name: string } | { ok: false; message: string };

/**
 * Swaps a one-time pairing code (dashboard: Settings → Devices → Add a device) for this browser's
 * own key. The only request made without a key.
 */
export async function pairWithDashboard(serverUrl: string, code: string, name: string, version: string, fetchImpl: typeof fetch = fetch): Promise<PairResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(`${serverUrl.replace(/\/+$/, "")}/api/ext/pair`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "X-LCC-Version": version },
      body: JSON.stringify({ code, name }),
    });
    const body = (await res.json().catch(() => null)) as { token?: string; deviceId?: string; name?: string; hint?: string } | null;
    if (res.ok && body?.token && body.deviceId) return { ok: true, token: body.token, deviceId: body.deviceId, name: body.name ?? name };
    if (res.status === 401 || res.status === 400) return { ok: false, message: body?.hint ?? "The dashboard refused the pairing code." };
    if (res.status === 403) return { ok: false, message: "The dashboard refused this address. If it runs on another computer, its server mode must list this address (docs/SERVER_MODE.md)." };
    if (res.status === 404) return { ok: false, message: "That address answered, but it is not a LeetCode Companion dashboard of this version (no pairing endpoint)." };
    return { ok: false, message: `Pairing failed (${res.status}).` };
  } catch (e) {
    return { ok: false, message: `Can't reach the dashboard at ${serverUrl} (${e instanceof Error ? e.message : "network error"}). Check the address and that the dashboard is running.` };
  } finally {
    clearTimeout(timer);
  }
}
