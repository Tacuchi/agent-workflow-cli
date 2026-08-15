import { dirname, join } from "node:path";
import { unitsRoot } from "../domain/isolation-unit.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { Namespace } from "../runtime/namespace.js";
import { localDateIso } from "./dates.js";

export interface ProjectBlockMarkers {
  start: string;
  end: string;
}

export class PathsService {
  constructor(
    private readonly ns: Namespace,
    private readonly home: string,
    private readonly cwd: string,
  ) {}

  get namespace(): Namespace {
    return this.ns;
  }

  /** The current workspace directory (cwd the CLI was invoked from). */
  workspaceDir(): string {
    return this.cwd;
  }

  // user-level (~/.${ns}/...)
  userRoot(): string {
    return join(this.home, `.${this.ns}`);
  }
  userDevDir(): string {
    return join(this.userRoot(), "dev");
  }
  userDsnFile(): string {
    return join(this.userDevDir(), "dsn.env");
  }
  userMcpConnectionsFile(): string {
    return join(this.userDevDir(), "mcp-connections.json");
  }
  userLogsDir(): string {
    return join(this.userRoot(), "logs");
  }
  /**
   * Global, user-level daily operational log for the given local calendar day:
   * `~/.${ns}/logs/agent-workflow-YYYY-MM-DD.log`. The `agent-workflow-` prefix is
   * literal (like `cwdLogFile`), independent of the namespaced dir; the date uses
   * LOCAL parts so it matches the user's "today".
   */
  userDailyLogFile(date: Date): string {
    return join(this.userLogsDir(), `agent-workflow-${localDateIso(date)}.log`);
  }
  userLibConfigDir(): string {
    return join(this.userRoot(), "lib", "config");
  }
  userRuntimeJson(): string {
    return join(this.userRoot(), "agent-workflow", "runtime.json");
  }
  userConfigMd(): string {
    return join(this.userRoot(), "user-config.md");
  }
  userPluginVersionFile(flow: string): string {
    return join(this.userRoot(), flow, ".plugin-version");
  }
  userCoreLibMarker(): string {
    return join(this.userRoot(), "lib", `.${this.ns}-core-version`);
  }
  /**
   * Root of every flow's isolation units, across every workspace.
   *
   * Deliberately OUTSIDE any repository: a worktree nested inside its own source
   * would show up in that source's status, its ignores and its own scans.
   */
  userUnitsDir(): string {
    return unitsRoot(this.userRoot());
  }

  // cwd-level (.${ns}/... in current workspace)
  cwdRoot(): string {
    return join(this.cwd, `.${this.ns}`);
  }
  cwdSessionsDir(): string {
    return join(this.cwdRoot(), "sessions");
  }
  /**
   * Durable conversation→session association registry. Lives inside the
   * sessions dir (machine-local, gitignored) and is skipped by
   * `listSessionFolders`, which ignores dot-prefixed entries.
   */
  cwdSessionBindingsFile(): string {
    return join(this.cwdSessionsDir(), ".bindings.json");
  }
  /**
   * Monotone attempt counters of the flow runs, one file per session folder.
   *
   * Deliberately OUTSIDE the session folders it indexes. The counter exists so
   * that restoring an earlier copy of a run's ledger cannot give back attempts
   * already spent, and while it lived inside the session folder a `cp -r` of
   * that folder took the counter with it — the evasion arrived wearing the shape
   * of a backup. Here it is workspace runtime, dot-prefixed so
   * `listSessionFolders` skips it, and already covered by the `.${ns}/sessions/`
   * entry of the gitignore the CLI manages.
   */
  cwdFlowAttemptsDir(): string {
    return join(this.cwdSessionsDir(), ".flow-attempts");
  }
  cwdFlowAttemptsFile(session: string): string {
    return join(this.cwdFlowAttemptsDir(), `${session}.json`);
  }
  cwdHistoryFile(): string {
    return join(this.cwdRoot(), "HISTORY.md");
  }
  cwdLogsDir(): string {
    return join(this.cwdRoot(), "logs");
  }
  cwdLogFile(): string {
    return join(this.cwdLogsDir(), "agent-workflow.log");
  }
  cwdLockFile(): string {
    return join(this.cwdRoot(), ".lock");
  }
  /** Persistent registry of detached source processes (machine-specific; gitignored). */
  cwdProcessesFile(): string {
    return join(this.cwdRoot(), "processes.json");
  }
  /** Per-source launch artifacts (descriptor + run scripts); machine-specific, gitignored. */
  cwdLaunchDir(): string {
    return join(this.cwdRoot(), "launch");
  }
  /** Workspace docs/logs dir — per-process launch logs (gitignored). */
  cwdDocsLogsDir(): string {
    return join(this.cwd, "docs", "logs");
  }

  // skills.toml — capability role → skill bindings (cascade: global then workspace)
  userSkillsToml(): string {
    return join(this.userRoot(), "skills.toml");
  }
  cwdSkillsToml(): string {
    return join(this.cwdRoot(), "skills.toml");
  }

  // CLAUDE.md / AGENTS.md project block markers
  blockMarkers(): ProjectBlockMarkers {
    const upper = this.ns.toUpperCase();
    return {
      start: `<!-- ${upper}-PROJECT-START -->`,
      end: `<!-- ${upper}-PROJECT-END -->`,
    };
  }
}

/**
 * Resolve the workspace root directory.
 *
 * Graduation always lands at the workspace root (the parent of `.<ns>/`),
 * regardless of how many sources the workspace declares.
 *
 * Walks up from `env.cwd()` looking for the nearest directory that contains
 * `.<ns>/` (the workspace marker). This guarantees that even when the user has
 * `cd`-ed into a source subdirectory of the workspace before invoking
 * `graduate`, the destination still resolves to the workspace root rather than
 * the source.
 *
 * Fallback: if no `.<ns>/` marker is found anywhere up the tree (e.g. the user
 * is outside any workspace), returns `env.cwd()` unchanged so the caller can
 * surface the missing-workspace error normally.
 */
export async function resolveWorkspaceRoot(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
): Promise<string> {
  return resolveWorkspaceRootFrom(fs, paths, env.cwd());
}

/**
 * The same walk, for a caller that holds no `EnvPort`.
 *
 * It starts from the paths service's own working directory, which is the value
 * `env.cwd()` was used to build it with — so the two entry points cannot resolve
 * to different roots, which is the only reason a second one is safe to have.
 */
export async function resolveWorkspaceRootFrom(
  fs: FileSystemPort,
  paths: PathsService,
  from: string = paths.workspaceDir(),
): Promise<string> {
  const start = from;
  const wfMarker = `.${paths.namespace}`;
  let dir = start;
  while (true) {
    if (await fs.exists(join(dir, wfMarker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
