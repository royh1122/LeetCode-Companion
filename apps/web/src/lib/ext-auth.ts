import "server-only";
import { NextResponse } from "next/server";
import { touchExtensionSeen, verifyExtensionToken } from "@lcc/db";
import { effectiveBaseUrl } from "@lcc/shared";
import { db } from "./server";
import { serverConfig } from "./server-mode";

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

/** The dashboard's address as the caller reached it (forwarded values only from an allowed proxy). */
export function dashboardUrl(req: Request) {
  const h = req.headers;
  return effectiveBaseUrl(h.get("host") ?? "", h.get("x-forwarded-host"), h.get("x-forwarded-proto"), serverConfig());
}
