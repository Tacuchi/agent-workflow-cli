import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";
import type { PathsService } from "./paths-service.js";
import { type ProcessRecord, ProcessRegistryService } from "./process-registry-service.js";
import type { LaunchDescriptor } from "./source-launch-scripts-service.js";

export interface LaunchRequest {
  alias: string;
  profile: string | null;
  /** param name → value entered by the user (overrides the descriptor default). */
  values: Record<string, string>;
}

export interface ResolvedLaunch {
  command: string;
  args: string[];
  cwd: string;
  /** Full child env: base + params + PROFILE. */
  env: Record<string, string>;
  /** Deltas over the base env (params + PROFILE) — what a terminal must bake in when it doesn't inherit our env. */
  envDelta: Record<string, string>;
  logPath: string;
}

export interface LaunchDeps {
  fs: FileSystemPort;
  proc: ProcessPort;
  paths: PathsService;
  /** Base environment the child inherits (the caller passes the real process env). */
  baseEnv: Record<string, string>;
  /** Injected clock for deterministic tests; defaults to the wall clock. */
  now?: () => string;
}

export type LaunchResult =
  | { ok: true; record: ProcessRecord }
  | { ok: false; error: "no_descriptor" | "not_launchable" | "spawn_failed"; message: string };

/** Read a source's launch descriptor, or null when absent/corrupt. */
export async function readDescriptor(
  fs: FileSystemPort,
  launchDir: string,
  alias: string,
): Promise<LaunchDescriptor | null> {
  const file = join(launchDir, alias, "launch.json");
  if (!(await fs.exists(file))) return null;
  try {
    return JSON.parse(await fs.readText(file)) as LaunchDescriptor;
  } catch {
    return null;
  }
}

/** Log file for a source+profile, under docs/logs/. */
export function logFileFor(logsDir: string, alias: string, profile: string | null): string {
  return join(logsDir, profile ? `${alias}-${profile}.log` : `${alias}.log`);
}

/** Resolve the concrete command/args/env/cwd/log for a launch. Null if the descriptor has no command. */
export function resolveLaunch(
  desc: LaunchDescriptor,
  req: LaunchRequest,
  logsDir: string,
  baseEnv: Record<string, string>,
): ResolvedLaunch | null {
  if (!desc.command) return null;
  const envDelta: Record<string, string> = {};
  for (const p of desc.params) {
    envDelta[p.name] = req.values[p.name] ?? p.default;
  }
  if (req.profile) envDelta.PROFILE = req.profile;
  return {
    command: desc.command,
    args: desc.args,
    cwd: desc.cwd,
    env: { ...baseEnv, ...envDelta },
    envDelta,
    logPath: logFileFor(logsDir, req.alias, req.profile),
  };
}

/** A running process for the same source+profile, if any (collision). */
export function findCollision(
  processes: ProcessRecord[],
  alias: string,
  profile: string | null,
): ProcessRecord | undefined {
  return processes.find(
    (p) => p.sourceAlias === alias && p.profile === profile && p.state === "running",
  );
}

function registry(deps: LaunchDeps): ProcessRegistryService {
  return new ProcessRegistryService(deps.fs, deps.proc, deps.paths.cwdProcessesFile());
}

/** Launch a source: resolve → open log dir → spawnInTerminal (terminal or background fallback) → register. */
export async function launchSource(deps: LaunchDeps, req: LaunchRequest): Promise<LaunchResult> {
  const desc = await readDescriptor(deps.fs, deps.paths.cwdLaunchDir(), req.alias);
  if (!desc)
    return { ok: false, error: "no_descriptor", message: `Sin descriptor para ${req.alias}` };
  const logsDir = deps.paths.cwdDocsLogsDir();
  const resolved = resolveLaunch(desc, req, logsDir, deps.baseEnv);
  if (!resolved) {
    return {
      ok: false,
      error: "not_launchable",
      message: `El descriptor de ${req.alias} no tiene comando de arranque`,
    };
  }
  await deps.fs.mkdirp(logsDir);
  try {
    // Open a visible, persistent terminal window (monitor live + close-to-stop);
    // the adapter falls back to a background+log process when no terminal exists.
    const { pid, mode } = await deps.proc.spawnInTerminal(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      env: resolved.env,
      envDelta: resolved.envDelta,
      logPath: resolved.logPath,
      title: req.profile ? `${req.alias} · ${req.profile}` : req.alias,
    });
    const startedAt = (deps.now ?? (() => new Date().toISOString()))();
    // Persist only NON-secret entered values so a relaunch can reuse them; secrets
    // are never written to the registry.
    const secretNames = new Set(desc.params.filter((p) => p.secret).map((p) => p.name));
    const persistedValues = Object.fromEntries(
      Object.entries(req.values).filter(([k]) => !secretNames.has(k)),
    );
    const record = await registry(deps).register({
      sourceAlias: req.alias,
      profile: req.profile,
      command: resolved.command,
      args: resolved.args,
      pid,
      startedAt,
      logPath: resolved.logPath,
      values: persistedValues,
      launchMode: mode,
    });
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: "spawn_failed", message: (err as Error).message };
  }
}

/** Stop a process (kill its tree) and mark it stopped in the registry. */
export async function stopProcess(deps: LaunchDeps, record: ProcessRecord): Promise<void> {
  await deps.proc.killTree(record.pid);
  await registry(deps).markStopped(record.id);
}

/** Relaunch = stop the existing process, then launch the same source+profile afresh. */
export async function relaunchProcess(
  deps: LaunchDeps,
  record: ProcessRecord,
): Promise<LaunchResult> {
  await stopProcess(deps, record);
  // Reuse the same profile + persisted non-secret values (secrets re-default to empty).
  return launchSource(deps, {
    alias: record.sourceAlias,
    profile: record.profile,
    values: record.values ?? {},
  });
}

/** Last `maxLines` of a process log (best-effort; empty when missing). */
export async function tailLog(
  fs: FileSystemPort,
  logPath: string,
  maxLines: number,
): Promise<string[]> {
  if (!(await fs.exists(logPath))) return [];
  try {
    const lines = (await fs.readText(logPath)).split(/\r?\n/);
    // Drop only the trailing empty line from a final newline; keep interior blanks.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
