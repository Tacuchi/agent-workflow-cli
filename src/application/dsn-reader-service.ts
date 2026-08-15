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
  return dsnKeyFromSegments(instanceSegments(instance));
}

/**
 * The variable names that may hold the DSN of `instance`, most specific first:
 * the canonical key, and the one without its leading segment. An alias usually
 * carries an organisation prefix (`qtc-cert`) that the variable the user really
 * exported does not (`DB_CERT_DSN`).
 *
 * Exactly ONE segment is ever dropped. `qtc-cert-ro` may fall back to
 * DB_CERT_RO_DSN but never to DB_RO_DSN, because collapsing an alias to its last
 * segment makes different organisations share one generic name — `acme-prod` and
 * `qtc-prod` would both reach DB_PROD_DSN, and starting a server against another
 * environment's credential is a worse outcome than refusing to start.
 */
export function dsnKeyCandidates(instance: McpInstance): string[] {
  const segments = instanceSegments(instance);
  // A single-segment or degenerate alias still yields its canonical key: callers
  // must always have at least one name to probe and to name in errors.
  if (segments.length <= 1) return [dsnKeyFromSegments(segments)];
  return [dsnKeyFromSegments(segments), dsnKeyFromSegments(segments.slice(1))];
}

function instanceSegments(instance: McpInstance): string[] {
  return normalizeMcpInstance(instance)
    .split("-")
    .filter((segment) => segment.length > 0);
}

function dsnKeyFromSegments(segments: readonly string[]): string {
  return `DB_${segments.join("_").toUpperCase()}_DSN`;
}

export interface DsnResolution {
  dsn: string;
  /** Which of the probed variable names carried the value. */
  variable: string;
  source: "env" | "dsn.env";
}

/**
 * Single resolution path shared by the dbhub launcher and the connection
 * tester. Precedence: the whole candidate list in `env` first, then the whole
 * list in the dsn.env file — an exported variable beats a persisted one, and
 * among exported variables the most specific name wins.
 *
 * Throws whatever `readBootstrapDsn` throws (unreadable dsn.env): each caller
 * decides how that surfaces instead of it being swallowed here.
 */
export function resolveDsnFromCandidates(
  candidates: readonly string[],
  env: Record<string, string | undefined>,
  paths: PathsService,
): DsnResolution | null {
  for (const variable of candidates) {
    const fromEnv = env[variable];
    if (fromEnv && fromEnv.length > 0) return { dsn: fromEnv, variable, source: "env" };
  }
  // Read once, and only after every candidate missed in the environment.
  const values = readBootstrapDsn(paths).values;
  for (const variable of candidates) {
    const fromFile = values[variable];
    if (fromFile && fromFile.length > 0) return { dsn: fromFile, variable, source: "dsn.env" };
  }
  return null;
}
