"use client";

import { BarChart3, BookOpen, CalendarRange, History, ListTodo, Menu, RefreshCcw, Settings, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ExtensionStatus } from "./extension-status";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/", label: "Today", icon: ListTodo },
  { href: "/reviews", label: "Review queue", icon: RefreshCcw },
  { href: "/plan", label: "Study plan", icon: CalendarRange },
  { href: "/library", label: "Question library", icon: BookOpen },
  { href: "/history", label: "History", icon: History },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // Wide screens always show the sidebar; narrow ones slide it in. Assume wide until measured
  // (matches the server render, and nothing is hidden from keyboards by mistake).
  const [narrow, setNarrow] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767.98px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open) return;
    // Opening moves focus into the menu; Escape closes it and returns focus to the toggle.
    navRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const isActive = (href: string) => (href === "/" ? path === "/" || path.startsWith("/sessions") : path.startsWith(href));
  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls="main-nav"
        className="fixed left-3 top-3 z-40 rounded-md border border-border bg-surface p-1.5 md:hidden"
        aria-label={open ? "Close navigation" : "Open navigation"}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <X className="size-4" /> : <Menu className="size-4" />}
      </button>
      <aside
        id="main-nav"
        ref={navRef}
        // Off-screen on a narrow screen: keep it out of the tab order and away from screen readers.
        inert={narrow && !open}
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-56 shrink-0 flex-col border-r border-border bg-surface transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2 pl-14 pr-4 md:pl-4">
          <div className="grid size-6 place-items-center rounded-md bg-accent font-mono text-[11px] font-bold text-accent-fg">lc</div>
          <span className="text-sm font-semibold tracking-tight">LeetCode Companion</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-2" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              aria-current={isActive(href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                isActive(href) ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="space-y-2 border-t border-border p-3">
          <ExtensionStatus />
          <ThemeToggle />
        </div>
      </aside>
      {/* A backdrop for pointer users; keyboard users press Escape or the toggle button. */}
      {open ? <div className="fixed inset-0 z-20 bg-black/30 md:hidden" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
    </>
  );
}
