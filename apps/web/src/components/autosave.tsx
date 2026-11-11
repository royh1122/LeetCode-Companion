"use client";

import { useEffect, useRef, useState } from "react";
import { saveProblemNotes, saveSessionNotes } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { Textarea } from "./ui";

type SaveFn = (value: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * Textarea that autosaves after a short pause and on blur. Shows honest status:
 * "Saving…", "Saved", or "Not saved — retrying". Unsaved text stays in the box.
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
  const [status, setStatus] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const lastSaved = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    const v = latest.current;
    if (v === lastSaved.current) return;
    setStatus("saving");
    try {
      const r = await save(v);
      if (r.ok) {
        lastSaved.current = v;
        setStatus(latest.current === v ? "saved" : "dirty");
      } else {
        setStatus("error");
        timer.current = setTimeout(flush, 5000);
      }
    } catch {
      setStatus("error");
      timer.current = setTimeout(flush, 5000);
    }
  };

  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (latest.current !== lastSaved.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

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
          setStatus("dirty");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, 800);
        }}
        onBlur={flush}
      />
      {!label ? (
        <div className="flex justify-end">
          <SaveStatus status={status} />
        </div>
      ) : null}
    </div>
  );
}

export function SaveStatus({ status }: { status: "idle" | "dirty" | "saving" | "saved" | "error" }) {
  const text = { idle: "", dirty: "Unsaved", saving: "Saving…", saved: "Saved", error: "Not saved — retrying" }[status];
  return <span className={cn("text-[11px]", status === "error" ? "text-bad" : "text-subtle")} aria-live="polite">{text}</span>;
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
      save={(v) => saveSessionNotes(props.sessionId, { [props.field]: v })}
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
      save={(v) => saveProblemNotes(props.problemId, { [props.field]: v })}
    />
  );
}
