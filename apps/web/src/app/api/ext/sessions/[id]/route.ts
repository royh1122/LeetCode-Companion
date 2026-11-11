import { NextResponse } from "next/server";
import { getExtensionSessionState } from "@lcc/db";
import { requireExtension } from "@/lib/ext-auth";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireExtension(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const s = getExtensionSessionState(db(), id);
  if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(s, { headers: { "Cache-Control": "no-store" } });
}
