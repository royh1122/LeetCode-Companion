const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields of `next` that differ from `base`. With `deep`, nested objects are compared field by
 * field (arrays always count as one value). Forms send only this, so a form loaded before
 * another tab saved can't put back values it never touched.
 */
export function changedFields<T extends Record<string, unknown>>(base: T, next: T, deep = false): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next)) {
    const a = base[k];
    const b = next[k];
    if (same(a, b)) continue;
    if (deep && isPlainObject(a) && isPlainObject(b)) {
      const inner = changedFields(a, b, true);
      if (Object.keys(inner).length) out[k] = inner;
    } else out[k] = b;
  }
  return out as Partial<T>;
}

/** `patch` laid over `base`, merging nested objects (the reverse of `changedFields(…, true)`). */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out as T;
}
