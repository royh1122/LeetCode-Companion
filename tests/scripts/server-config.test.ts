import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "../../scripts/server-config";

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lcc-server-config-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("loadServerConfig", () => {
  it("is off when the data dir has no server.json", () => {
    expect(loadServerConfig(tempDir(), {})).toEqual({ hosts: [], listen: "loopback" });
  });

  it("reads server.json (with a BOM, as Notepad saves it)", () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, "server.json"), `﻿${JSON.stringify({ hosts: ["laptop.tail.ts.net"] })}`);
    expect(loadServerConfig(d, {})).toEqual({ hosts: ["laptop.tail.ts.net"], listen: "loopback" });
  });

  it("lets env override the file", () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, "server.json"), JSON.stringify({ hosts: ["a.example"] }));
    expect(loadServerConfig(d, { LCC_ALLOWED_HOSTS: "b.example", LCC_LISTEN: "network" })).toEqual({ hosts: ["b.example"], listen: "network" });
  });

  it("names the file when it is broken", () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, "server.json"), "{ hosts: ");
    expect(() => loadServerConfig(d, {})).toThrow(/server\.json is not valid JSON/);
    fs.writeFileSync(path.join(d, "server.json"), JSON.stringify({ hosts: ["https://x.example"] }));
    expect(() => loadServerConfig(d, {})).toThrow(/Server mode settings are invalid .*server\.json.*looks like a URL/);
  });
});
