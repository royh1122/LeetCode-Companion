"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, useTransition } from "react";
import { updateSettingsAction } from "@/lib/actions";
import { Button } from "./ui";

/** Flips the app-wide "show patterns in lists" setting (also editable in Settings). */
export function PatternsToggle({ shown }: { shown: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      aria-pressed={shown}
      title={shown ? "Patterns are shown in lists. Hide them so they don't hint at the approach." : "Patterns are hidden so they don't hint at the approach. Show them."}
      onClick={() => start(async () => void (await updateSettingsAction({ showPatterns: !shown })))}
    >
      {shown ? <EyeOff /> : <Eye />}
      {shown ? "Hide patterns" : "Show patterns"}
    </Button>
  );
}

/** Hides spoiler content (patterns, tags) behind a click. Not recorded; just avoids an accidental peek. */
export function SpoilerReveal({ shown, label, children }: { shown: boolean; label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (shown || open) return <>{children}</>;
  return (
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
      <Eye className="size-3.5" /> {label}
    </button>
  );
}
