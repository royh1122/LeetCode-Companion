import "server-only";
import { NextResponse } from "next/server";
import { touchExtensionSeen, verifyExtensionToken } from "@lcc/db";
import { db } from "./server";

/** Returns an error response if the request isn't from the paired extension. */
export function requireExtension(req: Request): NextResponse | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!verifyExtensionToken(db(), token)) {
    return NextResponse.json({ error: "unauthorized", hint: "Pair the extension: copy the token from Settings → Browser extension." }, { status: 401 });
  }
  touchExtensionSeen(db(), { version: req.headers.get("x-lcc-version") ?? undefined });
  return null;
}

export function dashboardUrl(req: Request) {
  const host = req.headers.get("host") ?? "127.0.0.1:4317";
  return `http://${host}`;
}
