import { existsSync, readFileSync } from "node:fs";
import { type McpInstance, normalizeMcpInstance } from "../domain/mcp-entry.js";
import type { PathsService } from "./paths-service.js";

export interface DsnReadResult {
  path: string;
  exists: boolean;
  values: Record<string, string>;
}

export function readDsnFile(paths: PathsService): DsnReadResult {
  const path = paths.userDsnFile();
  if (!existsSync(path)) {
    return { path, exists: false, values: {} };
  }
  const text = readFileSync(path, "utf-8");
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key.length > 0) values[key] = val;
  }
  return { path, exists: true, values };
}

export function dsnKeyForInstance(instance: McpInstance): string {
  return `DB_${normalizeMcpInstance(instance).replace(/-/g, "_").toUpperCase()}_DSN`;
}

export interface DsnResolution {
  dsn: string;
  /** Which of the probed variable names carried the value. */
  variable: string;
  source: "env" | "dsn.env";
}

/**
 * Single resolution path shared by the dbhub launcher and the connection
 * tester. The caller supplies the exact variable registered for the connection;
 * the environment wins over the local dsn.env file for that one name only.
 *
 * Throws whatever `readDsnFile` throws (unreadable dsn.env): each caller
 * decides how that surfaces instead of it being swallowed here.
 */
export function resolveExactDsn(
  variable: string,
  env: Record<string, string | undefined>,
  paths: PathsService,
): DsnResolution | null {
  const fromEnv = env[variable];
  if (fromEnv && fromEnv.length > 0) return { dsn: fromEnv, variable, source: "env" };
  const fromFile = readDsnFile(paths).values[variable];
  if (fromFile && fromFile.length > 0) return { dsn: fromFile, variable, source: "dsn.env" };
  return null;
}
