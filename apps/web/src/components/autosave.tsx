"use client";

import { useEffect, useRef, useState } from "react";
import { saveProblemNotes, saveSessionNotes } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { Button, Textarea } from "./ui";

/**
 * Saves `value`. `base` is the text this editor last saw stored; when the stored text has
 * changed since, the save is refused and the stored text comes back as `conflict`.
 */
type SaveFn = (value: string, base: string) => Promise<{ ok: boolean; error?: string; conflict?: string }>;
type Status = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

/**
 * Textarea that autosaves after a short pause, on blur and when it leaves the page. Shows honest
 * status: "Saving…", "Saved", or "Not saved — retrying". Unsaved text stays in the box.
 *
 * The same text can be edited elsewhere (another tab, the extension's side panel). While this
 * box has no unsaved edits it follows the stored text; with unsaved edits it never overwrites a
 * newer stored version without asking.
 */
export function AutosaveTextarea({
  initial,
  save,
  placeholder,
  rows = 3,
  className,
  label,
  id,
  maxLength,
}: {
  initial: string;
  save: SaveFn;
  placeholder?: string;
  rows?: number;
  className?: string;
  label?: string;
  id?: string;
  /** The server's limit for this field, so over-long text can't be typed and then fail to save. */
  maxLength: number;
}) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<Status>("idle");
  /** The stored text a save was refused for, while the user decides which version to keep. */
  const [conflict, setConflict] = useState<string | null>(null);
  const lastSaved = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const saveRef = useRef(save);
  saveRef.current = save;
  const inConflict = useRef(false);
  inConflict.current = conflict !== null;
  /** Text this box saved itself: a page refresh that was already under way may still deliver it. */
  const ownSaves = useRef<string[]>([]);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    const v = latest.current;
    if (v === lastSaved.current) return;
    setStatus("saving");
    try {
      const r = await saveRef.current(v, lastSaved.current);
      if (r.ok) {
        lastSaved.current = v;
        ownSaves.current = [...ownSaves.current.slice(-19), v];
        setConflict(null);
        setStatus(latest.current === v ? "saved" : "dirty");
      } else if (r.conflict !== undefined) {
        setConflict(r.conflict);
        setStatus("conflict");
      } else {
        setStatus("error");
        timer.current = setTimeout(flush, 5000);
      }
    } catch {
      setStatus("error");
      timer.current = setTimeout(flush, 5000);
    }
  };

  // The stored text changed (the page refreshed after another tab or the extension saved it).
  // Follow it only while there is nothing unsaved here; unsaved text is settled when it is saved.
  const seenInitial = useRef(initial);
  useEffect(() => {
    if (initial === seenInitial.current) return;
    seenInitial.current = initial;
    if (initial === lastSaved.current || latest.current !== lastSaved.current) return;
    if (ownSaves.current.includes(initial)) return; // an older refresh catching up with our own save
    lastSaved.current = initial;
    latest.current = initial;
    setValue(initial);
    setStatus("idle");
  }, [initial]);

  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (latest.current !== lastSaved.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
      if (timer.current) clearTimeout(timer.current);
      // Leaving the page (in-app navigation) before the pause elapsed: save now, don't drop it.
      if (latest.current !== lastSaved.current && !inConflict.current) void saveRef.current(latest.current, lastSaved.current).catch(() => undefined);
    };
  }, []);

  const keepMine = () => {
    if (conflict === null) return;
    lastSaved.current = conflict; // the other version has been seen; saving over it is now deliberate
    setConflict(null);
    void flush();
  };
  const takeOther = () => {
    if (conflict === null) return;
    if (timer.current) clearTimeout(timer.current);
    lastSaved.current = conflict;
    latest.current = conflict;
    setValue(conflict);
    setConflict(null);
    setStatus("idle");
  };

  return (
    <div className={cn("space-y-1", className)}>
      {label ? (
        <div className="flex items-center justify-between">
          <label htmlFor={id} className="text-xs font-medium text-muted">
            {label}
          </label>
          <SaveStatus status={status} />
        </div>
      ) : null}
      <Textarea
        id={id}
        rows={rows}
        maxLength={maxLength}
        // One-line fields (e.g. complexity) stay one line tall and read as code.
        className={rows === 1 ? "min-h-0 resize-none font-mono" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus(conflict !== null ? "conflict" : "dirty");
          if (timer.current) clearTimeout(timer.current);
          if (conflict === null) timer.current = setTimeout(flush, 800);
        }}
        onBlur={() => {
          if (conflict === null) void flush();
        }}
      />
      {!label ? (
        <div className="flex justify-end">
          <SaveStatus status={status} />
        </div>
      ) : null}
      {conflict !== null ? (
        <div role="alert" className="space-y-1.5 rounded-md border border-border bg-surface-2 p-2 text-xs">
          <div className="font-medium">This text was changed somewhere else (another tab or the extension). Yours is not saved yet.</div>
          <div className="text-muted">The other version:</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-1.5 font-sans">{conflict || "(empty)"}</pre>
          <div className="flex gap-2">
            <Button size="sm" onClick={keepMine}>
              Keep mine
            </Button>
            <Button size="sm" onClick={takeOther}>
              Use the other version
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SaveStatus({ status }: { status: Status }) {
  const text = { idle: "", dirty: "Unsaved", saving: "Saving…", saved: "Saved", error: "Not saved — retrying", conflict: "Not saved — changed elsewhere" }[status];
  return <span className={cn("text-[11px]", status === "error" || status === "conflict" ? "text-bad" : "text-subtle")} aria-live="polite">{text}</span>;
}

export function SessionNoteField(props: { sessionId: string; field: "notes" | "struggles" | "takeaway" | "mistakes" | "timeComplexity" | "spaceComplexity"; initial: string; label?: string; placeholder?: string; rows?: number }) {
  return (
    <AutosaveTextarea
      id={`s-${props.field}`}
      label={props.label}
      initial={props.initial}
      rows={props.rows}
      placeholder={props.placeholder}
      maxLength={props.field === "notes" ? 20000 : props.field.endsWith("Complexity") ? 200 : 5000}
      save={async (v, base) => {
        const r = await saveSessionNotes(props.sessionId, { [props.field]: v }, { [props.field]: base });
        return r.ok ? r : { ...r, conflict: "conflicts" in r ? r.conflicts?.[props.field] : undefined };
      }}
    />
  );
}

export function ProblemNoteField(props: { problemId: number; field: string; initial: string; label: string; placeholder?: string; rows?: number }) {
  return (
    <AutosaveTextarea
      id={`n-${props.field}`}
      label={props.label}
      initial={props.initial}
      rows={props.rows}
      placeholder={props.placeholder}
      maxLength={50000}
      save={async (v, base) => {
        const r = await saveProblemNotes(props.problemId, { [props.field]: v }, { [props.field]: base });
        return r.ok ? r : { ...r, conflict: "conflicts" in r ? r.conflicts?.[props.field] : undefined };
      }}
    />
  );
}
