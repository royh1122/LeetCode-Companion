import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function pct(x: number | null | undefined, digits = 0) {
  return x == null ? "—" : `${(x * 100).toFixed(digits)}%`;
}

export function relativeTime(ms: number | null | undefined, now = Date.now()) {
  if (ms == null) return "never";
  const diff = now - ms;
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return diff > 0 ? `${m}m ago` : `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return diff > 0 ? `${h}h ago` : `in ${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return diff > 0 ? `${d}d ago` : `in ${d}d`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(ms: number | null | undefined, timeZone?: string) {
  if (ms == null) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(ms);
}
