import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";
import type { PathsService } from "./paths-service.js";
import { type ProcessRecord, ProcessRegistryService } from "./process-registry-service.js";
import {
  type LaunchDescriptor,
  type LaunchMode,
  type LaunchStep,
  generateSourceLaunchArtifacts,
  winLaunchCommand,
} from "./source-launch-scripts-service.js";

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
  /** How to own the terminal: interactive (foreground TTY) vs server (background + log). */
  mode: LaunchMode;
  /** Optional build step run before `command` (platform-translated). null when none. */
  build: LaunchStep | null;
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
  /**
   * Resolve a source alias to its repo path (from the WORKSPACE block). Enables
   * on-demand descriptor generation at the first launch (init no longer
   * pregenerates launch artifacts).
   */
  resolveSourcePath?: (alias: string) => Promise<string | null>;
  /** Injected clock for deterministic tests; defaults to the wall clock. */
  now?: () => string;
  /** Injected platform for deterministic tests; defaults to the real one. */
  platform?: string;
}

export type LaunchResult =
  | {
      ok: true;
      record: ProcessRecord;
      /** Why the terminal attempt(s) failed when the launch fell back to background (surfaced in the TUI + log). */
      terminalError?: string | undefined;
    }
  | {
      ok: false;
      error:
        | "no_descriptor"
        | "corrupt_descriptor"
        | "not_launchable"
        | "spawn_failed"
        | "stop_failed";
      message: string;
    };

export type DescriptorRead =
  | { status: "ok"; descriptor: LaunchDescriptor }
  | { status: "absent" }
  | { status: "corrupt" };

/**
 * Read a source's launch descriptor. Absent and corrupt are distinguished on
 * purpose: regenerating over a corrupt file would loop (writeIfPristine
 * preserves files without a valid marker), so corruption must surface instead.
 */
export async function readDescriptor(
  fs: FileSystemPort,
  launchDir: string,
  alias: string,
): Promise<DescriptorRead> {
  const file = join(launchDir, alias, "launch.json");
  if (!(await fs.exists(file))) return { status: "absent" };
  try {
    return { status: "ok", descriptor: JSON.parse(await fs.readText(file)) as LaunchDescriptor };
  } catch {
    return { status: "corrupt" };
  }
}

/**
 * Read the descriptor, generating it on demand when absent (first launch) or
 * re-detecting when it exists WITHOUT a command — legacy pregenerated
 * descriptors carry `command: null` for sources that were not launchable at
 * init time; writeIfPristine re-detects pristine ones and never touches
 * user-edited files. Corrupt descriptors are never regenerated (see
 * readDescriptor).
 */
export async function ensureDescriptor(
  fs: FileSystemPort,
  launchDir: string,
  alias: string,
  resolveSourcePath?: (alias: string) => Promise<string | null>,
): Promise<DescriptorRead> {
  const read = await readDescriptor(fs, launchDir, alias);
  const needsGeneration =
    read.status === "absent" || (read.status === "ok" && read.descriptor.command === null);
  if (!needsGeneration || !resolveSourcePath) return read;
  const sourcePath = await resolveSourcePath(alias);
  if (!sourcePath || !(await fs.exists(sourcePath))) return read;
  await generateSourceLaunchArtifacts(fs, launchDir, sourcePath, alias);
  return readDescriptor(fs, launchDir, alias);
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
  platform: string = process.platform,
): ResolvedLaunch | null {
  if (!desc.command) return null;
  const command = platform === "win32" ? winLaunchCommand(desc.command) : desc.command;
  if (!command) return null;
  const build: LaunchStep | null = desc.build
    ? {
        command:
          platform === "win32"
            ? (winLaunchCommand(desc.build.command) ?? desc.build.command)
            : desc.build.command,
        args: desc.build.args,
      }
    : null;
  const envDelta: Record<string, string> = {};
  for (const p of desc.params) {
    envDelta[p.name] = req.values[p.name] ?? p.default;
  }
  if (req.profile) envDelta.PROFILE = req.profile;
  return {
    command,
    args: desc.args,
    cwd: desc.cwd,
    mode: desc.mode,
    build,
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

/** Launch a source: ensure descriptor (on-demand gen) → resolve → spawnInTerminal → register. */
export async function launchSource(deps: LaunchDeps, req: LaunchRequest): Promise<LaunchResult> {
  const read = await ensureDescriptor(
    deps.fs,
    deps.paths.cwdLaunchDir(),
    req.alias,
    deps.resolveSourcePath,
  );
  if (read.status === "corrupt") {
    return {
      ok: false,
      error: "corrupt_descriptor",
      message: `launch.json corrupto para ${req.alias} — corregilo o borralo y se regenera en el próximo lanzamiento`,
    };
  }
  if (read.status === "absent") {
    return { ok: false, error: "no_descriptor", message: `Sin descriptor para ${req.alias}` };
  }
  const desc = read.descriptor;
  const logsDir = deps.paths.cwdDocsLogsDir();
  const resolved = resolveLaunch(desc, req, logsDir, deps.baseEnv, deps.platform);
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
    const { pid, mode, terminalError } = await deps.proc.spawnInTerminal(
      resolved.command,
      resolved.args,
      {
        cwd: resolved.cwd,
        env: resolved.env,
        envDelta: resolved.envDelta,
        logPath: resolved.logPath,
        title: req.profile ? `${req.alias} · ${req.profile}` : req.alias,
        mode: resolved.mode,
        ...(resolved.build ? { build: resolved.build } : {}),
      },
    );
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
    return { ok: true, record, terminalError };
  } catch (err) {
    return { ok: false, error: "spawn_failed", message: (err as Error).message };
  }
}

/** What a stop actually achieved. `stopped: false` = the tree outlived the signal. */
export interface StopResult {
  stopped: boolean;
}

// `killTree` signals and returns: SIGTERM is asynchronous and the adapter
// swallows every failure by design (a dead pid is not an error). So liveness is
// polled instead of assumed — bounded, and it exits as soon as the pid is gone.
const STOP_CONFIRM_BUDGET_MS = 600;
const STOP_CONFIRM_STEP_MS = 60;

/**
 * Stop a process and report whether it actually died.
 *
 * The registry is only marked when the tree is really gone: recording `stopped`
 * for a process still holding its port is the lie every caller then repeats.
 */
export async function stopProcess(deps: LaunchDeps, record: ProcessRecord): Promise<StopResult> {
  await deps.proc.killTree(record.pid);
  const stopped = await confirmDead(deps.proc, record.pid);
  if (stopped) await registry(deps).markStopped(record.id);
  return { stopped };
}

/** Polls the port's own liveness check until the pid is gone or the budget runs out. */
async function confirmDead(proc: LaunchDeps["proc"], pid: number): Promise<boolean> {
  for (let waited = 0; ; waited += STOP_CONFIRM_STEP_MS) {
    if (!(await proc.isAlive(pid))) return true;
    if (waited >= STOP_CONFIRM_BUDGET_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, STOP_CONFIRM_STEP_MS));
  }
}

/** Relaunch = stop the existing process, then launch the same source+profile afresh. */
export async function relaunchProcess(
  deps: LaunchDeps,
  record: ProcessRecord,
): Promise<LaunchResult> {
  const stop = await stopProcess(deps, record);
  // Launching over a survivor is how one process becomes two fighting for the
  // same port — and the old one is no longer in the registry's `running` view.
  if (!stop.stopped) return stopFailed(record.pid);
  // Reuse the same profile + persisted non-secret values (secrets re-default to empty).
  return launchSource(deps, {
    alias: record.sourceAlias,
    profile: record.profile,
    values: record.values ?? {},
  });
}

/** The launch outcome when the process that had to die is still running. */
export function stopFailed(pid: number): Extract<LaunchResult, { ok: false }> {
  return {
    ok: false,
    error: "stop_failed",
    message: `El proceso (PID ${pid}) sigue vivo tras la señal: no se relanza para no duplicarlo.`,
  };
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
