/** Every IANA time zone the runtime knows, grouped by region, with its current UTC offset. */
export interface TimeZoneOption {
  id: string;
  label: string;
}
export interface TimeZoneGroup {
  region: string;
  zones: TimeZoneOption[];
}

function offsetOf(tz: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName");
    const v = part?.value ?? "GMT";
    return v === "GMT" ? "UTC+00:00" : v.replace("GMT", "UTC").replace("-", "−");
  } catch {
    return "";
  }
}

export function timeZoneGroups(current: string, at = new Date()): TimeZoneGroup[] {
  const all = new Set<string>(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
  all.add("UTC");
  if (current) all.add(current);
  const groups = new Map<string, TimeZoneOption[]>();
  for (const id of all) {
    const slash = id.indexOf("/");
    const region = slash === -1 ? "Other" : id.slice(0, slash);
    const place = (slash === -1 ? id : id.slice(slash + 1)).replace(/_/g, " ").replace(/\//g, " / ");
    const off = offsetOf(id, at);
    const list = groups.get(region) ?? [];
    list.push({ id, label: off ? `${place} (${off})` : place });
    groups.set(region, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map(([region, zones]) => ({ region, zones: zones.sort((a, b) => a.label.localeCompare(b.label)) }));
}
