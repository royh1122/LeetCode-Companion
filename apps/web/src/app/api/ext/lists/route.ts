import { NextResponse } from "next/server";
import { importList, parseListObject } from "@lcc/db";
import { requireExtension } from "@/lib/ext-auth";
import { db, log } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Imports a study list the extension saw on a LeetCode study-plan page,
 * after the user clicked Import in the side panel. History is never touched.
 */
export async function POST(req: Request) {
  const denied = requireExtension(req);
  if (denied) return denied;
  let list;
  try {
    list = parseListObject(((await req.json()) as { list?: unknown })?.list);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid list" }, { status: 400 });
  }
  try {
    return NextResponse.json(importList(db(), list));
  } catch (e) {
    log("list import failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
