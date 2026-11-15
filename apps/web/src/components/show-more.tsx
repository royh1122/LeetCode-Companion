import Link from "next/link";

/** Long lists show the first `limit` rows; this says so and links to more (keeping the filters). */
export function ShowMore({ shown, total, step, params, path }: { shown: number; total: number | null; step: number; params: Record<string, string | undefined>; path: string }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v && k !== "limit") q.set(k, v);
  q.set("limit", String(shown + step));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted">
      <span>{total != null ? `Showing ${shown} of ${total}.` : `Showing the newest ${shown}.`}</span>
      <Link href={`${path}?${q}`} scroll={false} className="text-accent hover:underline">
        Show {step} more
      </Link>
    </div>
  );
}

/** The `limit` search parameter, kept within sensible bounds. */
export function limitParam(raw: string | undefined, fallback: number, max = 5000): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
