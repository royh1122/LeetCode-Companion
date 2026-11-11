import { NextResponse } from "next/server";
import { exportAll } from "@lcc/db";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET() {
  const data = exportAll(db());
  const name = `leetcode-companion-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
}
