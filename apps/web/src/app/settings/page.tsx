import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { backupDir, defaultDbPath, getAppSettings, getExtensionLastSeen, getExtensionToken, listUnattributed, recentSyncEvents } from "@lcc/db";
import { VerdictBadge } from "@/components/badges";
import { DataControls, GeneralSettingsForm, TokenBox } from "@/components/settings-forms";
import { timeZoneGroups } from "@/lib/timezones";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/lib/server";
import { formatDateTime, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default function SettingsPage() {
  const d = db();
  const settings = getAppSettings(d);
  const token = getExtensionToken(d);
  const seen = getExtensionLastSeen(d);
  const events = recentSyncEvents(d, 25);
  const unattributed = listUnattributed(d);
  let backups: string[] = [];
  try {
    backups = fs
      .readdirSync(backupDir())
      .filter((f) => f.endsWith(".db"))
      .sort()
      .reverse()
      .slice(0, 8);
  } catch {
    backups = [];
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />

      <Card id="extension">
        <CardHeader
          title="Browser extension"
          description="The extension observes your own LeetCode activity and syncs it here. It authenticates with this token; nothing is sent anywhere else."
          actions={seen ? <Badge tone={Date.now() - seen.at < 5 * 60_000 ? "good" : "neutral"}>Last seen {relativeTime(seen.at)}</Badge> : <Badge tone="neutral">Never connected</Badge>}
        />
        <div className="space-y-3 p-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>
              Build it: <code className="rounded bg-surface-2 px-1 font-mono text-xs">npm run ext:build</code>, then load <code className="rounded bg-surface-2 px-1 font-mono text-xs">apps/extension/dist</code> at chrome://extensions (Developer mode → Load unpacked).
            </li>
            <li>Open the extension&apos;s options, keep the server URL as http://127.0.0.1:4317 and paste this token.</li>
          </ol>
          <TokenBox token={token} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Scheduling, timing & mastery" />
        <div className="p-4">
          <GeneralSettingsForm settings={settings} timeZones={timeZoneGroups(settings.timeZone)} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Your data" description="Everything is stored locally in SQLite. Imports merge and never overwrite existing history." />
        <div className="space-y-4 p-4 text-sm">
          <DataControls />
          <div className="text-xs text-muted">
            <div>
              Database: <code className="font-mono">{defaultDbPath()}</code>
            </div>
            <div>
              Backups: <code className="font-mono">{backupDir()}</code> (also taken automatically before migrations and imports)
            </div>
            {backups.length ? (
              <ul className="mt-1 list-disc pl-5">
                {backups.map((b) => (
                  <li key={b} className="font-mono">
                    {path.basename(b)}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-1">
              Restore: stop the dashboard, then run <code className="font-mono">npm run db:restore -- &lt;backup file&gt;</code>.
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={`Unlinked submissions (${unattributed.length})`} description="Captured submissions whose session couldn't be determined with confidence. Link them from the question page." />
        {unattributed.length ? (
          <ul className="divide-y divide-border text-xs">
            {unattributed.slice(0, 30).map(({ submission: s, problem: p }) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2">
                <VerdictBadge v={s.verdict} />
                <Link href={`/problems/${p.slug}`} className="hover:underline">
                  {p.title}
                </Link>
                <span className="text-muted">{formatDateTime(s.submittedAt, settings.timeZone)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-xs text-muted">None.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Sync log" description="The most recent events received from the extension (code is not duplicated here)." />
        {events.length ? (
          <ul className="divide-y divide-border font-mono text-[11px]">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-1.5">
                <span className="text-muted">{formatDateTime(e.receivedAt, settings.timeZone)}</span>
                <span>{e.type}</span>
                <Badge tone={e.status === "processed" ? "good" : "bad"}>{e.status}</Badge>
                {e.error ? <span className="text-bad">{e.error}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-xs text-muted">No events yet.</p>
        )}
      </Card>
    </div>
  );
}
