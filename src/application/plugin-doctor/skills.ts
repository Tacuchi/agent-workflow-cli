import { join, relative, sep } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import {
  collectMarkdownFiles,
  type DoctorFinding,
  type SkillFrontmatterInfo,
} from "./common.js";

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
