import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg rounded-lg border border-border bg-surface p-6">
      <h1 className="text-base font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">That question or session doesn&apos;t exist in your local database.</p>
      <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">
        Back to today
      </Link>
    </div>
  );
}
