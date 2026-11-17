import path from "node:path";
import Link from "next/link";
import { headers } from "next/headers";
import { backupDir, dataDir, defaultDbPath, getAppSettings, getDevicesLastSeen, listBackups, listDevices, listUnattributed, recentSyncEvents } from "@lcc/db";
import { effectiveBaseUrl, SERVER_CONFIG_FILE, serverModeOn } from "@lcc/shared";
import { VerdictBadge } from "@/components/badges";
import { DevicesPanel } from "@/components/devices";
import { DataControls, GeneralSettingsForm, PruneBackupsButton } from "@/components/settings-forms";
import { serverConfig } from "@/lib/server-mode";
import { timeZoneGroups } from "@/lib/timezones";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/lib/server";
import { formatDateTime, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const SERVER_MODE_DOCS = "https://github.com/royh1122/LeetCode-Companion/blob/main/docs/SERVER_MODE.md";

export default async function SettingsPage() {
  const d = db();
  const settings = getAppSettings(d);
  const seen = getDevicesLastSeen(d);
  const devices = listDevices(d).map(({ id, name, lastSeenAt, lastVersion, createdAt }) => ({ id, name, lastSeenAt, lastVersion, createdAt }));
  const h = await headers();
  const server = serverConfig();
  const baseUrl = effectiveBaseUrl(h.get("host") ?? "", h.get("x-forwarded-host"), h.get("x-forwarded-proto"), server);
  const serverConfigFile = path.join(dataDir(), SERVER_CONFIG_FILE);
  const events = recentSyncEvents(d, 25);
  const unattributed = listUnattributed(d);
  const allBackups = listBackups();
  const backups = allBackups.slice(0, 8).map((b) => b.name);
  const automatic = allBackups.filter((b) => b.automatic).length;
  const backupMb = Math.round(allBackups.reduce((a, b) => a + b.bytes, 0) / 1_048_576);
  const backupsLarge = automatic > 50 || backupMb > 500;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />

      <Card id="extension">
        <CardHeader
          title="Browser extension & devices"
          description="The extension observes your own LeetCode activity and syncs it here. Each browser is paired separately and can be removed on its own; nothing is sent anywhere else."
          actions={seen ? <Badge tone={Date.now() - seen.at < 5 * 60_000 ? "good" : "neutral"}>Last seen {relativeTime(seen.at)}</Badge> : <Badge tone="neutral">Never connected</Badge>}
        />
        <div className="space-y-3 p-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>
              Build it: <code className="rounded bg-surface-2 px-1 font-mono text-xs">npm run ext:build</code>, then load <code className="rounded bg-surface-2 px-1 font-mono text-xs">apps/extension/dist</code> at chrome://extensions (Developer mode → Load unpacked).
            </li>
            <li>Click Add a device below, then enter the address and code in the extension&apos;s options.</li>
          </ol>
          <DevicesPanel devices={devices} dashboardUrl={baseUrl} />
        </div>
      </Card>

      <Card id="server-mode">
        <CardHeader
          title="Server mode"
          description="Use this dashboard from other devices (an iPad, another PC) over a private network such as Tailscale or your home Wi-Fi."
          actions={serverModeOn(server) ? <Badge tone="accent">On</Badge> : <Badge tone="neutral">Off</Badge>}
        />
        <div className="space-y-2 p-4 text-sm">
          {serverModeOn(server) ? (
            <>
              <div>
                Also answers at: <code className="font-mono text-xs">{server.hosts.join(", ")}</code>
              </div>
              <div className="text-muted">
                {server.listen === "network" ? "Listening on all network interfaces." : "Listening on this computer only; a local proxy (such as Tailscale Serve) passes requests in."}
              </div>
              <p className="text-warn">There is no login: anyone who can reach these addresses can use the dashboard. Keep them on a private network, never the public internet.</p>
            </>
          ) : (
            <p className="text-muted">Off: the dashboard only answers on this computer.</p>
          )}
          <p className="text-xs text-muted">
            Settings file: <code className="font-mono">{serverConfigFile}</code> (read when the dashboard starts; restart it after a change). How to set it up:{" "}
            <a className="text-accent hover:underline" href={SERVER_MODE_DOCS} target="_blank" rel="noreferrer">
              docs/SERVER_MODE.md
            </a>
            .
          </p>
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
              Backups: <code className="font-mono">{backupDir()}</code> (also taken automatically before migrations, imports, restores, and deleting a session or submission)
            </div>
            <div className={`mt-1 flex flex-wrap items-center gap-2 ${backupsLarge ? "text-warn" : ""}`}>
              <span>
                {allBackups.length} backup{allBackups.length === 1 ? "" : "s"} ({automatic} automatic), {backupMb} MB.
                {backupsLarge ? " The folder is getting large." : ""}
              </span>
              <PruneBackupsButton automatic={automatic} />
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
