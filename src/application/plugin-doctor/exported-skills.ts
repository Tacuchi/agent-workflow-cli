import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import {
  type DoctorFinding,
  type ExportedSkillRecord,
  type SkillFrontmatterInfo,
  isRecord,
} from "./common.js";

export interface ExportedSkillsResult {
  exportedInfo: ExportedSkillRecord[];
  findings: DoctorFinding[];
}

export async function validateExportedSkills(
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

interface ExportedSkillEntry {
  plugin: string;
  skill: string;
  namespace: string;
  version: string | null;
  since: string | null;
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
