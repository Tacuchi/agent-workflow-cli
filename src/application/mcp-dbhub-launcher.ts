// Mirror de developer-workflow-plugin/scripts/dbhub-mcp-runner.js.
// Launcher que resuelve DSN y spawnea `npx -y @bytebase/dbhub` con stdio inherit.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DbhubLauncherDeps {
  /** Returns process.env (or test override). */
  env: Record<string, string | undefined>;
  /** Returns `os.homedir()` (or test override). */
  home: string;
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

const VALID_INSTANCES = new Set(["cert", "prod"]);

export function dsnVarFor(instance: string): string {
  return instance === "prod" ? "DB_PROD_DSN" : "DB_CERT_DSN";
}

export function resolveDsn(instance: string, deps: DbhubLauncherDeps): DbhubResolvedDsn {
  const dsnVar = dsnVarFor(instance);
  const fromEnv = deps.env[dsnVar];
  if (fromEnv && fromEnv.length > 0) {
    return { dsn: fromEnv, source: "env" };
  }
  const fromFile = loadDsnFromFile(deps.home)[dsnVar];
  if (fromFile && fromFile.length > 0) {
    return { dsn: fromFile, source: "dsn.env" };
  }
  throw new DbhubLauncherError(
    `[dbhub-mcp-runner] ${dsnVar} no visible — no está en process.env ni en ~/.qtc/dev/dsn.env. Asegurate de exportarlo en ~/.zshenv (macOS/Linux) o System Environment (Windows) y reiniciar Claude Code desde una terminal donde 'echo $${dsnVar}' devuelva valor.`,
  );
}

function loadDsnFromFile(home: string): Record<string, string> {
  const file = join(home, ".qtc", "dev", "dsn.env");
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
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
  const instance = input.instance.toLowerCase();
  if (!VALID_INSTANCES.has(instance)) {
    throw new DbhubLauncherError(
      `[dbhub-mcp-runner] instance inválido '${input.instance}'; esperado 'cert' o 'prod'`,
    );
  }
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
