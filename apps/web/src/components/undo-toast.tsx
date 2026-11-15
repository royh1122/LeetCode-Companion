"use client";

import { Undo2, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { undoAction } from "@/lib/actions";
import { Button } from "./ui";

const EVENT = "lcc:undo";
type Offer = { token: string; label: string };

/** After a reschedule, skip, postpone or queue removal: show "<label> · Undo" at the bottom of the page. */
export function offerUndo(token: string | undefined, label: string) {
  if (token) window.dispatchEvent(new CustomEvent<Offer>(EVENT, { detail: { token, label } }));
}

const SHOW_MS = 12_000;

export function UndoToast() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const on = (e: Event) => {
      setMsg(null);
      setOffer((e as CustomEvent<Offer>).detail);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (!offer && !msg) return;
    const t = setTimeout(() => {
      setOffer(null);
      setMsg(null);
    }, SHOW_MS);
    return () => clearTimeout(t);
  }, [offer, msg]);
  if (!offer && !msg) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm shadow-lg">
      <span>{msg ?? offer?.label}</span>
      {offer && !msg ? (
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await undoAction(offer.token);
              setOffer(null);
              setMsg(r.ok ? "Undone." : r.error);
            })
          }
        >
          <Undo2 /> Undo
        </Button>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => {
          setOffer(null);
          setMsg(null);
        }}
      >
        <X />
      </Button>
    </div>
  );
}
