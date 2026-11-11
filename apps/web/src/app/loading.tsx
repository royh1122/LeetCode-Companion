export default function Loading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="Loading">
      <div className="h-6 w-56 rounded bg-surface-3" />
      <div className="h-4 w-80 rounded bg-surface-2" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-surface">
          <div className="h-12 border-b border-border" />
          {[0, 1, 2].map((j) => (
            <div key={j} className="flex items-center gap-3 px-4 py-3">
              <div className="size-5 rounded-full bg-surface-3" />
              <div className="h-4 flex-1 rounded bg-surface-2" />
              <div className="h-7 w-20 rounded bg-surface-2" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
