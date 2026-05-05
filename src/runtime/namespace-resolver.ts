import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type Namespace, normalizeNamespace } from "./namespace.js";

export type NamespaceSource = "flag" | "env" | "config" | "default";

export interface ResolvedNamespace {
  namespace: Namespace;
  source: NamespaceSource;
}

export const DEFAULT_NAMESPACE = "agent-workflow";
export const ENV_VAR_NAMESPACE = "AW_NAMESPACE";

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
    const configPath = join(this.env.homeDir(), ".config", "agent-workflow", "namespace");
    if (await this.fs.exists(configPath)) {
      const raw = await this.fs.readText(configPath);
      return { namespace: normalizeNamespace(raw), source: "config" };
    }
    return { namespace: normalizeNamespace(DEFAULT_NAMESPACE), source: "default" };
  }
}
