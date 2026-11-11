import { NextResponse } from "next/server";
import { getExtensionLastSeen, getRevision } from "@lcc/db";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET() {
  const d = db();
  return NextResponse.json({ revision: getRevision(d), extensionLastSeen: getExtensionLastSeen(d)?.at ?? null }, { headers: { "Cache-Control": "no-store" } });
}
