/** Minimal async key-value store so the controller can run on chrome.storage or in tests. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(values: Record<string, unknown>): Promise<void>;
}

export class MemoryKV implements KV {
  data = new Map<string, unknown>();
  async get<T>(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set(values: Record<string, unknown>) {
    for (const [k, v] of Object.entries(values)) this.data.set(k, structuredClone(v));
  }
}

export function chromeKV(area: chrome.storage.StorageArea): KV {
  return {
    async get<T>(key: string) {
      const r = await area.get(key);
      return r[key] as T | undefined;
    },
    async set(values) {
      await area.set(values);
    },
  };
}
