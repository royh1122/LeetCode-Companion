"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { importBuiltInListAction, importListAction } from "@/lib/actions";
import { Button, Input, Label, Textarea } from "./ui";

export type BuiltInList = { slug: string; name: string; description: string | null; count: number; source: string | null; imported: boolean };

export function ImportListForm({ builtIns }: { builtIns: BuiltInList[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await importListAction({ name, text });
          if (!r.ok) return setMsg({ ok: false, text: r.error });
          setMsg({ ok: true, text: `Imported "${r.data.name}" (${r.data.count} questions).` });
          setName("");
          setText("");
          router.refresh();
        });
      }}
    >
      {builtIns.length ? (
        <div className="space-y-2">
          <Label>Ready-made lists</Label>
          {builtIns.map((b) => (
            <div key={b.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {b.name} <span className="text-xs font-normal text-subtle">({b.count})</span>
                </div>
                <p className="text-xs text-subtle">
                  {b.description}{" "}
                  {b.source ? (
                    <a href={b.source} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      Source
                    </a>
                  ) : null}
                </p>
              </div>
              <Button
                size="sm"
                variant={b.imported ? "ghost" : "secondary"}
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await importBuiltInListAction(b.slug);
                    setMsg(r.ok ? { ok: true, text: `Imported "${r.data.name}" (${r.data.count} questions).` } : { ok: false, text: r.error });
                    if (r.ok) router.refresh();
                  })
                }
              >
                {b.imported ? "Re-import" : "Import"}
              </Button>
            </div>
          ))}
          <p className="text-xs text-subtle">
            LeetCode&apos;s own lists (LeetCode 75, Top Interview 150, …) can&apos;t ship with the app. Open one on leetcode.com/studyplan with the extension installed, and the side panel offers to import it. Or paste your own below.
          </p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="list-name">List name</Label>
        <Input id="list-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="My interview list" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="list-text">Questions</Label>
        <Textarea
          id="list-text"
          rows={8}
          className="font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          placeholder={"# Arrays\nhttps://leetcode.com/problems/two-sum/\nvalid-anagram"}
        />
        <p className="text-xs text-subtle">
          One LeetCode problem link or slug per line, in the order you want to study them. A line starting with # names a group (used as the pattern). You can also paste a study-plan JSON file; the name is then optional. The extension fills in each
          problem&apos;s title and number when you practice it; difficulty comes only from lists that include it.
        </p>
        <p className="text-xs text-subtle">Importing under the name of an existing list replaces that list&apos;s questions. Your history is never touched.</p>
      </div>
      {msg ? (
        <p className={`text-xs ${msg.ok ? "text-good" : "text-bad"}`} role="status">
          {msg.text}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={pending}>
        Import list
      </Button>
    </form>
  );
}
