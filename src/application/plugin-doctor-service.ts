// Plugin doctor — health check del plugin qtc-* (manifest, hooks, MCP, skills).
// Comportamiento dependiente de `qtcContractVersion` del manifest:
//   - >= 6.3 (single-path post-session032): skip checks de Python (marker
//     `~/.qtc/<flow>/.plugin-version`, qtc-core lib en `~/.qtc/lib/`, scripts
//     `qtc-utils.py` / `branch-check.py`, version de python3). Estos artefactos
//     ya no existen en plugins single-path.
//   - < 6.3 (legacy dual-path): chequea presencia de scripts y marker como
//     antes; util para detectar instalaciones rotas en versiones antiguas.
// `exported_skills` se lee de `.claude-plugin/plugin.json:exportedSkills` o
// de un --exports-file JSON.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";

const SESSION_SPECIFIC_MARKERS = [
  "session034",
  "idNegocioFinanciero",
  "usuario-editar.component",
  "AuthUserServiceImpl",
  "tb_acceso_usuario_rol",
];

const DEFAULT_EXPECTED_SCRIPTS_BY_FLOW: Record<string, string[]> = {
  dev: ["qtc-utils.py", "branch-check.py"],
  design: ["qtc-utils.py"],
  analyze: ["qtc-utils.py"],
};

export interface PluginDoctorInput {
  pluginRoot?: string;
  flow?: string;
  pluginVersion?: string;
  pluginName?: string;
  compatRange?: string;
  expectedScripts?: string[];
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

export interface ScriptInfo {
  local: boolean;
  installed: boolean;
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
  scripts: Record<string, ScriptInfo>;
  hooks: Record<string, HooksInfoValue>;
  mcp: Record<string, McpServerInfo>;
  skills: SkillFrontmatterInfo[];
  exported_skills: ExportedSkillRecord[];
  findings: DoctorFinding[];
}

export async function runPluginDoctor(
  fs: FileSystemPort,
  env: EnvPort,
  input: PluginDoctorInput,
): Promise<{ data: DoctorOutput; hasError: boolean }> {
  const cwd = env.cwd();
  const pluginRoot = input.pluginRoot
    ? resolve(input.pluginRoot.startsWith("/") ? input.pluginRoot : join(cwd, input.pluginRoot))
    : cwd;
  const flow = input.flow ?? "core";
  const pluginVersion = input.pluginVersion ?? "unknown";
  const pluginName = input.pluginName ?? `qtc-${flow}`;
  const compatRange = input.compatRange ?? null;

  const skillsDir = join(pluginRoot, "skills");
  const readmePath = join(pluginRoot, "README.md");

  const findings: DoctorFinding[] = [];
  const skillsInfo: SkillFrontmatterInfo[] = [];

  // 1. Skills frontmatter.
  const skillDirs: string[] = [];
  if (await fs.exists(skillsDir)) {
    const entries = await fs.list(skillsDir);
    for (const entry of entries) {
      if (entry.type !== "dir") continue;
      const skillMd = join(entry.path, "SKILL.md");
      if (await fs.exists(skillMd)) skillDirs.push(entry.path);
    }
    skillDirs.sort((a, b) => a.localeCompare(b));
  }
  const skillsCount = skillDirs.length;

  for (const sd of skillDirs) {
    const skillMd = join(sd, "SKILL.md");
    const dirName = sd.split(sep).pop() ?? "";
    let content: string;
    try {
      content = await fs.readText(skillMd);
    } catch (e) {
      findings.push({ level: "error", file: skillMd, msg: `cannot read: ${(e as Error).message}` });
      skillsInfo.push({ dir: dirName, name: null, version: null });
      continue;
    }
    const lines = content.split(/\r?\n/);
    if (lines.length === 0 || (lines[0] ?? "").trim() !== "---") {
      findings.push({ level: "error", file: skillMd, msg: "missing frontmatter opening ---" });
      skillsInfo.push({ dir: dirName, name: null, version: null });
      continue;
    }
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) {
      findings.push({ level: "error", file: skillMd, msg: "missing frontmatter closing ---" });
      skillsInfo.push({ dir: dirName, name: null, version: null });
      continue;
    }
    const fm: Record<string, string> = {};
    for (let i = 1; i < endIdx; i++) {
      const m = (lines[i] ?? "").match(/^(\w+):\s*(.+)$/);
      if (m?.[1] && m[2] !== undefined) fm[m[1]] = m[2].trim();
    }
    const name = fm.name ?? null;
    const version = fm.version ?? null;
    const description = fm.description ?? null;

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
    skillsInfo.push({ dir: dirName, name, version });
  }

  // 2. README sync check.
  let readmeCountExpected: number | null = null;
  let readmeCountMatch: boolean | null = null;
  if (await fs.exists(readmePath)) {
    try {
      const readmeText = await fs.readText(readmePath);
      const m = readmeText.match(/\*\*Skills\*\*\s*\((\d+)/);
      if (m?.[1]) {
        readmeCountExpected = Number.parseInt(m[1], 10);
        readmeCountMatch = readmeCountExpected === skillsCount;
        if (!readmeCountMatch) {
          findings.push({
            level: "warn",
            file: "README.md",
            msg: `Skills count mismatch: README claims ${readmeCountExpected}, actual ${skillsCount}`,
          });
        }
      }
    } catch (e) {
      findings.push({
        level: "warn",
        file: "README.md",
        msg: `cannot read: ${(e as Error).message}`,
      });
    }
  } else {
    findings.push({ level: "warn", file: "README.md", msg: "README.md not found at plugin root" });
  }

  // 3. frontend-design generalization.
  const fdDir = join(skillsDir, "frontend-design");
  if ((await fs.exists(skillsDir)) && (await fs.exists(fdDir))) {
    const mdFiles = await collectMarkdownFiles(fs, fdDir);
    mdFiles.sort((a, b) => a.localeCompare(b));
    for (const mdFile of mdFiles) {
      let text: string;
      try {
        text = await fs.readText(mdFile);
      } catch {
        continue;
      }
      for (const marker of SESSION_SPECIFIC_MARKERS) {
        if (text.includes(marker)) {
          const rel = relative(pluginRoot, mdFile).split(sep).join("/");
          findings.push({
            level: "error",
            file: rel,
            msg: `contains session-specific name '${marker}' (frontend-design must stay generalized)`,
          });
        }
      }
    }
  }

  // 4. Manifest version drift + qtcContractVersion gate.
  const manifestsInfo: Record<string, string | null> = {};
  let manifestQtcContractVersion: string | null = null;
  for (const relPath of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const manifestPath = join(pluginRoot, relPath);
    if (!(await fs.exists(manifestPath))) {
      findings.push({ level: "warn", file: relPath, msg: "manifest missing" });
      manifestsInfo[relPath] = null;
      continue;
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
      manifestsInfo[relPath] = null;
      continue;
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
      manifestsInfo[relPath] = null;
      continue;
    }
    const manifestVersion =
      isRecord(data) && typeof data.version === "string" ? data.version : null;
    manifestsInfo[relPath] = manifestVersion;
    if (manifestVersion !== pluginVersion) {
      findings.push({
        level: "error",
        file: relPath,
        msg: `version drift: manifest=${manifestVersion} vs declared=${pluginVersion}`,
      });
    }
    if (
      manifestQtcContractVersion === null &&
      isRecord(data) &&
      typeof data.qtcContractVersion === "string"
    ) {
      manifestQtcContractVersion = data.qtcContractVersion;
    }
  }
  // Si el manifest declara qtcContractVersion >= 6.3, el plugin opera en
  // single-path y no debe chequearse la presencia de artefactos Python.
  const isSinglePathContract = isContractVersionAtLeast(manifestQtcContractVersion, 6, 3);

  // 5/5b/6 — checks legacy de era dual-path. En contracts >= 6.3 (single-path)
  // estos artefactos ya no existen físicamente: el plugin son SKILLs+HOOKS+MCP
  // puro y el runtime CLI vive como paquete npm independiente.
  const home = homedir();
  const pluginCacheDir = join(home, ".qtc", flow);
  let installedMarker: string | null = null;
  let qtcCoreInstalled: string | null = null;
  let compatOk: boolean | null = null;
  const scriptsInfo: Record<string, ScriptInfo> = {};

  if (!isSinglePathContract) {
    // 5. Marker file (~/.qtc/<flow>/.plugin-version) — solo legacy.
    const markerFile = join(pluginCacheDir, ".plugin-version");
    if (await fs.exists(markerFile)) {
      try {
        const raw = (await fs.readText(markerFile)).trim();
        installedMarker = raw.length > 0 ? raw : null;
      } catch (e) {
        findings.push({
          level: "warn",
          file: markerFile,
          msg: `cannot read marker: ${(e as Error).message}`,
        });
      }
      if (installedMarker && installedMarker !== pluginVersion) {
        findings.push({
          level: "warn",
          file: markerFile,
          msg: `installed plugin v${installedMarker} differs from declared v${pluginVersion} — reinstall/re-sync`,
        });
      }
    }

    // 5b. qtc-core lib install state + compat range — solo legacy.
    const coreLibMarker = join(home, ".qtc", "lib", ".qtc-core-version");
    if (await fs.exists(coreLibMarker)) {
      try {
        const raw = (await fs.readText(coreLibMarker)).trim();
        qtcCoreInstalled = raw.length > 0 ? raw : null;
      } catch {
        // ignore
      }
    }
    if (compatRange) {
      if (!qtcCoreInstalled) {
        findings.push({
          level: "error",
          file: coreLibMarker,
          msg: `plugin requiere qtc-core ${compatRange} pero ~/.qtc/lib/.qtc-core-version no existe — instalá qtc-core o reiniciá la sesión para que SessionStart hook lo copie`,
        });
        compatOk = false;
      } else {
        compatOk = semverSatisfies(qtcCoreInstalled, compatRange);
        if (compatOk === null) {
          findings.push({
            level: "warn",
            file: "compat_range",
            msg: `no pude parsear compat_range '${compatRange}' (esperado '~X.Y.Z', '^X.Y.Z' o 'X.Y.Z') — validación contra qtc-core skipped`,
          });
        } else if (!compatOk) {
          findings.push({
            level: "error",
            file: "compat_range",
            msg: `qtc-core instalado v${qtcCoreInstalled} NO satisface compat_range del plugin (${compatRange}) — el plugin va a fallar en runtime`,
          });
        }
      }
    }

    // 6. Scripts (./scripts/ + ~/.qtc/<flow>/scripts/) — solo legacy.
    const expectedScripts = input.expectedScripts ??
      DEFAULT_EXPECTED_SCRIPTS_BY_FLOW[flow] ?? ["qtc-utils.py"];
    const localScriptsDir = join(pluginRoot, "scripts");
    const installedScriptsDir = join(pluginCacheDir, "scripts");
    for (const name of expectedScripts) {
      const local = join(localScriptsDir, name);
      const installed = join(installedScriptsDir, name);
      const localOk = await fs.exists(local);
      const installedOk = await fs.exists(installed);
      scriptsInfo[name] = { local: localOk, installed: installedOk };
      if (!localOk) {
        findings.push({
          level: "error",
          file: `scripts/${name}`,
          msg: "script missing in repo ./scripts/",
        });
      }
      if (!installedOk) {
        findings.push({
          level: "warn",
          file: installed,
          msg: `script not installed (SessionStart hook debe copiarlo desde ./scripts/${name})`,
        });
      }
      if (localOk && installedOk) {
        try {
          const a = await fs.stat(local);
          const b = await fs.stat(installed);
          if (a.size !== b.size) {
            findings.push({
              level: "warn",
              file: `scripts/${name}`,
              msg: "local and installed copies differ in size — reinstall para sincronizar",
            });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // 7. Hooks JSON.
  const hooksInfo: Record<string, HooksInfoValue> = {};
  for (const relPath of ["hooks/hooks.json", "codex-hooks/hooks.json"]) {
    const hookPath = join(pluginRoot, relPath);
    if (!(await fs.exists(hookPath))) {
      findings.push({ level: "warn", file: relPath, msg: "hooks file missing" });
      hooksInfo[relPath] = null;
      continue;
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
      hooksInfo[relPath] = null;
      continue;
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
      hooksInfo[relPath] = null;
      continue;
    }
    if (!isRecord(data) || !("hooks" in data) || !isRecord(data.hooks)) {
      findings.push({
        level: "warn",
        file: relPath,
        msg: "hooks JSON missing top-level 'hooks' key",
      });
      hooksInfo[relPath] = "invalid-structure";
    } else {
      hooksInfo[relPath] = Object.keys(data.hooks).sort();
    }
  }

  // 8. MCP.
  const mcpInfo: Record<string, McpServerInfo> = {};
  const mcpPath = join(pluginRoot, ".mcp.json");
  const expectedMcpServers = ["qtc-cert", "qtc-prod"];
  if (await fs.exists(mcpPath)) {
    let mcpData: unknown = null;
    try {
      mcpData = JSON.parse(await fs.readText(mcpPath));
    } catch (e) {
      findings.push({
        level: "error",
        file: ".mcp.json",
        msg: `invalid JSON: ${(e as Error).message}`,
      });
    }
    if (mcpData !== null && isRecord(mcpData)) {
      const servers = isRecord(mcpData.mcpServers) ? mcpData.mcpServers : {};
      for (const exp of expectedMcpServers) {
        const server = (servers as Record<string, unknown>)[exp];
        if (server === undefined) {
          findings.push({
            level: "warn",
            file: ".mcp.json",
            msg: `expected server '${exp}' not configured`,
          });
          mcpInfo[exp] = "missing";
          continue;
        }
        const dsnRaw =
          isRecord(server) && isRecord(server.env) && typeof server.env.DSN === "string"
            ? server.env.DSN
            : "";
        const m = dsnRaw.match(/^\$\{(\w+)\}$/);
        if (m?.[1]) {
          const envVar = m[1];
          const envSet = Boolean(env.get(envVar));
          mcpInfo[exp] = { dsn_env: envVar, env_set: envSet };
          if (!envSet) {
            findings.push({
              level: "warn",
              file: ".mcp.json",
              msg: `env var ${envVar} not set (required by mcp server '${exp}')`,
            });
          }
        } else {
          mcpInfo[exp] = { dsn_env: null, env_set: null };
        }
      }
    }
  }

  // 9. Python version — solo legacy. En single-path no existe runtime Python.
  let pythonVersion: string | null = null;
  if (!isSinglePathContract) {
    pythonVersion = detectPythonVersion();
    if (pythonVersion) {
      const m = pythonVersion.match(/^(\d+)\.(\d+)/);
      if (m?.[1] && m[2]) {
        const major = Number.parseInt(m[1], 10);
        const minor = Number.parseInt(m[2], 10);
        if (major < 3 || (major === 3 && minor < 8)) {
          findings.push({
            level: "warn",
            file: "python",
            msg: `python ${pythonVersion} is too old; recommend 3.8+`,
          });
        }
      }
    }
  }

  // 10. Exported skills (read from .claude-plugin/plugin.json:exportedSkills or --exports-file).
  const exportedInfo: ExportedSkillRecord[] = [];
  const exportedSkills = await loadExportedSkills(fs, pluginRoot, input.exportsFile, pluginName);
  const skillsByName = new Map<string, SkillFrontmatterInfo>();
  for (const s of skillsInfo) {
    if (s.name) skillsByName.set(s.dir, s);
  }
  for (const exp of exportedSkills) {
    const expSkillName = exp.skill;
    const record: ExportedSkillRecord = {
      namespace: exp.namespace,
      version_declared: exp.version ?? null,
      since: exp.since ?? null,
      exists_in_disk: false,
      frontmatter_ok: false,
    };
    if (await fs.exists(skillsDir)) {
      const target = join(skillsDir, expSkillName);
      const targetSkill = join(target, "SKILL.md");
      if (await fs.exists(targetSkill)) {
        record.exists_in_disk = true;
        const diskSkill = skillsByName.get(expSkillName);
        if (diskSkill?.name && diskSkill.version) {
          record.frontmatter_ok = true;
          record.version_in_skill = diskSkill.version;
          if (diskSkill.version && exp.version && diskSkill.version !== exp.version) {
            findings.push({
              level: "warn",
              file: `skills/${expSkillName}/SKILL.md`,
              msg: `exported skill version drift: registry declares ${exp.version}, SKILL.md frontmatter declares ${diskSkill.version}`,
            });
          }
        } else {
          findings.push({
            level: "error",
            file: `skills/${expSkillName}/SKILL.md`,
            msg: "exported skill SKILL.md missing required frontmatter (name + version)",
          });
        }
      } else {
        findings.push({
          level: "error",
          file: `skills/${expSkillName}/SKILL.md`,
          msg: `exported skill '${exp.namespace}' registered but not found in plugin's skills/ directory — fix the register_exported_skill call or add the SKILL.md`,
        });
      }
    } else {
      findings.push({
        level: "error",
        file: "skills/",
        msg: `exported skill '${exp.namespace}' registered but plugin has no skills/ directory`,
      });
    }
    exportedInfo.push(record);
  }

  const hasError = findings.some((f) => f.level === "error");
  const hasWarn = findings.some((f) => f.level === "warn");
  const status: "ok" | "warn" | "error" = hasError ? "error" : hasWarn ? "warn" : "ok";

  return {
    data: {
      status,
      plugin: pluginName,
      plugin_root: pluginRoot,
      plugin_version: pluginVersion,
      qtc_core_installed: qtcCoreInstalled,
      compat_range: compatRange,
      compat_ok: compatOk,
      python_version: pythonVersion,
      skills_count: skillsCount,
      readme_count_expected: readmeCountExpected,
      readme_count_match: readmeCountMatch,
      manifests: manifestsInfo,
      installed_marker: installedMarker,
      scripts: scriptsInfo,
      hooks: hooksInfo,
      mcp: mcpInfo,
      skills: skillsInfo,
      exported_skills: exportedInfo,
      findings,
    },
    hasError,
  };
}

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
  const sources: unknown[] = [];
  if (exportsFile) {
    if (await fs.exists(exportsFile)) {
      try {
        sources.push(JSON.parse(await fs.readText(exportsFile)));
      } catch {
        // ignore
      }
    }
  } else {
    const claudeManifest = join(pluginRoot, ".claude-plugin", "plugin.json");
    if (await fs.exists(claudeManifest)) {
      try {
        const data = JSON.parse(await fs.readText(claudeManifest));
        if (isRecord(data) && Array.isArray(data.exportedSkills)) {
          sources.push(data.exportedSkills);
        }
      } catch {
        // ignore
      }
    }
  }
  const out: ExportedSkillEntry[] = [];
  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (const item of src) {
      if (!isRecord(item)) continue;
      const skill = typeof item.skill === "string" ? item.skill : null;
      if (!skill) continue;
      const plugin =
        typeof item.plugin === "string" && item.plugin.length > 0 ? item.plugin : pluginName;
      const namespace =
        typeof item.namespace === "string" && item.namespace.length > 0
          ? item.namespace
          : `${plugin}:${skill}`;
      out.push({
        plugin,
        skill,
        namespace,
        version: typeof item.version === "string" ? item.version : null,
        since: typeof item.since === "string" ? item.since : null,
      });
    }
  }
  return out;
}

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

function isContractVersionAtLeast(version: string | null, major: number, minor: number): boolean {
  if (!version) return false;
  const m = version.trim().match(/^(\d+)\.(\d+)/);
  if (!m?.[1] || !m[2]) return false;
  const x = Number.parseInt(m[1], 10);
  const y = Number.parseInt(m[2], 10);
  if (x > major) return true;
  if (x < major) return false;
  return y >= minor;
}

function semverSatisfies(installed: string, range: string): boolean | null {
  const inst = parseSemver(installed);
  if (!inst) return null;
  const m = range.trim().match(/^([~^]?)(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const op = m[1] ?? "";
  const x = Number.parseInt(m[2] ?? "0", 10);
  const y = Number.parseInt(m[3] ?? "0", 10);
  const z = Number.parseInt(m[4] ?? "0", 10);
  if (op === "~") {
    return tupleGte(inst, [x, y, z]) && tupleLt(inst, [x, y + 1, 0]);
  }
  if (op === "^") {
    return tupleGte(inst, [x, y, z]) && tupleLt(inst, [x + 1, 0, 0]);
  }
  return inst[0] === x && inst[1] === y && inst[2] === z;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [
    Number.parseInt(m[1] ?? "0", 10),
    Number.parseInt(m[2] ?? "0", 10),
    Number.parseInt(m[3] ?? "0", 10),
  ];
}

function tupleGte(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

function tupleLt(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

function detectPythonVersion(): string | null {
  try {
    const r = spawnSync("python3", ["--version"], { encoding: "utf-8" });
    if (r.status === 0) {
      const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const m = text.match(/Python\s+(\d+\.\d+\.\d+)/);
      if (m?.[1]) return m[1];
    }
  } catch {
    // ignore
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
