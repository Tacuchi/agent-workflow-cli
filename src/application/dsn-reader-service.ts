import { existsSync, readFileSync } from "node:fs";
import { type McpInstance, normalizeMcpInstance } from "../domain/mcp-entry.js";
import type { PathsService } from "./paths-service.js";

export interface DsnReadResult {
  path: string;
  exists: boolean;
  values: Record<string, string>;
}

export function readBootstrapDsn(paths: PathsService): DsnReadResult {
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
  const normalized = normalizeMcpInstance(instance);
  return `DB_${normalized.toUpperCase().replace(/-/g, "_")}_DSN`;
}
