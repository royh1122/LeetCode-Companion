"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn, relativeTime } from "@/lib/utils";

/** Whether the paired extension has talked to the server recently. Never claims more than it knows. */
export function ExtensionStatus() {
  const [state, setState] = useState<{ online: boolean; seen?: number | null }>({ online: true });
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ online: boolean; extensionLastSeen?: number | null }>).detail;
      setState({ online: d.online, seen: d.online ? (d.extensionLastSeen ?? null) : undefined });
    };
    window.addEventListener("lcc:status", on);
    return () => window.removeEventListener("lcc:status", on);
  }, []);
  const { online, seen } = state;
  const recent = seen != null && Date.now() - seen < 5 * 60_000;
  const label = !online
    ? "Dashboard server unreachable"
    : seen === undefined
      ? "Checking extension…"
      : seen === null
        ? "Extension not connected yet"
        : recent
          ? "Extension connected"
          : `Extension last seen ${relativeTime(seen)}`;
  return (
    <Link href="/settings#extension" className="flex items-center gap-2 rounded-md px-1 py-1 text-xs text-muted hover:text-fg">
      <span className={cn("size-2 shrink-0 rounded-full", !online ? "bg-bad" : recent ? "bg-good" : "bg-surface-3 ring-1 ring-border-strong")} aria-hidden />
      {label}
    </Link>
  );
}
