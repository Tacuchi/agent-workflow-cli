import { join, relative, sep } from "node:path";
import {
  type ParsedFrontmatter,
  getSkillVersion,
  parseSkillFrontmatter,
} from "../../domain/skill-frontmatter.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type DoctorFinding, type SkillFrontmatterInfo, collectMarkdownFiles } from "./common.js";

const SESSION_SPECIFIC_MARKERS = [
  "session034",
  "idNegocioFinanciero",
  "usuario-editar.component",
  "AuthUserServiceImpl",
  "tb_acceso_usuario_rol",
];

export interface SkillsCheckResult {
  skillsCount: number;
  skillsInfo: SkillFrontmatterInfo[];
  findings: DoctorFinding[];
}

export interface ReadmeCheckResult {
  readmeCountExpected: number | null;
  readmeCountMatch: boolean | null;
  findings: DoctorFinding[];
}

export async function checkSkillsFrontmatter(
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
    if (parsed.error || !parsed.fm) {
      findings.push({ level: "error", file: skillMd, msg: parsed.error ?? "invalid frontmatter" });
      skillsInfo.push({ dir: dirName, name: null, version: null });
      continue;
    }
    validateSkillFrontmatter(skillMd, dirName, parsed.fm, findings);
    skillsInfo.push({
      dir: dirName,
      name: parsed.fm.fields.name ?? null,
      version: getSkillVersion(parsed.fm),
    });
  }
  return { skillsCount: skillDirs.length, skillsInfo, findings };
}

export async function checkReadmeSync(
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

export async function checkFrontendDesignGeneralization(
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
  fm: ParsedFrontmatter | null;
  error: string | null;
}

async function parseSkillFile(skillMd: string, fs: FileSystemPort): Promise<ParsedSkill> {
  let content: string;
  try {
    content = await fs.readText(skillMd);
  } catch (e) {
    return { fm: null, error: `cannot read: ${(e as Error).message}` };
  }
  const fm = parseSkillFrontmatter(content);
  if (!fm) return { fm: null, error: "missing or unclosed frontmatter (---)" };
  return { fm, error: null };
}

// Limits from the Agent Skills standard (agentskills.io/specification).
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
]);

function validateSkillFrontmatter(
  skillMd: string,
  dirName: string,
  fm: ParsedFrontmatter,
  findings: DoctorFinding[],
): void {
  checkName(skillMd, dirName, fm.fields.name, findings);
  checkDescription(skillMd, fm.fields.description, findings);
  checkTopLevelKeys(skillMd, fm.fields, findings);
  checkVersion(skillMd, getSkillVersion(fm), findings);
}

function checkName(
  skillMd: string,
  dirName: string,
  name: string | undefined,
  findings: DoctorFinding[],
): void {
  if (!name) {
    findings.push({ level: "error", file: skillMd, msg: "missing 'name' in frontmatter" });
    return;
  }
  if (name !== dirName) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `frontmatter name '${name}' differs from directory '${dirName}'`,
    });
  }
  if (name.length > NAME_MAX) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `name is ${name.length} chars; the Agent Skills standard caps it at ${NAME_MAX}`,
    });
  }
  if (!NAME_PATTERN.test(name)) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `name '${name}' is not lowercase alphanumeric + single hyphens (no leading/trailing or doubled '-')`,
    });
  }
}

function checkDescription(
  skillMd: string,
  description: string | undefined,
  findings: DoctorFinding[],
): void {
  if (!description) {
    findings.push({ level: "error", file: skillMd, msg: "missing 'description' in frontmatter" });
    return;
  }
  if (description.length > DESCRIPTION_MAX) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `description is ${description.length} chars; the Agent Skills standard caps it at ${DESCRIPTION_MAX} — lenient clients truncate the overflow (often the cross-skill 'For X load Y' pointers)`,
    });
  }
}

function checkTopLevelKeys(
  skillMd: string,
  fields: Record<string, string>,
  findings: DoctorFinding[],
): void {
  if ("version" in fields) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: "top-level 'version' is non-standard; move it to metadata.version (the Agent Skills standard rejects unknown top-level keys)",
    });
  }
  for (const key of Object.keys(fields)) {
    if (key === "version" || ALLOWED_TOP_LEVEL_KEYS.has(key)) continue;
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `unknown top-level frontmatter key '${key}'; the Agent Skills standard allows only ${[...ALLOWED_TOP_LEVEL_KEYS].join(", ")} (extra data goes under metadata)`,
    });
  }
}

function checkVersion(skillMd: string, version: string | null, findings: DoctorFinding[]): void {
  if (!version) {
    findings.push({ level: "warn", file: skillMd, msg: "missing version (set metadata.version)" });
  } else if (!/^\d+\.\d+\.\d+$/.test(version)) {
    findings.push({
      level: "warn",
      file: skillMd,
      msg: `version '${version}' not semver-compatible`,
    });
  }
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
