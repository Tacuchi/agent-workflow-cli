import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { NAMESPACE_REGEX, type Namespace, normalizeNamespace } from "./namespace.js";

export type NamespaceSource = "flag" | "env" | "config" | "workspace" | "default";

export interface ResolvedNamespace {
  namespace: Namespace;
  source: NamespaceSource;
}

export const DEFAULT_NAMESPACE = "workflow";
export const ENV_VAR_NAMESPACE = "AW_NAMESPACE";

const LEGACY_NAMESPACE_DENYLIST = new Set<string>(["qtc"]);

export class NamespaceResolver {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly env: EnvPort,
  ) {}

  async resolve(flag: string | undefined): Promise<ResolvedNamespace> {
    if (flag !== undefined && flag.trim().length > 0) {
      return { namespace: normalizeNamespace(flag), source: "flag" };
    }
    const envVal = this.env.get(ENV_VAR_NAMESPACE);
    if (envVal !== undefined && envVal.trim().length > 0) {
      return { namespace: normalizeNamespace(envVal), source: "env" };
    }
    const workspaceNs = await this.detectFromWorkspace(this.env.cwd());
    if (workspaceNs !== null) {
      return { namespace: workspaceNs, source: "workspace" };
    }
    const configPath = join(this.env.homeDir(), ".config", "agent-workflow", "namespace");
    if (await this.fs.exists(configPath)) {
      const raw = await this.fs.readText(configPath);
      return { namespace: normalizeNamespace(raw), source: "config" };
    }
    return { namespace: normalizeNamespace(DEFAULT_NAMESPACE), source: "default" };
  }

  private async detectFromWorkspace(cwd: string): Promise<Namespace | null> {
    let entries: { name: string; path: string; type: string }[];
    try {
      entries = await this.fs.list(cwd);
    } catch {
      return null;
    }
    const matches: Namespace[] = [];
    for (const entry of entries) {
      if (entry.type !== "dir") continue;
      if (!entry.name.startsWith(".")) continue;
      const candidate = entry.name.slice(1);
      if (!NAMESPACE_REGEX.test(candidate)) continue;
      if (LEGACY_NAMESPACE_DENYLIST.has(candidate)) continue;
      const sessionsPath = join(entry.path, "sessions");
      if (await this.fs.exists(sessionsPath)) {
        matches.push(candidate as Namespace);
      }
    }
    if (matches.length === 1) return matches[0] ?? null;
    return null;
  }
}
