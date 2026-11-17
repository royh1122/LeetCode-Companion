/**
 * Server mode: which extra addresses the dashboard may be reached at, and whether it listens beyond
 * this computer. Off by default (no extra hosts, loopback only), which is exactly the local-only app.
 *
 * Sources, in order of precedence: env vars (LCC_ALLOWED_HOSTS, LCC_LISTEN; Docker and tests), then
 * `<data dir>/server.json`. `npm run up` reads the file and hands the result to the server through
 * those env vars, so the server itself (proxy, next.config) only ever reads env.
 */
export type ListenMode = "loopback" | "network";

export interface ServerConfig {
  /** Extra Host names, lowercase: "name" (any port) or "name:port" (that port only). */
  hosts: string[];
  listen: ListenMode;
}

export const SERVER_CONFIG_FILE = "server.json";

export const defaultServerConfig = (): ServerConfig => ({ hosts: [], listen: "loopback" });

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const NAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;

/** Validates one host entry and returns it normalised (lowercase), or throws with a readable reason. */
export function normalizeHost(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) throw new ServerConfigError("A host entry is empty.");
  if (value.includes("://") || value.includes("/")) throw new ServerConfigError(`"${raw}" looks like a URL. List the host name only, e.g. "my-laptop.tailnet-name.ts.net".`);
  if (value.includes("*")) throw new ServerConfigError(`"${raw}": wildcards are not allowed. List each address exactly.`);
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m) throw new ServerConfigError(`"${raw}" is not a valid host name.`);
  const name = m[1] ?? "";
  const port = m[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new ServerConfigError(`"${raw}": port must be 1-65535.`);
  const ok = IPV6_RE.test(name) || (IPV4_RE.test(name) ? name.split(".").every((n) => Number(n) <= 255) : NAME_RE.test(name));
  if (!ok) throw new ServerConfigError(`"${raw}" is not a valid host name.`);
  return port === undefined ? name : `${name}:${port}`;
}

function parseHosts(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((h) => typeof h !== "string")) throw new ServerConfigError(`${source}: "hosts" must be a list of host names.`);
  return [...new Set((value as string[]).map(normalizeHost))];
}

function parseListen(value: unknown, source: string): ListenMode {
  if (value === undefined || value === "") return "loopback";
  if (value === "loopback" || value === "network") return value;
  throw new ServerConfigError(`${source}: "listen" must be "loopback" or "network".`);
}

/**
 * Combines the parsed server.json (or null when there is none) with env overrides.
 * Throws ServerConfigError on anything invalid: a misconfigured server should refuse to start,
 * not quietly fall back to something else.
 */
export function parseServerConfig(file: unknown, env: Record<string, string | undefined> = {}): ServerConfig {
  let hosts: string[] = [];
  let listen: ListenMode = "loopback";
  if (file !== null && file !== undefined) {
    if (typeof file !== "object" || Array.isArray(file)) throw new ServerConfigError(`${SERVER_CONFIG_FILE} must contain a JSON object.`);
    const obj = file as Record<string, unknown>;
    const unknownKeys = Object.keys(obj).filter((k) => k !== "hosts" && k !== "listen");
    if (unknownKeys.length) throw new ServerConfigError(`${SERVER_CONFIG_FILE}: unknown setting ${unknownKeys.map((k) => `"${k}"`).join(", ")}.`);
    hosts = parseHosts(obj.hosts, SERVER_CONFIG_FILE);
    listen = parseListen(obj.listen, SERVER_CONFIG_FILE);
  }
  if (env.LCC_ALLOWED_HOSTS !== undefined) {
    hosts = parseHosts(
      env.LCC_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean),
      "LCC_ALLOWED_HOSTS",
    );
  }
  if (env.LCC_LISTEN !== undefined) listen = parseListen(env.LCC_LISTEN, "LCC_LISTEN");
  if (listen === "network" && hosts.length === 0) {
    throw new ServerConfigError('"listen": "network" needs at least one entry in "hosts" (the address other devices will use).');
  }
  return { hosts, listen };
}

/** The env vars that carry a resolved config to the server process. */
export function serverConfigEnv(config: ServerConfig): { LCC_ALLOWED_HOSTS: string; LCC_LISTEN: ListenMode } {
  return { LCC_ALLOWED_HOSTS: config.hosts.join(","), LCC_LISTEN: config.listen };
}

export const serverModeOn = (config: ServerConfig) => config.hosts.length > 0;

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const isLoopbackHostname = (hostname: string) => LOOPBACK_NAMES.has(hostname.toLowerCase());

/** Splits a Host header value into hostname and port (port may be ""). */
export function splitHost(host: string): { hostname: string; port: string } {
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(host.trim().toLowerCase());
  return m ? { hostname: m[1] ?? "", port: m[2] ?? "" } : { hostname: host.toLowerCase(), port: "" };
}

/** True when a Host header value is one of the configured extra hosts. */
export function isConfiguredHost(host: string, config: ServerConfig): boolean {
  const { hostname, port } = splitHost(host);
  return config.hosts.some((entry) => {
    const e = splitHost(entry);
    return e.hostname === hostname && (e.port === "" || e.port === port);
  });
}

/** Loopback or a configured host. */
export function isAllowedHost(host: string, config: ServerConfig): boolean {
  return isLoopbackHostname(splitHost(host).hostname) || isConfiguredHost(host, config);
}
