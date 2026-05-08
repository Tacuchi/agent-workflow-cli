// Plugin doctor — health check del plugin (manifest, hooks, MCP, skills).
//
// Phase 3 agnostic CLI: los servidores MCP esperados se leen de
// `runtime.expectedMcpServers` (vacio = no expectations).
//
// Post-session013 (RFC 002 G4 H-08): la gate `qtcContractVersion < 6.3`
// (dual-path legacy) fue eliminada. `installed_marker`, `qtc_core_installed`,
// `compat_ok` y `python_version` son siempre `null` (back-compat de shape).
//
// Estructura interna: `runPluginDoctor` orquesta 6 helpers self-contained
// (skills/manifests/hooks/mcp/exported-skills), cada uno devuelve `{...result, findings}`.
import { basename, join, resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ResolvedRuntime } from "../runtime/types.js";
import type { PathsService } from "./paths-service.js";
import type {
  DoctorFinding,
  ExportedSkillRecord,
  HooksInfoValue,
  McpServerInfo,
  SkillFrontmatterInfo,
} from "./plugin-doctor/common.js";
import { validateExportedSkills } from "./plugin-doctor/exported-skills.js";
import { parseHooks } from "./plugin-doctor/hooks.js";
import { parseManifests } from "./plugin-doctor/manifests.js";
import { validateMcp } from "./plugin-doctor/mcp.js";
import {
  checkFrontendDesignGeneralization,
  checkReadmeSync,
  checkSkillsFrontmatter,
} from "./plugin-doctor/skills.js";

export type {
  DoctorFinding,
  ExportedSkillRecord,
  HooksInfoValue,
  McpServerInfo,
  SkillFrontmatterInfo,
} from "./plugin-doctor/common.js";

export interface PluginDoctorInput {
  pluginRoot?: string;
  flow?: string;
  pluginVersion?: string;
  pluginName?: string;
  compatRange?: string;
  exportsFile?: string;
}

export interface DoctorOutput {
  status: "ok" | "warn" | "error";
  plugin: string;
  plugin_root: string;
  plugin_version: string;
  qtc_core_installed: string | null;
  compat_range: string | null;
  compat_ok: boolean | null;
  python_version: string | null;
  skills_count: number;
  readme_count_expected: number | null;
  readme_count_match: boolean | null;
  manifests: Record<string, string | null>;
  installed_marker: string | null;
  hooks: Record<string, HooksInfoValue>;
  mcp: Record<string, McpServerInfo>;
  skills: SkillFrontmatterInfo[];
  exported_skills: ExportedSkillRecord[];
  findings: DoctorFinding[];
}

export async function runPluginDoctor(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  runtime: ResolvedRuntime,
  input: PluginDoctorInput,
): Promise<{ data: DoctorOutput; hasError: boolean }> {
  const cwd = env.cwd();
  const pluginRoot = input.pluginRoot
    ? resolve(input.pluginRoot.startsWith("/") ? input.pluginRoot : join(cwd, input.pluginRoot))
    : cwd;
  const flow = input.flow ?? "core";
  const compatRange = input.compatRange ?? null;
  const skillsDir = join(pluginRoot, "skills");
  const readmePath = join(pluginRoot, "README.md");

  const skillsResult = await checkSkillsFrontmatter(skillsDir, fs);
  const readmeResult = await checkReadmeSync(readmePath, skillsResult.skillsCount, fs);
  const fdFindings = await checkFrontendDesignGeneralization(skillsDir, pluginRoot, fs);
  const manifestsResult = await parseManifests(pluginRoot, fs, input.pluginVersion ?? null);
  const pluginVersion = manifestsResult.canonicalVersion ?? "unknown";
  const fallbackName = basename(pluginRoot) || `${paths.namespace}-${flow}`;
  const pluginName = input.pluginName ?? manifestsResult.manifestPluginName ?? fallbackName;
  const hooksResult = await parseHooks(pluginRoot, fs);
  const mcpResult = await validateMcp(pluginRoot, runtime, env, fs);
  const exportedResult = await validateExportedSkills(
    skillsDir,
    pluginRoot,
    input.exportsFile,
    pluginName,
    skillsResult.skillsInfo,
    fs,
  );

  const findings = [
    ...skillsResult.findings,
    ...readmeResult.findings,
    ...fdFindings,
    ...manifestsResult.findings,
    ...hooksResult.findings,
    ...mcpResult.findings,
    ...exportedResult.findings,
  ];
  const hasError = findings.some((f) => f.level === "error");
  const hasWarn = findings.some((f) => f.level === "warn");
  const status: "ok" | "warn" | "error" = hasError ? "error" : hasWarn ? "warn" : "ok";

  return {
    data: {
      status,
      plugin: pluginName,
      plugin_root: pluginRoot,
      plugin_version: pluginVersion,
      qtc_core_installed: null,
      compat_range: compatRange,
      compat_ok: null,
      python_version: null,
      skills_count: skillsResult.skillsCount,
      readme_count_expected: readmeResult.readmeCountExpected,
      readme_count_match: readmeResult.readmeCountMatch,
      manifests: manifestsResult.manifestsInfo,
      installed_marker: null,
      hooks: hooksResult.hooksInfo,
      mcp: mcpResult.mcpInfo,
      skills: skillsResult.skillsInfo,
      exported_skills: exportedResult.exportedInfo,
      findings,
    },
    hasError,
  };
}
