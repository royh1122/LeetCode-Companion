"use client";

import { Button } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg rounded-lg border border-border bg-surface p-6">
      <h1 className="text-base font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">{error.message || "Unexpected error."} Your data was not changed by this error.</p>
      <p className="mt-1 text-xs text-subtle">Details are in the terminal running the dashboard.</p>
      <Button className="mt-4" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
