"use client";

import { Download, Upload } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import type { AppSettings } from "@lcc/shared";
import type { TimeZoneGroup } from "@/lib/timezones";
import { changedFields } from "@/lib/diff";
import { backupNowAction, importJsonAction, pruneBackupsAction, updateSettingsAction } from "@/lib/actions";
import { Button, Input, Label, Select } from "./ui";

/** Deletes old automatic backups after a confirmation. Manual backups stay. */
export function PruneBackupsButton({ automatic, keep = 20 }: { automatic: number; keep?: number }) {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (automatic <= keep) return msg ? <span className="text-xs text-good">{msg}</span> : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {confirm ? (
        <>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await pruneBackupsAction(keep);
                setMsg(r.ok ? `Deleted ${r.data.deleted} old automatic backup(s).` : `Not deleted: ${r.error}`);
                setConfirm(false);
              })
            }
          >
            Delete {automatic - keep} oldest automatic backup(s)
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
          Keep only the newest {keep} automatic backups…
        </Button>
      )}
      {msg ? <span className="text-xs">{msg}</span> : null}
    </span>
  );
}

/** Offers this computer's time zone when it differs from the saved one (client-only, to avoid hydration mismatch). */
function BrowserTimeZone({ current, onUse }: { current: string; onUse: (tz: string) => void }) {
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => {
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
  }, []);
  if (!tz || tz === current) return null;
  return (
    <button type="button" className="text-xs text-accent hover:underline" onClick={() => onUse(tz)}>
      Use this computer&apos;s time zone ({tz})
    </button>
  );
}

export function GeneralSettingsForm({ settings, timeZones }: { settings: AppSettings; timeZones: TimeZoneGroup[] }) {
  const [s, setS] = useState(settings);
  // What was last loaded or saved: only fields changed since then are sent.
  const [saved, setSaved] = useState(settings);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const num = (v: string) => Number(v);
  const bi = s.srs.baseIntervals;
  const setBase = (k: keyof typeof bi, v: number) => setS({ ...s, srs: { ...s.srs, baseIntervals: { ...bi, [k]: v } } });
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const patch = changedFields(saved, s, true);
        if (!Object.keys(patch).length) return setMsg({ ok: true, text: "Nothing changed" });
        start(async () => {
          const r = await updateSettingsAction(patch);
          if (r.ok) setSaved(s);
          setMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error });
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="tz">Time zone (study days follow this calendar)</Label>
          <Select id="tz" value={s.timeZone} onChange={(e) => setS({ ...s, timeZone: e.target.value })}>
            {/* A zone the server's list spells differently (e.g. Asia/Kolkata vs Asia/Calcutta) still shows. */}
            {timeZones.some((g) => g.zones.some((z) => z.id === s.timeZone)) ? null : <option value={s.timeZone}>{s.timeZone}</option>}
            {timeZones.map((g) => (
              <optgroup key={g.region} label={g.region}>
                {g.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <BrowserTimeZone current={s.timeZone} onUse={(tz) => setS({ ...s, timeZone: tz })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="idle">Idle threshold (seconds without input)</Label>
          <Input id="idle" type="number" min={30} max={3600} value={s.idleThresholdSec} onChange={(e) => setS({ ...s, idleThresholdSec: num(e.target.value) })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="stale">Flag sessions as interrupted after (hours)</Label>
          <Input id="stale" type="number" min={1} max={168} value={s.staleSessionHours} onChange={(e) => setS({ ...s, staleSessionHours: num(e.target.value) })} />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted">Spaced repetition — first interval per outcome (days)</legend>
        <div className="grid grid-cols-5 gap-2">
          {(["failed", "hints", "struggled", "independent", "easy"] as const).map((k) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={`bi-${k}`} className="capitalize">
                {k === "hints" ? "Needed hints" : k}
              </Label>
              <Input id={`bi-${k}`} type="number" min={1} max={365} value={bi[k]} onChange={(e) => setBase(k, num(e.target.value))} />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="im">Independent growth ×</Label>
            <Input id="im" type="number" step="0.1" min={1} max={5} value={s.srs.independentMultiplier} onChange={(e) => setS({ ...s, srs: { ...s.srs, independentMultiplier: num(e.target.value) } })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="em">Easy growth ×</Label>
            <Input id="em" type="number" step="0.1" min={1} max={6} value={s.srs.easyMultiplier} onChange={(e) => setS({ ...s, srs: { ...s.srs, easyMultiplier: num(e.target.value) } })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sf">Struggled shrink ×</Label>
            <Input id="sf" type="number" step="0.1" min={0.1} max={1} value={s.srs.struggledFactor} onChange={(e) => setS({ ...s, srs: { ...s.srs, struggledFactor: num(e.target.value) } })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mx">Max interval (days)</Label>
            <Input id="mx" type="number" min={7} max={3650} value={s.srs.maxIntervalDays} onChange={(e) => setS({ ...s, srs: { ...s.srs, maxIntervalDays: num(e.target.value) } })} />
          </div>
        </div>
        <p className="text-[11px] text-subtle">After repeated independent solves the interval multiplies (7 → 14 → 28 …). A failure resets the interval, not your history. Changes apply to future sessions and to any recomputation.</p>
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <legend className="mb-2 text-xs font-medium text-muted">Mastery rule</legend>
        <div className="space-y-1">
          <Label htmlFor="ms">Independent solves in a row</Label>
          <Input id="ms" type="number" min={1} max={10} value={s.mastery.masteryStreak} onChange={(e) => setS({ ...s, mastery: { ...s.mastery, masteryStreak: num(e.target.value) } })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mg">…last one after a gap of (days)</Label>
          <Input id="mg" type="number" min={0} max={365} value={s.mastery.masteryMinGapDays} onChange={(e) => setS({ ...s, mastery: { ...s.mastery, masteryMinGapDays: num(e.target.value) } })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="og">Overdue grace (days) before &quot;Needs review&quot;</Label>
          <Input id="og" type="number" min={0} max={60} value={s.mastery.overdueGraceDays} onChange={(e) => setS({ ...s, mastery: { ...s.mastery, overdueGraceDays: num(e.target.value) } })} />
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={s.showPatterns} onChange={(e) => setS({ ...s, showPatterns: e.target.checked })} className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          Show patterns in question lists
          <span className="block text-xs text-muted">Today, Study plan, Review queue and Library. Off by default, because the pattern hints at the approach. Problem pages hide them behind a click when this is off.</span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          Save settings
        </Button>
        {msg ? <span className={msg.ok ? "text-xs text-good" : "text-xs text-bad"}>{msg.text}</span> : null}
      </div>
    </form>
  );
}

export function DataControls() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href="/api/export" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2">
          <Download className="size-4" /> Export JSON
        </a>
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2">
          <Upload className="size-4" /> Import JSON
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              start(async () => {
                const text = await f.text();
                const r = await importJsonAction(text);
                if (r.ok) {
                  setMsg("Import finished (a backup was taken first).");
                  setReport(JSON.stringify(r.data, null, 2));
                } else setMsg(`Import failed: ${r.error}`);
              });
              e.target.value = "";
            }}
          />
        </label>
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await backupNowAction();
              setMsg(r.ok ? `Backup written to ${r.data}` : `Backup failed: ${r.error}`);
            })
          }
        >
          Back up database now
        </Button>
      </div>
      {msg ? <p className="text-xs text-muted">{msg}</p> : null}
      {report ? <pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-2 p-2 text-[11px]">{report}</pre> : null}
    </div>
  );
}
