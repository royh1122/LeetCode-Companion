import { NextResponse, type NextRequest } from "next/server";
import { decideRequest } from "@lcc/shared";
import { serverConfig } from "./lib/server-mode";

/**
 * Security boundary: loopback only by default; server mode adds the configured hosts.
 * The rules themselves (and why) are in packages/shared/src/request-policy.ts.
 */
export function proxy(req: NextRequest) {
  const h = req.headers;
  const verdict = decideRequest(
    {
      host: h.get("host") ?? "",
      path: req.nextUrl.pathname,
      method: req.method,
      origin: h.get("origin"),
      secFetchSite: h.get("sec-fetch-site"),
      secFetchMode: h.get("sec-fetch-mode"),
      secFetchDest: h.get("sec-fetch-dest"),
      forwardedHost: h.get("x-forwarded-host"),
    },
    serverConfig(),
  );
  if (!verdict.allow) return new NextResponse(req.method === "OPTIONS" ? null : verdict.reason, { status: verdict.status });
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
