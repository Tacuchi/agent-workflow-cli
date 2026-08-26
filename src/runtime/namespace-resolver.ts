import { dirname, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { NAMESPACE_REGEX, type Namespace, normalizeNamespace } from "./namespace.js";

export type NamespaceSource = "flag" | "env" | "config" | "workspace" | "default";

export interface ResolvedNamespace {
  namespace: Namespace;
  source: NamespaceSource;
}

/**
 * The one workspace-scoped coordinate resolved before any service is built.
 *
 * A Workline workspace does not need a configuration block to exist.  Its
 * durable marker is exactly `.<namespace>/sessions/`; until that marker exists
 * the directory from which the command was invoked is still the workspace root
 * for read-only commands.  Keeping that fact here prevents each command from
 * independently walking cwd (or, worse, guessing a Git root).
 */
export interface WorklineDirectory {
  root: string;
  namespace: Namespace;
  namespaceSource: NamespaceSource;
  materialized: boolean;
}

export class WorklineDirectoryError extends Error {
  readonly code = "WORKLINE_NAMESPACE_AMBIGUOUS";

  constructor(
    public readonly root: string,
    public readonly namespaces: readonly Namespace[],
  ) {
    super(
      `More than one Workline namespace is materialized at ${root}: ${namespaces.join(", ")}. Pass --namespace <name> (or set AW_NAMESPACE) to select one.`,
    );
    this.name = "WorklineDirectoryError";
  }
}

export const DEFAULT_NAMESPACE = "workflow";
export const ENV_VAR_NAMESPACE = "AW_NAMESPACE";

/**
 * Absolute path to the CLI's global namespace-pin file. Single source shared by
 * the resolver (reads it, source "config") and `aw self namespace --pin` (writes
 * it), so the two can't drift on path.
 */
export function namespaceConfigFile(homeDir: string): string {
  return join(homeDir, ".config", "agent-workflow", "namespace");
}

export class NamespaceResolver {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly env: EnvPort,
  ) {}

  async resolve(flag: string | undefined): Promise<ResolvedNamespace> {
    const directory = await this.resolveDirectory(flag);
    return { namespace: directory.namespace, source: directory.namespaceSource };
  }

  /**
   * Resolve both the namespace and the root it scopes.  Explicit namespace
   * selection is deliberately honoured before discovery; an explicit request
   * for a different namespace must not be silently redirected by a neighbouring
   * marker.  Without an explicit selection, the closest ancestor with one
   * canonical marker wins, while two markers at that same level are a real
   * ambiguity rather than a reason to fall back to a global preference.
   */
  async resolveDirectory(flag: string | undefined): Promise<WorklineDirectory> {
    const cwd = this.env.cwd();
    if (flag !== undefined && flag.trim().length > 0) {
      const namespace = normalizeNamespace(flag);
      const root = await this.findMarkerForNamespace(cwd, namespace);
      return {
        root: root ?? cwd,
        namespace,
        namespaceSource: "flag",
        materialized: root !== null,
      };
    }

    const envVal = this.env.get(ENV_VAR_NAMESPACE);
    if (envVal !== undefined && envVal.trim().length > 0) {
      const namespace = normalizeNamespace(envVal);
      const root = await this.findMarkerForNamespace(cwd, namespace);
      return {
        root: root ?? cwd,
        namespace,
        namespaceSource: "env",
        materialized: root !== null,
      };
    }

    const workspace = await this.detectFromWorkspace(cwd);
    if (workspace !== null) {
      return {
        root: workspace.root,
        namespace: workspace.namespace,
        namespaceSource: "workspace",
        materialized: true,
      };
    }

    const configPath = namespaceConfigFile(this.env.homeDir());
    if (await this.fs.exists(configPath)) {
      const raw = await this.fs.readText(configPath);
      const namespace = normalizeNamespace(raw);
      const root = await this.findMarkerForNamespace(cwd, namespace);
      return {
        root: root ?? cwd,
        namespace,
        namespaceSource: "config",
        materialized: root !== null,
      };
    }
    const namespace = normalizeNamespace(DEFAULT_NAMESPACE);
    const root = await this.findMarkerForNamespace(cwd, namespace);
    return {
      root: root ?? cwd,
      namespace,
      namespaceSource: "default",
      materialized: root !== null,
    };
  }

  private async detectFromWorkspace(
    cwd: string,
  ): Promise<{ root: string; namespace: Namespace } | null> {
    let dir = cwd;
    while (true) {
      const matches = await this.namespacesAt(dir);
      if (matches.length > 1) throw new WorklineDirectoryError(dir, matches);
      const [namespace] = matches;
      if (namespace !== undefined) return { root: dir, namespace };
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private async findMarkerForNamespace(cwd: string, namespace: Namespace): Promise<string | null> {
    let dir = cwd;
    while (true) {
      if (await this.isCanonicalMarker(join(dir, `.${namespace}`, "sessions"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private async namespacesAt(dir: string): Promise<Namespace[]> {
    let entries: { name: string; path: string; type: string }[];
    try {
      entries = await this.fs.list(dir);
    } catch {
      return [];
    }
    const matches: Namespace[] = [];
    for (const entry of entries) {
      if (entry.type !== "dir" || !entry.name.startsWith(".")) continue;
      const candidate = entry.name.slice(1);
      if (!NAMESPACE_REGEX.test(candidate)) continue;
      if (await this.isCanonicalMarker(join(entry.path, "sessions"))) {
        matches.push(candidate as Namespace);
      }
    }
    return matches.sort();
  }

  private async isCanonicalMarker(path: string): Promise<boolean> {
    try {
      return (await this.fs.stat(path)).type === "dir";
    } catch {
      return false;
    }
  }
}
