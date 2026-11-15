"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** How long a newly seen revision may wait for a server action's own re-render before we refresh. */
const GRACE_MS = 1500;

/**
 * Polls the database revision counter and refreshes server components when it
 * changes (e.g. the extension synced a submission). One tiny JSON GET every few seconds.
 *
 * `revision` is the one the current render was made from (the layout reads it per request).
 * A server action re-renders the page itself, with the new revision; a poll that sees the new
 * revision first waits GRACE_MS for that render instead of refreshing a second time.
 */
export function LiveRefresh({ revision, intervalMs = 3000 }: { revision: number; intervalMs?: number }) {
  const router = useRouter();
  const shown = useRef(revision);
  const seen = useRef(revision);
  useEffect(() => {
    shown.current = revision;
  }, [revision]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/revision", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { revision: number; extensionLastSeen: number | null };
        seen.current = j.revision;
        if (j.revision !== shown.current && !timer && !stopped) {
          timer = setTimeout(() => {
            timer = null;
            if (stopped || seen.current === shown.current) return; // an action's render caught up
            shown.current = seen.current;
            router.refresh();
          }, GRACE_MS);
        }
        window.dispatchEvent(new CustomEvent("lcc:status", { detail: { online: true, extensionLastSeen: j.extensionLastSeen } }));
      } catch {
        window.dispatchEvent(new CustomEvent("lcc:status", { detail: { online: false } }));
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(id);
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [router, intervalMs]);
  return null;
}
