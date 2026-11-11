import { NextResponse } from "next/server";
import { getAppSettings, getExtensionContext, recommendNextReview } from "@lcc/db";
import { OUTCOMES, toLocalDate } from "@lcc/shared";
import { dashboardUrl, requireExtension } from "@/lib/ext-auth";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const denied = requireExtension(req);
  if (denied) return denied;
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  const d = db();
  const ctx = getExtensionContext(d, slug, dashboardUrl(req));
  let recommendations: Record<string, string> | null = null;
  if (ctx.problem) {
    const today = toLocalDate(Date.now(), getAppSettings(d).timeZone);
    recommendations = Object.fromEntries(OUTCOMES.map((o) => [o, recommendNextReview(d, ctx.problem!.id, o, today).date]));
  }
  return NextResponse.json({ ...ctx, recommendations }, { headers: { "Cache-Control": "no-store" } });
}
