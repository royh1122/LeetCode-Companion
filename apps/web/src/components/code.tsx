"use client";

import { diffLines } from "diff";
import hljs from "highlight.js/lib/core";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import kotlin from "highlight.js/lib/languages/kotlin";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import plaintext from "highlight.js/lib/languages/plaintext";
import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { highlightLanguage } from "@lcc/shared";
import { cn } from "@/lib/utils";
import { Button, Select } from "./ui";

for (const [n, l] of Object.entries({ c, cpp, csharp, go, java, javascript, kotlin, python, rust, swift, typescript, plaintext })) hljs.registerLanguage(n, l);

/** highlight.js escapes HTML in the source, so the output is safe to inject. Captured code is never executed. */
function highlightToLines(code: string, lang: string): string[] {
  const language = hljs.getLanguage(lang) ? lang : "plaintext";
  const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  // Re-balance spans across line breaks so each line renders independently.
  const out: string[] = [];
  let open: string[] = [];
  for (const raw of html.split("\n")) {
    let line = open.join("") + raw;
    const re = /<span[^>]*>|<\/span>/g;
    let m: RegExpExecArray | null;
    const stack = [...open];
    while ((m = re.exec(raw))) {
      if (m[0] === "</span>") stack.pop();
      else stack.push(m[0]);
    }
    line += "</span>".repeat(stack.length);
    open = stack;
    out.push(line);
  }
  return out;
}

export function CopyButton({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

export function CodeBlock({ code, lang, maxHeight = 480, header }: { code: string; lang: string | null; maxHeight?: number; header?: React.ReactNode }) {
  const lines = useMemo(() => highlightToLines(code.replace(/\n+$/, ""), highlightLanguage(lang)), [code, lang]);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-muted">
        <span>{header ?? lang ?? "code"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-auto py-2 font-mono text-[12.5px] leading-[1.6]" style={{ maxHeight }}>
        <code className="hljs grid">
          {lines.map((l, i) => (
            <span key={i} className="flex">
              <span className="tabular w-10 shrink-0 select-none pr-3 text-right text-subtle">{i + 1}</span>
              <span className="whitespace-pre pr-4" dangerouslySetInnerHTML={{ __html: l || " " }} />
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export interface CodeVersion {
  id: number;
  label: string;
  code: string;
  lang: string | null;
}

/** Line diff between two captured code versions. */
export function CodeDiff({ versions, defaultA, defaultB }: { versions: CodeVersion[]; defaultA?: number; defaultB?: number }) {
  const [a, setA] = useState(defaultA ?? versions[0]?.id);
  const [b, setB] = useState(defaultB ?? versions[versions.length - 1]?.id);
  const va = versions.find((v) => v.id === a);
  const vb = versions.find((v) => v.id === b);
  const parts = useMemo(() => (va && vb ? diffLines(va.code, vb.code) : []), [va, vb]);
  if (versions.length < 2) return <p className="text-xs text-muted">Capture at least two code versions to compare them.</p>;
  let ln = 0;
  let rn = 0;
  const added = parts.filter((p) => p.added).reduce((s, p) => s + (p.count ?? 0), 0);
  const removed = parts.filter((p) => p.removed).reduce((s, p) => s + (p.count ?? 0), 0);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select value={a} onChange={(e) => setA(Number(e.target.value))} aria-label="Older version" className="w-auto max-w-[320px]">
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </Select>
        <span className="text-muted">→</span>
        <Select value={b} onChange={(e) => setB(Number(e.target.value))} aria-label="Newer version" className="w-auto max-w-[320px]">
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </Select>
        <span className="tabular text-good">+{added}</span>
        <span className="tabular text-bad">−{removed}</span>
      </div>
      <pre className="max-h-[560px] overflow-auto rounded-md border border-border bg-surface-2 py-2 font-mono text-[12.5px] leading-[1.6]">
        {parts.flatMap((p, pi) =>
          (p.value.endsWith("\n") ? p.value.slice(0, -1) : p.value).split("\n").map((line, i) => {
            const l = p.added ? "" : ++ln;
            const r = p.removed ? "" : ++rn;
            return (
              <div key={`${pi}-${i}`} className={cn("flex", p.added && "bg-good-soft", p.removed && "bg-bad-soft")}>
                <span className="tabular w-9 shrink-0 select-none pr-2 text-right text-subtle">{l}</span>
                <span className="tabular w-9 shrink-0 select-none pr-2 text-right text-subtle">{r}</span>
                <span className={cn("w-4 shrink-0 select-none", p.added ? "text-good" : p.removed ? "text-bad" : "text-subtle")} aria-hidden>
                  {p.added ? "+" : p.removed ? "−" : " "}
                </span>
                <span className="whitespace-pre pr-4">{line || " "}</span>
              </div>
            );
          }),
        )}
      </pre>
    </div>
  );
}
