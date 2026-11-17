import "server-only";
import { NextResponse } from "next/server";
import { touchDevice, verifyDeviceToken, type Device } from "@lcc/db";
import { effectiveBaseUrl } from "@lcc/shared";
import { db } from "./server";
import { serverConfig } from "./server-mode";

const UNPAIRED_HINT = "This browser isn't paired, or was removed in Settings → Devices. Pair it again: Settings → Devices → Add a device, then enter the code in the extension's options.";

/** The paired device making this request (and records that it was seen), or the 401 to return. */
export function authExtension(req: Request): { device: Device } | { denied: NextResponse } {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const d = db();
  const device = verifyDeviceToken(d, token);
  if (!device) return { denied: NextResponse.json({ error: "unauthorized", hint: UNPAIRED_HINT }, { status: 401 }) };
  touchDevice(d, device.id, { version: req.headers.get("x-lcc-version") ?? undefined });
  return { device };
}

/** Returns an error response if the request isn't from a paired extension. */
export function requireExtension(req: Request): NextResponse | null {
  const r = authExtension(req);
  return "denied" in r ? r.denied : null;
}

/** The dashboard's address as the caller reached it (forwarded values only from an allowed proxy). */
export function dashboardUrl(req: Request) {
  const h = req.headers;
  return effectiveBaseUrl(h.get("host") ?? "", h.get("x-forwarded-host"), h.get("x-forwarded-proto"), serverConfig());
}
