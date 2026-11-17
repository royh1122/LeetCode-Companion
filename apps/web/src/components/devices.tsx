"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { cancelPairingCodeAction, createPairingCodeAction, removeDeviceAction, renameDeviceAction } from "@/lib/actions";
import { relativeTime } from "@/lib/utils";
import { CopyButton } from "./code";
import { Badge, Button, Input } from "./ui";

export interface DeviceRow {
  id: string;
  name: string;
  lastSeenAt: number | null;
  lastVersion: string | null;
  createdAt: number;
}

/** Paired browsers, and "Add a device" (a one-time code for the extension's options page). */
export function DevicesPanel({ devices, dashboardUrl }: { devices: DeviceRow[]; dashboardUrl: string }) {
  return (
    <div className="space-y-3">
      {devices.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {devices.map((d) => (
            <DeviceItem key={d.id} device={d} />
          ))}
        </ul>
      ) : (
        <p className="text-muted">No browser is paired yet.</p>
      )}
      <AddDevice dashboardUrl={dashboardUrl} deviceIds={devices.map((d) => d.id)} />
    </div>
  );
}

function DeviceItem({ device }: { device: DeviceRow }) {
  const [name, setName] = useState(device.name);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(device.name), [device.name]);
  const recent = device.lastSeenAt !== null && Date.now() - device.lastSeenAt < 5 * 60_000;
  const saveName = () => {
    const next = name.trim();
    if (!next || next === device.name) return setName(device.name);
    start(async () => {
      const r = await renameDeviceAction(device.id, next);
      if (!r.ok) setError(r.error);
    });
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2" data-device-id={device.id}>
      <Input
        aria-label="Device name"
        className="h-8 w-full max-w-56 sm:w-56"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setName(device.name);
        }}
      />
      <Badge tone={recent ? "good" : "neutral"}>{device.lastSeenAt ? `Last seen ${relativeTime(device.lastSeenAt)}` : "Not seen yet"}</Badge>
      {device.lastVersion ? <span className="text-xs text-muted">v{device.lastVersion}</span> : null}
      <span className="ml-auto inline-flex items-center gap-2">
        {confirm ? (
          <>
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await removeDeviceAction(device.id);
                  if (!r.ok) setError(r.error);
                  setConfirm(false);
                })
              }
            >
              Remove {device.name}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Remove ${device.name}`}>
            <Trash2 /> Remove
          </Button>
        )}
      </span>
      {confirm ? <p className="w-full text-xs text-muted">Its extension stops syncing until it is paired again. What it already synced stays.</p> : null}
      {error ? <p className="w-full text-xs text-bad">{error}</p> : null}
    </li>
  );
}

function AddDevice({ dashboardUrl, deviceIds }: { dashboardUrl: string; deviceIds: string[] }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [paired, setPaired] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Devices that existed when the code was made: a new one appearing means the code was used.
  const before = useRef<string[]>([]);

  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);

  useEffect(() => {
    if (code && deviceIds.some((id) => !before.current.includes(id))) {
      setCode(null);
      setPaired("Paired. The new device is in the list above; you can rename it there.");
    }
  }, [code, deviceIds]);

  const create = () =>
    start(async () => {
      setError(null);
      setPaired(null);
      const r = await createPairingCodeAction();
      if (!r.ok) return setError(r.error);
      before.current = deviceIds;
      setNow(Date.now());
      setCode(r.data);
    });

  const left = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0;
  if (!code || left === 0) {
    return (
      <div className="space-y-1">
        <Button size="sm" onClick={create} disabled={pending}>
          <Plus /> Add a device
        </Button>
        {code && left === 0 ? <p className="text-xs text-muted">The code expired. Create a new one.</p> : null}
        {paired ? <p className="text-xs text-good">{paired}</p> : null}
        {error ? <p className="text-xs text-bad">{error}</p> : null}
      </div>
    );
  }
  const line = `${dashboardUrl}  ${code.code}`;
  return (
    <div className="space-y-2 rounded-md border border-accent/40 bg-surface-2 p-3" aria-live="polite">
      <p>
        In the new browser, open the LeetCode Companion extension&apos;s <strong>options</strong> and enter this line (or the address and code separately):
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-sm" data-pairing-line>
          {dashboardUrl} <strong className="tracking-wider">{code.code}</strong>
        </code>
        <CopyButton text={line} label="Copy address and pairing code" />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} more.
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            start(async () => {
              await cancelPairingCodeAction();
              setCode(null);
            })
          }
        >
          Cancel code
        </Button>
      </div>
    </div>
  );
}
