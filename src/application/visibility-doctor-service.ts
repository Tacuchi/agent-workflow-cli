import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpHost } from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ParsedProjectBlock, parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";

export type VisibilityDriftStatus =
  | "ok"
  | "missing-paths"
  | "extra-paths"
  | "no-settings"
  | "no-project-block"
  | "global-pollution";

export interface VisibilityHostReport {
  host: McpHost;
  scope: "workspace" | "global";
  target: string;
  declared_paths: string[];
  registered_paths: string[];
  missing: string[];
  extra: string[];
  status: VisibilityDriftStatus;
  detail?: string;
}

export interface VisibilityDoctorInput {
  workspace?: string;
  global?: boolean;
}

export interface VisibilityDoctorResult {
  workspace_dir: string;
  reports: VisibilityHostReport[];
  global_reports: VisibilityHostReport[];
  summary: {
    ok: number;
    missing_paths: number;
    extra_paths: number;
    no_settings: number;
    global_pollution: number;
    no_project_block: number;
  };
}

export async function runVisibilityDoctor(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: VisibilityDoctorInput,
): Promise<VisibilityDoctorResult> {
  const workspace = input.workspace ? resolve(input.workspace) : resolve(env.cwd());
  const declared = await readDeclaredFuentes(fs, paths, workspace);
  const reports: VisibilityHostReport[] = [
    inspectClaude(workspace, declared, "workspace"),
    inspectCodex(workspace, declared, "workspace"),
    inspectWarp(workspace, declared, "workspace"),
  ];

  const globalReports: VisibilityHostReport[] = [];
  if (input.global) {
    const home = homedir();
    globalReports.push(inspectClaudeGlobal(home, declared), inspectCodexGlobal(home, declared));
  }

  return {
    workspace_dir: workspace,
    reports,
    global_reports: globalReports,
    summary: buildSummary([...reports, ...globalReports]),
  };
}

async function readDeclaredFuentes(
  fs: FileSystemPort,
  paths: PathsService,
  workspace: string,
): Promise<string[] | null> {
  const markers = paths.blockMarkers();
  for (const fname of ["CLAUDE.md", "AGENTS.md"]) {
    const file = join(workspace, fname);
    if (!(await fs.exists(file))) continue;
    const block: ParsedProjectBlock | null = parseProjectBlock(await fs.readText(file), markers);
    if (block && block.fuentes.length > 0) {
      return block.fuentes.map((f) => f.path).filter((p) => p && p.length > 0);
    }
  }
  return null;
}

function inspectClaude(
  scopeDir: string,
  declared: string[] | null,
  scope: "workspace" | "global",
): VisibilityHostReport {
  const target = join(scopeDir, ".claude", "settings.json");
  if (declared === null) {
    return baseNoBlock("claude", scope, target);
  }
  if (!existsSync(target)) {
    return {
      host: "claude",
      scope,
      target,
      declared_paths: declared,
      registered_paths: [],
      missing: [...declared],
      extra: [],
      status: declared.length === 0 ? "ok" : "no-settings",
      ...(declared.length > 0 ? { detail: `Falta ${target}` } : {}),
    };
  }
  const registered = readClaudeAdditionalDirs(target);
  return diffReport("claude", scope, target, declared, registered);
}

function inspectCodex(
  scopeDir: string,
  declared: string[] | null,
  scope: "workspace" | "global",
): VisibilityHostReport {
  const target = join(scopeDir, ".codex", "config.toml");
  if (declared === null) {
    return baseNoBlock("codex", scope, target);
  }
  if (!existsSync(target)) {
    return {
      host: "codex",
      scope,
      target,
      declared_paths: declared,
      registered_paths: [],
      missing: [...declared],
      extra: [],
      status: declared.length === 0 ? "ok" : "no-settings",
      ...(declared.length > 0 ? { detail: `Falta ${target}` } : {}),
    };
  }
  const registered = readCodexWritableRoots(target);
  return diffReport("codex", scope, target, declared, registered);
}

function inspectClaudeGlobal(home: string, declared: string[] | null): VisibilityHostReport {
  const target = join(home, ".claude", "settings.json");
  const registered = existsSync(target) ? readClaudeAdditionalDirs(target) : [];
  return globalPollutionReport("claude", target, declared ?? [], registered);
}

function inspectCodexGlobal(home: string, declared: string[] | null): VisibilityHostReport {
  const target = join(home, ".codex", "config.toml");
  const registered = existsSync(target) ? readCodexWritableRoots(target) : [];
  return globalPollutionReport("codex", target, declared ?? [], registered);
}

function inspectWarp(
  _scopeDir: string,
  _declared: string[] | null,
  scope: "workspace" | "global",
): VisibilityHostReport {
  // Warp Terminal does not have a workspace additionalDirectories concept.
  // Report is always ok — workspace path management is not applicable for Warp.
  const target = join(_scopeDir, ".warp", "settings.toml");
  return {
    host: "warp",
    scope,
    target,
    declared_paths: [],
    registered_paths: [],
    missing: [],
    extra: [],
    status: "ok",
    detail: "Warp Terminal does not require workspace path registration (noop)",
  };
}

function diffReport(
  host: McpHost,
  scope: "workspace" | "global",
  target: string,
  declared: string[],
  registered: string[],
): VisibilityHostReport {
  const declaredSet = new Set(declared.map(normalize));
  const registeredSet = new Set(registered.map(normalize));
  const missing = declared.filter((p) => !registeredSet.has(normalize(p)));
  const extra = registered.filter((p) => !declaredSet.has(normalize(p)));
  let status: VisibilityDriftStatus = "ok";
  if (missing.length > 0) status = "missing-paths";
  else if (extra.length > 0) status = "extra-paths";
  return {
    host,
    scope,
    target,
    declared_paths: declared,
    registered_paths: registered,
    missing,
    extra,
    status,
    ...(status !== "ok"
      ? {
          detail:
            status === "missing-paths"
              ? `${missing.length} path(s) declarado(s) no registrado(s) en ${target}`
              : `${extra.length} path(s) registrado(s) que no son fuentes declaradas`,
        }
      : {}),
  };
}

function globalPollutionReport(
  host: McpHost,
  target: string,
  declared: string[],
  registered: string[],
): VisibilityHostReport {
  const declaredSet = new Set(declared.map(normalize));
  const polluted = registered.filter((p) => declaredSet.has(normalize(p)));
  const status: VisibilityDriftStatus = polluted.length > 0 ? "global-pollution" : "ok";
  return {
    host,
    scope: "global",
    target,
    declared_paths: declared,
    registered_paths: registered,
    missing: [],
    extra: polluted,
    status,
    ...(polluted.length > 0
      ? {
          detail: `${polluted.length} path(s) del hub también en ${target}. Sugerencia: 'agent-workflow detach-multiroot --global --from-sources'`,
        }
      : {}),
  };
}

function baseNoBlock(
  host: McpHost,
  scope: "workspace" | "global",
  target: string,
): VisibilityHostReport {
  return {
    host,
    scope,
    target,
    declared_paths: [],
    registered_paths: [],
    missing: [],
    extra: [],
    status: "no-project-block",
    detail: "<NS>-PROJECT no encontrado o sin fuentes en CLAUDE.md/AGENTS.md",
  };
}

function readClaudeAdditionalDirs(file: string): string[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    if (!data || typeof data !== "object") return [];
    const perms = (data as Record<string, unknown>).permissions as
      | Record<string, unknown>
      | undefined;
    const arr = perms?.additionalDirectories;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function readCodexWritableRoots(file: string): string[] {
  try {
    const text = readFileSync(file, "utf-8");
    const m = text.match(/^additional_writable_roots\s*=\s*\[([\s\S]*?)\]/m);
    if (!m) return [];
    const block = m[1] ?? "";
    const items = [...block.matchAll(/["']([^"']+)["']/g)].map((x) => x[1] as string);
    return items;
  } catch {
    return [];
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function buildSummary(reports: VisibilityHostReport[]): VisibilityDoctorResult["summary"] {
  return {
    ok: reports.filter((r) => r.status === "ok").length,
    missing_paths: reports.filter((r) => r.status === "missing-paths").length,
    extra_paths: reports.filter((r) => r.status === "extra-paths").length,
    no_settings: reports.filter((r) => r.status === "no-settings").length,
    global_pollution: reports.filter((r) => r.status === "global-pollution").length,
    no_project_block: reports.filter((r) => r.status === "no-project-block").length,
  };
}
