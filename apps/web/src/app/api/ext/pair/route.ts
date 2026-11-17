import { NextResponse } from "next/server";
import { bumpRevision, redeemPairingCode } from "@lcc/db";
import { db, log } from "@/lib/server";

export const dynamic = "force-dynamic";

const REASONS = {
  "no-code": "No pairing code is waiting. Create one in the dashboard: Settings → Devices → Add a device.",
  expired: "That pairing code has expired. Create a new one in Settings → Devices.",
  invalid: "That pairing code is wrong. Check it and try again (after 5 wrong tries the code stops working).",
} as const;

/**
 * Swaps a one-time pairing code (Settings → Devices → Add a device) for this browser's own key.
 * Not bearer-protected (that is what it hands out), but still behind the /api/ext/* rules in the proxy.
 */
export async function POST(req: Request) {
  let body: { code?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body?.code !== "string" || body.code.length > 40) return NextResponse.json({ error: "invalid_request", hint: "Send { code, name }." }, { status: 400 });
  const d = db();
  const r = redeemPairingCode(d, body.code, body.name);
  if (!r.ok) {
    log(`pairing: refused (${r.reason})`);
    return NextResponse.json({ error: "pairing_failed", reason: r.reason, hint: REASONS[r.reason] }, { status: 401 });
  }
  bumpRevision(d); // the open Settings page shows the new device
  log(`pairing: added device "${r.name}"`);
  return NextResponse.json({ deviceId: r.deviceId, token: r.token, name: r.name }, { headers: { "Cache-Control": "no-store" } });
}
