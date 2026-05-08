// Plugin doctor — health check del plugin (manifest, hooks, MCP, skills).
//
// Phase 3 agnostic CLI: los servidores MCP esperados se leen de
// `runtime.expectedMcpServers` (vacio = no expectations).
//
// Post-session013 (RFC 002 G4 H-08): la gate `qtcContractVersion < 6.3`
// (dual-path legacy) fue eliminada. Todo plugin actual opera en single-path,
// por lo que `installed_marker`, `qtc_core_installed`, `compat_ok` y
// `python_version` son siempre `null` en el output. Se mantienen los campos
// en `DoctorOutput` por back-compat de shape, no de comportamiento.
//
// `exported_skills` se lee de `.claude-plugin/plugin.json:exportedSkills` o
// de un --exports-file JSON.
//
// Estructura interna (post-session011 G2 refactor):
// `runPluginDoctor` orquesta 7 helpers self-contained, cada uno con
// complexity <= 15. Cada helper retorna `{...result, findings}` y el orchestrator
// agrega los findings al final.
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ResolvedRuntime } from "../runtime/types.js";
import type { PathsService } from "./paths-service.js";

const SESSION_SPECIFIC_MARKERS = [
  "session034",
  "idNegocioFinanciero",
  "usuario-editar.component",
  "AuthUserServiceImpl",
  "tb_acceso_usuario_rol",
];

export interface PluginDoctorInput {
  pluginRoot?: string;
  flow?: string;
  pluginVersion?: string;
  pluginName?: string;
  compatRange?: string;
  exportsFile?: string;
}

export interface DoctorFinding {
  level: "error" | "warn";
  file: string;
  msg: string;
}

export interface SkillFrontmatterInfo {
  dir: string;
  name: string | null;
  version: string | null;
}

export type HooksInfoValue = string[] | "invalid-structure" | null;
export type McpServerInfo = "missing" | { dsn_env: string | null; env_set: boolean | null };

export interface ExportedSkillRecord {
  namespace: string;
  version_declared: string | null;
  since: string | null;
  exists_in_disk: boolean;
  frontmatter_ok: boolean;
  version_in_skill?: string;
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

// ---------- 1. Skills frontmatter ----------

interface SkillsCheckResult {
  skillsCount: number;
  skillsInfo: SkillFrontmatterInfo[];
  findings: DoctorFinding[];
}

async function checkSkillsFrontmatter(
  skillsDir: string,
  fs: FileSystemPort,
): Promise<SkillsCheckResult> {
  const findings: DoctorFinding[] = [];
  const skillsInfo: SkillFrontmatterInfo[] = [];
  const skillDirs = await collectSkillDirs(skillsDir, fs);
  for (const sd of skillDirs) {
    const skillMd = join(sd, "SKILL.md");
    const dirName = sd.split(sep).pop() ?? "";
    const parsed = await parseSkillFile(skillMd, fs);
    if (parsed.error) {
      findings.push({ level: "error", file: skillMd, msg: parsed.error });
      skillsInfo.push({ dir: dirName, name: null, version: null });
      continue;
    }
    validateSkillFrontmatter(skillMd, dirName, parsed.frontmatter, findings);
    skillsInfo.push({
      dir: dirName,
      name: parsed.frontmatter.name ?? null,
      version: parsed.frontmatter.version ?? null,
    });
  }
  return { skillsCount: skillDirs.length, skillsInfo, findings };
}

async function collectSkillDirs(skillsDir: string, fs: FileSystemPort): Promise<string[]> {
  const out: string[] = [];
  if (!(await fs.exists(skillsDir))) return out;
  const entries = await fs.list(skillsDir);
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    const skillMd = join(entry.path, "SKILL.md");
    if (await fs.exists(skillMd)) out.push(entry.path);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

interface ParsedSkill {
  frontmatter: Record<string, string>;
  error: string | null;
}

async function parseSkillFile(skillMd: string, fs: FileSystemPort): Promise<ParsedSkill> {
  let content: string;
  try {
    content = await fs.readText(skillMd);
  } catch (e) {
    return { frontmatter: {}, error: `cannot read: ${(e as Error).message}` };
  }
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || (lines[0] ?? "").trim() !== "---") {
    return { frontmatter: {}, error: "missing frontmatter opening ---" };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: {}, error: "missing frontmatter closing ---" };
  }
  const fm: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const m = (lines[i] ?? "").match(/^(\w+):\s*(.+)$/);
    if (m?.[1] && m[2] !== undefined) fm[m[1]] = m[2].trim();
  }
  return { frontmatter: fm, error: null };
}

function validateSkillFrontmatter(
  skillMd: string,
  dirName: string,
  fm: Record<string, string>,
  findings: DoctorFinding[],
): void {
  const { name, version, description } = fm;
  if (!name) {
    findings.push({ level: "error", file: skillMd, msg: "missing 'name' in frontmatter" });
  } else if (name !== dirName) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `frontmatter name '${name}' differs from directory '${dirName}'`,
    });
  }
  if (!description) {
    findings.push({ level: "error", file: skillMd, msg: "missing 'description' in frontmatter" });
  }
  if (!version) {
    findings.push({ level: "warn", file: skillMd, msg: "missing 'version' in frontmatter" });
  } else if (!/^\d+\.\d+\.\d+$/.test(version)) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `version '${version}' not semver-compatible`,
    });
  }
}

// ---------- 2. README sync ----------

interface ReadmeCheckResult {
  readmeCountExpected: number | null;
  readmeCountMatch: boolean | null;
  findings: DoctorFinding[];
}

async function checkReadmeSync(
  readmePath: string,
  skillsCount: number,
  fs: FileSystemPort,
): Promise<ReadmeCheckResult> {
  const findings: DoctorFinding[] = [];
  if (!(await fs.exists(readmePath))) {
    findings.push({ level: "warn", file: "README.md", msg: "README.md not found at plugin root" });
    return { readmeCountExpected: null, readmeCountMatch: null, findings };
  }
  let readmeText: string;
  try {
    readmeText = await fs.readText(readmePath);
  } catch (e) {
    findings.push({
      level: "warn",
      file: "README.md",
      msg: `cannot read: ${(e as Error).message}`,
    });
    return { readmeCountExpected: null, readmeCountMatch: null, findings };
  }
  const m = readmeText.match(/\*\*Skills\*\*\s*\((\d+)/);
  if (!m?.[1]) {
    return { readmeCountExpected: null, readmeCountMatch: null, findings };
  }
  const readmeCountExpected = Number.parseInt(m[1], 10);
  const readmeCountMatch = readmeCountExpected === skillsCount;
  if (!readmeCountMatch) {
    findings.push({
      level: "warn",
      file: "README.md",
      msg: `Skills count mismatch: README claims ${readmeCountExpected}, actual ${skillsCount}`,
    });
  }
  return { readmeCountExpected, readmeCountMatch, findings };
}

// ---------- 3. Frontend-design generalization ----------

async function checkFrontendDesignGeneralization(
  skillsDir: string,
  pluginRoot: string,
  fs: FileSystemPort,
): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const fdDir = join(skillsDir, "frontend-design");
  if (!(await fs.exists(skillsDir)) || !(await fs.exists(fdDir))) return findings;
  const mdFiles = await collectMarkdownFiles(fs, fdDir);
  mdFiles.sort((a, b) => a.localeCompare(b));
  for (const mdFile of mdFiles) {
    let text: string;
    try {
      text = await fs.readText(mdFile);
    } catch {
      continue;
    }
    scanForSessionMarkers(text, mdFile, pluginRoot, findings);
  }
  return findings;
}

function scanForSessionMarkers(
  text: string,
  mdFile: string,
  pluginRoot: string,
  findings: DoctorFinding[],
): void {
  for (const marker of SESSION_SPECIFIC_MARKERS) {
    if (!text.includes(marker)) continue;
    const rel = relative(pluginRoot, mdFile).split(sep).join("/");
    findings.push({
      level: "error",
      file: rel,
      msg: `contains session-specific name '${marker}' (frontend-design must stay generalized)`,
    });
  }
}

// ---------- 4. Manifest version drift + qtcContractVersion gate ----------

interface ManifestsResult {
  manifestsInfo: Record<string, string | null>;
  canonicalVersion: string | null;
  manifestPluginName: string | null;
  manifestQtcContractVersion: string | null;
  findings: DoctorFinding[];
}

async function parseManifests(
  pluginRoot: string,
  fs: FileSystemPort,
  inputPluginVersion: string | null,
): Promise<ManifestsResult> {
  const findings: DoctorFinding[] = [];
  const manifestsInfo: Record<string, string | null> = {};
  let canonicalVersion: string | null = inputPluginVersion;
  let manifestPluginName: string | null = null;
  let manifestQtcContractVersion: string | null = null;
  for (const relPath of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const parsed = await parseManifestFile(join(pluginRoot, relPath), relPath, fs);
    manifestsInfo[relPath] = parsed.version;
    findings.push(...parsed.findings);
    if (parsed.parseError) continue;
    if (manifestPluginName === null && parsed.name !== null) {
      manifestPluginName = parsed.name;
    }
    if (canonicalVersion === null && parsed.version !== null) {
      canonicalVersion = parsed.version;
    } else if (
      canonicalVersion !== null &&
      parsed.version !== null &&
      parsed.version !== canonicalVersion
    ) {
      findings.push({
        level: "error",
        file: relPath,
        msg: `version drift: manifest=${parsed.version} vs declared=${canonicalVersion}`,
      });
    }
    if (manifestQtcContractVersion === null && parsed.qtcContractVersion !== null) {
      manifestQtcContractVersion = parsed.qtcContractVersion;
    }
  }
  return {
    manifestsInfo,
    canonicalVersion,
    manifestPluginName,
    manifestQtcContractVersion,
    findings,
  };
}

interface ParsedManifest {
  version: string | null;
  name: string | null;
  qtcContractVersion: string | null;
  parseError: boolean;
  findings: DoctorFinding[];
}

async function parseManifestFile(
  manifestPath: string,
  relPath: string,
  fs: FileSystemPort,
): Promise<ParsedManifest> {
  const findings: DoctorFinding[] = [];
  if (!(await fs.exists(manifestPath))) {
    findings.push({ level: "warn", file: relPath, msg: "manifest missing" });
    return { version: null, name: null, qtcContractVersion: null, parseError: true, findings };
  }
  let raw: string;
  try {
    raw = await fs.readText(manifestPath);
  } catch (e) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { version: null, name: null, qtcContractVersion: null, parseError: true, findings };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { version: null, name: null, qtcContractVersion: null, parseError: true, findings };
  }
  if (!isRecord(data)) {
    return { version: null, name: null, qtcContractVersion: null, parseError: false, findings };
  }
  return {
    version: typeof data.version === "string" ? data.version : null,
    name: typeof data.name === "string" && data.name.length > 0 ? data.name : null,
    qtcContractVersion:
      typeof data.qtcContractVersion === "string" ? data.qtcContractVersion : null,
    parseError: false,
    findings,
  };
}

// ---------- 7. Hooks JSON ----------

interface HooksResult {
  hooksInfo: Record<string, HooksInfoValue>;
  findings: DoctorFinding[];
}

async function parseHooks(pluginRoot: string, fs: FileSystemPort): Promise<HooksResult> {
  const findings: DoctorFinding[] = [];
  const hooksInfo: Record<string, HooksInfoValue> = {};
  for (const relPath of ["hooks/hooks.json", "codex-hooks/hooks.json"]) {
    const result = await parseHookFile(join(pluginRoot, relPath), relPath, fs);
    hooksInfo[relPath] = result.value;
    findings.push(...result.findings);
  }
  return { hooksInfo, findings };
}

async function parseHookFile(
  hookPath: string,
  relPath: string,
  fs: FileSystemPort,
): Promise<{ value: HooksInfoValue; findings: DoctorFinding[] }> {
  const findings: DoctorFinding[] = [];
  if (!(await fs.exists(hookPath))) {
    findings.push({ level: "warn", file: relPath, msg: "hooks file missing" });
    return { value: null, findings };
  }
  let raw: string;
  try {
    raw = await fs.readText(hookPath);
  } catch (e) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { value: null, findings };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    findings.push({
      level: "error",
      file: relPath,
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { value: null, findings };
  }
  if (!isRecord(data) || !("hooks" in data) || !isRecord(data.hooks)) {
    findings.push({
      level: "warn",
      file: relPath,
      msg: "hooks JSON missing top-level 'hooks' key",
    });
    return { value: "invalid-structure", findings };
  }
  return { value: Object.keys(data.hooks).sort(), findings };
}

// ---------- 8. MCP server expectations ----------

interface McpResult {
  mcpInfo: Record<string, McpServerInfo>;
  findings: DoctorFinding[];
}

async function validateMcp(
  pluginRoot: string,
  runtime: ResolvedRuntime,
  env: EnvPort,
  fs: FileSystemPort,
): Promise<McpResult> {
  const findings: DoctorFinding[] = [];
  const mcpInfo: Record<string, McpServerInfo> = {};
  const mcpPath = join(pluginRoot, ".mcp.json");
  const expectedMcpServers = runtime.expectedMcpServers ?? [];
  if (expectedMcpServers.length === 0 || !(await fs.exists(mcpPath))) {
    return { mcpInfo, findings };
  }
  let mcpData: unknown = null;
  try {
    mcpData = JSON.parse(await fs.readText(mcpPath));
  } catch (e) {
    findings.push({
      level: "error",
      file: ".mcp.json",
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { mcpInfo, findings };
  }
  if (!isRecord(mcpData)) return { mcpInfo, findings };
  const servers = isRecord(mcpData.mcpServers) ? mcpData.mcpServers : {};
  for (const exp of expectedMcpServers) {
    const server = (servers as Record<string, unknown>)[exp];
    mcpInfo[exp] = validateMcpServer(server, exp, env, findings);
  }
  return { mcpInfo, findings };
}

function validateMcpServer(
  server: unknown,
  exp: string,
  env: EnvPort,
  findings: DoctorFinding[],
): McpServerInfo {
  if (server === undefined) {
    findings.push({
      level: "warn",
      file: ".mcp.json",
      msg: `expected server '${exp}' not configured`,
    });
    return "missing";
  }
  const dsnRaw =
    isRecord(server) && isRecord(server.env) && typeof server.env.DSN === "string"
      ? server.env.DSN
      : "";
  const m = dsnRaw.match(/^\$\{(\w+)\}$/);
  if (!m?.[1]) return { dsn_env: null, env_set: null };
  const envVar = m[1];
  const envSet = Boolean(env.get(envVar));
  if (!envSet) {
    findings.push({
      level: "warn",
      file: ".mcp.json",
      msg: `env var ${envVar} not set (required by mcp server '${exp}')`,
    });
  }
  return { dsn_env: envVar, env_set: envSet };
}

// ---------- 10. Exported skills (registry vs disk) ----------

interface ExportedSkillsResult {
  exportedInfo: ExportedSkillRecord[];
  findings: DoctorFinding[];
}

async function validateExportedSkills(
  skillsDir: string,
  pluginRoot: string,
  exportsFile: string | undefined,
  pluginName: string,
  skillsInfo: SkillFrontmatterInfo[],
  fs: FileSystemPort,
): Promise<ExportedSkillsResult> {
  const findings: DoctorFinding[] = [];
  const exportedInfo: ExportedSkillRecord[] = [];
  const exportedSkills = await loadExportedSkills(fs, pluginRoot, exportsFile, pluginName);
  const skillsByDirName = new Map<string, SkillFrontmatterInfo>();
  for (const s of skillsInfo) {
    if (s.name) skillsByDirName.set(s.dir, s);
  }
  const skillsDirExists = await fs.exists(skillsDir);
  for (const exp of exportedSkills) {
    const record = await validateSingleExportedSkill(
      exp,
      skillsDir,
      skillsDirExists,
      skillsByDirName,
      fs,
      findings,
    );
    exportedInfo.push(record);
  }
  return { exportedInfo, findings };
}

async function validateSingleExportedSkill(
  exp: ExportedSkillEntry,
  skillsDir: string,
  skillsDirExists: boolean,
  skillsByDirName: Map<string, SkillFrontmatterInfo>,
  fs: FileSystemPort,
  findings: DoctorFinding[],
): Promise<ExportedSkillRecord> {
  const expSkillName = exp.skill;
  const record: ExportedSkillRecord = {
    namespace: exp.namespace,
    version_declared: exp.version ?? null,
    since: exp.since ?? null,
    exists_in_disk: false,
    frontmatter_ok: false,
  };
  if (!skillsDirExists) {
    findings.push({
      level: "error",
      file: "skills/",
      msg: `exported skill '${exp.namespace}' registered but plugin has no skills/ directory`,
    });
    return record;
  }
  const targetSkill = join(skillsDir, expSkillName, "SKILL.md");
  if (!(await fs.exists(targetSkill))) {
    findings.push({
      level: "error",
      file: `skills/${expSkillName}/SKILL.md`,
      msg: `exported skill '${exp.namespace}' registered but not found in plugin's skills/ directory — fix the register_exported_skill call or add the SKILL.md`,
    });
    return record;
  }
  record.exists_in_disk = true;
  const diskSkill = skillsByDirName.get(expSkillName);
  if (!diskSkill?.name || !diskSkill.version) {
    findings.push({
      level: "error",
      file: `skills/${expSkillName}/SKILL.md`,
      msg: "exported skill SKILL.md missing required frontmatter (name + version)",
    });
    return record;
  }
  record.frontmatter_ok = true;
  record.version_in_skill = diskSkill.version;
  if (exp.version && diskSkill.version !== exp.version) {
    findings.push({
      level: "warn",
      file: `skills/${expSkillName}/SKILL.md`,
      msg: `exported skill version drift: registry declares ${exp.version}, SKILL.md frontmatter declares ${diskSkill.version}`,
    });
  }
  return record;
}

// ---------- exported skills registry loader (split for cx <= 15) ----------

interface ExportedSkillEntry {
  plugin: string;
  skill: string;
  namespace: string;
  version: string | null;
  since: string | null;
}

async function loadExportedSkills(
  fs: FileSystemPort,
  pluginRoot: string,
  exportsFile: string | undefined,
  pluginName: string,
): Promise<ExportedSkillEntry[]> {
  const sources = exportsFile
    ? await readExportsFromCustomFile(fs, exportsFile)
    : await readExportsFromClaudeManifest(fs, pluginRoot);
  return parseExportedSkillEntries(sources, pluginName);
}

async function readExportsFromCustomFile(
  fs: FileSystemPort,
  exportsFile: string,
): Promise<unknown[]> {
  if (!(await fs.exists(exportsFile))) return [];
  try {
    return [JSON.parse(await fs.readText(exportsFile))];
  } catch {
    return [];
  }
}

async function readExportsFromClaudeManifest(
  fs: FileSystemPort,
  pluginRoot: string,
): Promise<unknown[]> {
  const claudeManifest = join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!(await fs.exists(claudeManifest))) return [];
  try {
    const data = JSON.parse(await fs.readText(claudeManifest));
    if (isRecord(data) && Array.isArray(data.exportedSkills)) {
      return [data.exportedSkills];
    }
  } catch {
    // ignore
  }
  return [];
}

function parseExportedSkillEntries(sources: unknown[], pluginName: string): ExportedSkillEntry[] {
  const out: ExportedSkillEntry[] = [];
  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (const item of src) {
      const entry = parseExportedSkillItem(item, pluginName);
      if (entry) out.push(entry);
    }
  }
  return out;
}

function parseExportedSkillItem(item: unknown, pluginName: string): ExportedSkillEntry | null {
  if (!isRecord(item)) return null;
  const skill = typeof item.skill === "string" ? item.skill : null;
  if (!skill) return null;
  const plugin =
    typeof item.plugin === "string" && item.plugin.length > 0 ? item.plugin : pluginName;
  const namespace =
    typeof item.namespace === "string" && item.namespace.length > 0
      ? item.namespace
      : `${plugin}:${skill}`;
  return {
    plugin,
    skill,
    namespace,
    version: typeof item.version === "string" ? item.version : null,
    since: typeof item.since === "string" ? item.since : null,
  };
}

// ---------- low-level utilities (unchanged) ----------

async function collectMarkdownFiles(fs: FileSystemPort, dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
    try {
      entries = await fs.list(current);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.type === "dir") stack.push(e.path);
      else if (e.type === "file" && extname(e.name).toLowerCase() === ".md") out.push(e.path);
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
