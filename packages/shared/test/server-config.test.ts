import { describe, expect, it } from "vitest";
import { isAllowedHost, isConfiguredHost, normalizeHost, parseServerConfig, ServerConfigError, serverConfigEnv, serverModeOn, splitHost } from "../src";

describe("parseServerConfig", () => {
  it("defaults to loopback only when there is no file and no env", () => {
    const c = parseServerConfig(null, {});
    expect(c).toEqual({ hosts: [], listen: "loopback" });
    expect(serverModeOn(c)).toBe(false);
  });

  it("reads hosts and listen from the file, lowercased and deduplicated", () => {
    const c = parseServerConfig({ hosts: ["My-Laptop.tail1234.ts.net", "my-laptop.tail1234.ts.net", "192.168.1.20:4317"], listen: "network" });
    expect(c).toEqual({ hosts: ["my-laptop.tail1234.ts.net", "192.168.1.20:4317"], listen: "network" });
    expect(serverModeOn(c)).toBe(true);
  });

  it("lets env override the file", () => {
    const c = parseServerConfig({ hosts: ["a.example"], listen: "loopback" }, { LCC_ALLOWED_HOSTS: " b.example , c.example:8443 ", LCC_LISTEN: "network" });
    expect(c).toEqual({ hosts: ["b.example", "c.example:8443"], listen: "network" });
  });

  it("treats an empty LCC_ALLOWED_HOSTS as no hosts (turns server mode off)", () => {
    expect(parseServerConfig({ hosts: ["a.example"] }, { LCC_ALLOWED_HOSTS: "" }).hosts).toEqual([]);
  });

  it.each([
    [{ hosts: "a.example" }, /list of host names/],
    [{ hosts: ["https://a.example"] }, /looks like a URL/],
    [{ hosts: ["a.example/x"] }, /looks like a URL/],
    [{ hosts: ["*.ts.net"] }, /wildcards/],
    [{ hosts: ["bad host"] }, /not a valid host/],
    [{ hosts: ["a.example:99999"] }, /port/],
    [{ hosts: ["300.1.1.1"] }, /not a valid host/],
    [{ listen: "everywhere" }, /"listen"/],
    [{ listen: "network" }, /needs at least one/],
    [{ host: ["a.example"] }, /unknown setting "host"/],
    [["a.example"], /JSON object/],
  ])("rejects %j", (file, msg) => {
    expect(() => parseServerConfig(file, {})).toThrow(ServerConfigError);
    expect(() => parseServerConfig(file, {})).toThrow(msg);
  });

  it("rejects network listening via env without hosts", () => {
    expect(() => parseServerConfig(null, { LCC_LISTEN: "network" })).toThrow(/needs at least one/);
  });

  it("round-trips through the env vars handed to the server", () => {
    const c = parseServerConfig({ hosts: ["a.example", "b.example:8443"], listen: "network" });
    expect(parseServerConfig(null, serverConfigEnv(c))).toEqual(c);
    expect(parseServerConfig(null, serverConfigEnv(parseServerConfig(null)))).toEqual({ hosts: [], listen: "loopback" });
  });
});

describe("host matching", () => {
  const config = parseServerConfig({ hosts: ["laptop.tail.ts.net", "192.168.1.20:4317", "[fd7a::1]"] });

  it("normalizes entries", () => {
    expect(normalizeHost(" Laptop.Example:80 ")).toBe("laptop.example:80");
    expect(splitHost("[::1]:4317")).toEqual({ hostname: "[::1]", port: "4317" });
    expect(splitHost("Example.com")).toEqual({ hostname: "example.com", port: "" });
  });

  it("an entry without a port matches any port", () => {
    expect(isConfiguredHost("laptop.tail.ts.net", config)).toBe(true);
    expect(isConfiguredHost("LAPTOP.tail.ts.net:8443", config)).toBe(true);
  });

  it("an entry with a port matches that port only", () => {
    expect(isConfiguredHost("192.168.1.20:4317", config)).toBe(true);
    expect(isConfiguredHost("192.168.1.20", config)).toBe(false);
    expect(isConfiguredHost("192.168.1.20:80", config)).toBe(false);
  });

  it("does not match lookalikes", () => {
    expect(isConfiguredHost("evil.laptop.tail.ts.net", config)).toBe(false);
    expect(isConfiguredHost("laptop.tail.ts.net.evil.com", config)).toBe(false);
    expect(isConfiguredHost("", config)).toBe(false);
  });

  it("loopback is always allowed; everything else only when configured", () => {
    const off = parseServerConfig(null);
    for (const h of ["127.0.0.1:4317", "localhost", "[::1]:4317"]) expect(isAllowedHost(h, off)).toBe(true);
    expect(isAllowedHost("laptop.tail.ts.net", off)).toBe(false);
    expect(isAllowedHost("laptop.tail.ts.net", config)).toBe(true);
    expect(isAllowedHost("[fd7a::1]:4317", config)).toBe(true);
  });
});
