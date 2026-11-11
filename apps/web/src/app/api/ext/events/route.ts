import { NextResponse } from "next/server";
import { processSyncEvents } from "@lcc/db";
import { syncBatchSchema } from "@lcc/shared";
import { requireExtension } from "@/lib/ext-auth";
import { db, log } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Idempotent batch ingestion. Each event is applied at most once (keyed by UUID). */
export async function POST(req: Request) {
  const denied = requireExtension(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const batch = syncBatchSchema.safeParse(body);
  if (!batch.success) return NextResponse.json({ error: "invalid batch" }, { status: 400 });
  try {
    const results = processSyncEvents(db(), batch.data.events, log);
    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length) log(`sync: ${rejected.length} event(s) rejected`, rejected);
    return NextResponse.json({ results });
  } catch (e) {
    log("sync: batch failed (will be retried by the extension)", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
