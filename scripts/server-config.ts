/**
 * Reads `<data dir>/server.json` plus the env overrides (see packages/shared/src/server-config.ts).
 * Used by the launcher, which passes the result to the server as env vars.
 */
import fs from "node:fs";
import path from "node:path";
import { parseServerConfig, SERVER_CONFIG_FILE, ServerConfigError, type ServerConfig } from "../packages/shared/src/server-config";

export function serverConfigPath(dataDir: string): string {
  return path.join(dataDir, SERVER_CONFIG_FILE);
}

/** Throws ServerConfigError (with the file path in the message) when the file or env is invalid. */
export function loadServerConfig(dataDir: string, env: Record<string, string | undefined> = process.env): ServerConfig {
  const file = serverConfigPath(dataDir);
  let json: unknown = null;
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new ServerConfigError(`Can't read ${file}: ${(e as Error).message}`);
  }
  if (text !== null) {
    try {
      json = JSON.parse(text.replace(/^﻿/, "")); // Notepad may save a BOM
    } catch (e) {
      throw new ServerConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
    }
  }
  try {
    return parseServerConfig(json, env);
  } catch (e) {
    if (e instanceof ServerConfigError) throw new ServerConfigError(`Server mode settings are invalid (${file}): ${e.message}`);
    throw e;
  }
}
