// Launcher que resuelve DSN y spawnea `npx -y @bytebase/dbhub` con stdio inherit.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  normalizeDsnVarName,
  validateDsnVarName,
  validateMcpInstance,
} from "../domain/mcp-entry.js";
import { dsnKeyForInstance } from "./dsn-reader-service.js";
import type { PathsService } from "./paths-service.js";

export const DBHUB_DSN_VAR_ENV = "DBHUB_DSN_VAR";

export interface DbhubLauncherDeps {
  /** Returns process.env (or test override). */
  env: Record<string, string | undefined>;
  /** Path resolver — provides the dsn.env file location for the active namespace. */
  paths: PathsService;
  /** Returns `process.platform` (or test override). */
  platform: NodeJS.Platform;
}

export interface DbhubResolvedDsn {
  dsn: string;
  source: "env" | "dsn.env";
}

export class DbhubLauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbhubLauncherError";
  }
}

export function dsnVarFor(instance: string): string {
  return dsnKeyForInstance(instance);
}

export function resolveDsn(instance: string, deps: DbhubLauncherDeps): DbhubResolvedDsn {
  const dsnVar = resolveDsnVar(instance, deps);
  const fromEnv = deps.env[dsnVar];
  if (fromEnv && fromEnv.length > 0) {
    return { dsn: fromEnv, source: "env" };
  }
  const fromFile = loadDsnFromFile(deps.paths.userDsnFile())[dsnVar];
  if (fromFile && fromFile.length > 0) {
    return { dsn: fromFile, source: "dsn.env" };
  }
  throw new DbhubLauncherError(
    `[dbhub-mcp-runner] ${dsnVar} no visible — no está en process.env ni en ${deps.paths.userDsnFile()}. Asegurate de exportarlo en ~/.zshenv (macOS/Linux) o System Environment (Windows) y reiniciar Claude Code desde una terminal donde 'echo $${dsnVar}' devuelva valor.`,
  );
}

function resolveDsnVar(instance: string, deps: DbhubLauncherDeps): string {
  const configured = deps.env[DBHUB_DSN_VAR_ENV];
  if (configured === undefined || configured.trim().length === 0) {
    return dsnVarFor(instance);
  }
  const validation = validateDsnVarName(configured);
  if (!validation.ok) {
    throw new DbhubLauncherError(
      `[dbhub-mcp-runner] ${DBHUB_DSN_VAR_ENV} inválida '${configured}': ${validation.error}`,
    );
  }
  return normalizeDsnVarName(validation.value);
}

function loadDsnFromFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m?.[1] && m[2] !== undefined) {
      out[m[1]] = m[2];
    }
  }
  return out;
}

export interface DbhubLauncherInput {
  instance: string;
  deps: DbhubLauncherDeps;
}

export interface DbhubLauncherResult {
  exitCode: number;
}

/**
 * Resolves DSN and spawns `npx -y @bytebase/dbhub` with stdio inherited.
 * Resolves only when the spawned child exits.
 */
export async function runDbhubLauncher(input: DbhubLauncherInput): Promise<DbhubLauncherResult> {
  const validation = validateMcpInstance(input.instance);
  if (!validation.ok) {
    throw new DbhubLauncherError(
      `[dbhub-mcp-runner] instance inválido '${input.instance}': ${validation.error}`,
    );
  }
  const instance = validation.value;
  const { dsn } = resolveDsn(instance, input.deps);

  const isWin = input.deps.platform === "win32";
  const cmd = isWin ? "npx.cmd" : "npx";
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ["-y", "@bytebase/dbhub"], {
      stdio: "inherit",
      env: { ...input.deps.env, DSN: dsn },
      shell: isWin,
    });
    child.on("error", (err) => reject(new DbhubLauncherError(`[dbhub-mcp-runner] ${err.message}`)));
    child.on("exit", (code, signal) => {
      if (signal) {
        // Honor signal: emulate `process.kill(process.pid, signal)` from JS launcher
        // by mapping to a non-zero exit. The CLI command will exit with that code.
        resolve({ exitCode: 128 + (signalToNumber(signal) ?? 0) });
      } else {
        resolve({ exitCode: code ?? 0 });
      }
    });
  });
}

function signalToNumber(signal: NodeJS.Signals): number | null {
  // Common signals; fallback to null (will produce exitCode 128 + 0 = 128).
  const map: Record<string, number> = {
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[signal] ?? null;
}
