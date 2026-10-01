import { dirname, join } from "node:path";
import { unitsRoot } from "../domain/isolation-unit.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { resolveHubDirectory } from "../runtime/hub-resolution.js";
import type { Namespace } from "../runtime/namespace.js";
import { WORKLINE_MARKER_FILE } from "../runtime/workline-marker.js";
import { localDateIso } from "./dates.js";
import { hubBlockMarkers } from "./parsers/hub-block.js";

export interface HubBlockMarkers {
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

  /** The resolved Workline hub root. */
  hubDir(): string {
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
   * Root of every flow's isolation units, across every hub.
   *
   * Deliberately OUTSIDE any repository: a worktree nested inside its own source
   * would show up in that source's status, its ignores and its own scans.
   */
  userUnitsDir(): string {
    return unitsRoot(this.userRoot());
  }

  // hub-level (.${ns}/... at the resolved Workline root)
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
   * of a backup. Here it is hub runtime, dot-prefixed so
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
  cwdLocalConfigFile(): string {
    return join(this.cwdRoot(), "local.json");
  }
  /**
   * The hub's own mark — what the resolver reads to tell a Workline
   * hub from a host tool's directory that happens to hold a `sessions/`.
   */
  cwdMarkerFile(): string {
    return join(this.cwdRoot(), WORKLINE_MARKER_FILE);
  }
  cwdLockFile(): string {
    return join(this.cwdRoot(), ".lock");
  }
  // skills.toml — capability role → skill bindings (cascade: global then hub)
  userSkillsToml(): string {
    return join(this.userRoot(), "skills.toml");
  }
  cwdSkillsToml(): string {
    return join(this.cwdRoot(), "skills.toml");
  }

  // CLAUDE.md / AGENTS.md hub block markers
  blockMarkers(): HubBlockMarkers {
    return hubBlockMarkers(this.ns);
  }
}

/**
 * Resolve the hub root directory.
 *
 * Graduation always lands at the hub root (the parent of `.<ns>/`),
 * regardless of how many sources the hub declares.
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
export async function resolveHubRoot(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
): Promise<string> {
  return resolveHubRootFrom(fs, paths, paths.hubDir());
}

/**
 * The same walk, for a caller that holds no `EnvPort`.
 *
 * It starts from the paths service's resolved hub root. A caller that
 * holds a source-local `from` can still ask for the nearest canonical marker.
 */
export async function resolveHubRootFrom(
  fs: FileSystemPort,
  paths: PathsService,
  from: string = paths.hubDir(),
): Promise<string> {
  if (from === paths.hubDir()) return from;
  const resolved = await resolveHubDirectory(
    fs,
    {
      root: paths.hubDir(),
      namespace: paths.namespace,
      namespaceSource: "default",
      materialized: true,
    },
    from,
    dirname(paths.userRoot()),
  );
  return resolved.root;
}
