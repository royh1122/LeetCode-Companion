import { NextResponse } from "next/server";
import { requireExtension } from "@/lib/ext-auth";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const denied = requireExtension(req);
  if (denied) return denied;
  return NextResponse.json({ ok: true, serverTime: Date.now() });
}
