import { dirname, join } from "node:path";
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

  // cwd-level (.${ns}/... in current workspace)
  cwdRoot(): string {
    return join(this.cwd, `.${this.ns}`);
  }
  cwdSessionsDir(): string {
    return join(this.cwdRoot(), "sessions");
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
 * `.<ns>/` (the workflow marker). This guarantees that even when the user has
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
  const start = env.cwd();
  const wfMarker = `.${paths.namespace}`;
  let dir = start;
  while (true) {
    if (await fs.exists(join(dir, wfMarker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
