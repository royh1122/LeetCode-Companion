"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Polls the database revision counter and refreshes server components when it
 * changes (e.g. the extension synced a submission). One tiny JSON GET every few seconds.
 */
export function LiveRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  const last = useRef<number | null>(null);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/revision", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { revision: number; extensionLastSeen: number | null };
        if (last.current != null && j.revision !== last.current && !stopped) router.refresh();
        last.current = j.revision;
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
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [router, intervalMs]);
  return null;
}
