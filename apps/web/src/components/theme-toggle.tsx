"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { onRadioGroupKeyDown, radioTabIndex } from "@/lib/radio";
import { cn } from "@/lib/utils";

type Mode = "light" | "dark" | "system";
const KEY = "lcc-theme";

function apply(mode: Mode) {
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function stored(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage unavailable
  }
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    setMode(stored());
  }, []);
  useEffect(() => {
    // "System" follows the OS while the page is open.
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onOs = () => mode === "system" && apply("system");
    mq.addEventListener("change", onOs);
    // A choice made in another tab applies here too.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY && e.key !== null) return;
      const m = stored();
      setMode(m);
      apply(m);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      mq.removeEventListener("change", onOs);
      window.removeEventListener("storage", onStorage);
    };
  }, [mode]);
  const set = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable */
    }
    apply(m);
  };
  const opts: { m: Mode; icon: React.ReactNode; label: string }[] = [
    { m: "light", icon: <Sun className="size-3.5" />, label: "Light theme" },
    { m: "system", icon: <Monitor className="size-3.5" />, label: "System theme" },
    { m: "dark", icon: <Moon className="size-3.5" />, label: "Dark theme" },
  ];
  const checked = opts.findIndex((o) => o.m === mode);
  return (
    <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Theme" onKeyDown={onRadioGroupKeyDown}>
      {opts.map((o, i) => (
        <button
          type="button"
          key={o.m}
          role="radio"
          aria-checked={mode === o.m}
          tabIndex={radioTabIndex(i, checked)}
          aria-label={o.label}
          title={o.label}
          onClick={() => set(o.m)}
          className={cn("flex flex-1 items-center justify-center rounded py-1 text-muted", mode === o.m && "bg-surface-2 text-fg")}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
