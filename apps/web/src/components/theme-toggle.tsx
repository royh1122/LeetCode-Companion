"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Mode = "light" | "dark" | "system";

function apply(mode: Mode) {
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    try {
      setMode((localStorage.getItem("lcc-theme") as Mode) || "system");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const set = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem("lcc-theme", m);
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
  return (
    <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <button
          key={o.m}
          role="radio"
          aria-checked={mode === o.m}
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
