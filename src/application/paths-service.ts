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
    /** Resolved Workline root, not necessarily the process cwd. */
    private readonly root: string,
  ) {}

  get namespace(): Namespace {
    return this.ns;
  }

  /** The resolved Workline workspace root. */
  workspaceDir(): string {
    return this.root;
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
   * literal, independent of the namespaced dir; the date uses
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

  // workspace-level (.${ns}/... at the resolved Workline root)
  cwdRoot(): string {
    return join(this.root, `.${this.ns}`);
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
   * Where a lifecycle surface parks a CHECKPOINT it could not file.
   *
   * Dot-prefixed for the same reason as the two entries around it:
   * `listSessionFolders` skips dot-prefixed entries, so a refuge is never read
   * as a session — which matters more here than anywhere else, because what
   * lands in this directory is precisely the state of a conversation whose
   * session could NOT be resolved. It is inside `.${ns}/sessions/`, so the
   * gitignore the CLI manages already covers it.
   */
  cwdSessionsRefugeDir(): string {
    return join(this.cwdSessionsDir(), ".refuge");
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
    return join(this.root, "docs", "logs");
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
 * Walks up from the resolved Workline root looking for the nearest directory
 * that contains the canonical `.<ns>/sessions/` marker. This guarantees that
 * even when the user invoked the CLI from a source subdirectory, graduation
 * keeps using the single bootstrap coordinate rather than re-reading raw cwd.
 *
 * Fallback: if no canonical marker is found anywhere up the tree, returns the
 * given start unchanged. The command bootstrap already made that start the
 * implicit Workline root, so this never guesses a Git root.
 */
export async function resolveWorkspaceRoot(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
): Promise<string> {
  return resolveWorkspaceRootFrom(fs, paths, paths.workspaceDir());
}

/**
 * The same walk, for a caller that holds no `EnvPort`.
 *
 * It starts from the paths service's resolved workspace root. A caller that
 * holds a source-local `from` can still ask for the nearest canonical marker.
 */
export async function resolveWorkspaceRootFrom(
  fs: FileSystemPort,
  paths: PathsService,
  from: string = paths.workspaceDir(),
): Promise<string> {
  const start = from;
  const wfMarker = join(`.${paths.namespace}`, "sessions");
  let dir = start;
  while (true) {
    try {
      if ((await fs.stat(join(dir, wfMarker))).type === "dir") return dir;
    } catch {
      // No canonical marker at this level; keep looking upward.
    }
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
