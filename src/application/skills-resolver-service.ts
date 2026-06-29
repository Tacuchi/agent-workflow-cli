import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { HARNESSES } from "../domain/harnesses.js";
import { parseSkillFrontmatter } from "../domain/skill-frontmatter.js";
import {
  BUILTIN_DEFAULT_SKILLS,
  type ResolvedSkills,
  SKILL_ROLES,
  type SkillBindingSource,
  type SkillRole,
  isSkillRole,
} from "../domain/skills.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

export interface SkillsResolution {
  skills: ResolvedSkills;
  /** Which skills.toml files were present in the cascade. */
  sources: { global: boolean; workspace: boolean };
  warnings: string[];
}

const OFF = "off";

/**
 * Resolve capability role → skill bindings via the cascade:
 *   built-in default → ~/.workflow/skills.toml (global) → .workflow/skills.toml (workspace)
 *
 * Workspace overrides global; global overrides built-in default. A role bound to
 * "off" is disabled. Unknown role keys and parse errors are recorded as warnings
 * and never crash resolution (this runs for every command).
 */
export async function resolveSkills(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<SkillsResolution> {
  const warnings: string[] = [];
  const skills = buildDefaultSkills();
  const sources = { global: false, workspace: false };

  const levels: { source: "global" | "workspace"; path: string }[] = [
    { source: "global", path: paths.userSkillsToml() },
    { source: "workspace", path: paths.cwdSkillsToml() },
  ];

  for (const level of levels) {
    if (!(await fs.exists(level.path))) continue;
    sources[level.source] = true;
    const table = await readSkillsTable(fs, level.path, warnings);
    if (table) applyLevel(skills, table, level.source, level.path, warnings);
  }

  return { skills, sources, warnings };
}

function buildDefaultSkills(): ResolvedSkills {
  const skills = {} as ResolvedSkills;
  for (const role of SKILL_ROLES) {
    skills[role] = { role, skill: BUILTIN_DEFAULT_SKILLS[role], source: "default", enabled: true };
  }
  return skills;
}

/** Read the `[skills]` table from a TOML file. Returns null (with a warning) on any problem. */
async function readSkillsTable(
  fs: FileSystemPort,
  path: string,
  warnings: string[],
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = parseToml(await fs.readText(path)) as Record<string, unknown>;
    const skillsTable = parsed.skills;
    if (skillsTable === undefined || skillsTable === null) return null;
    if (typeof skillsTable !== "object") {
      warnings.push(`${path}: [skills] is not a table`);
      return null;
    }
    return skillsTable as Record<string, unknown>;
  } catch (err) {
    warnings.push(`${path}: parse error (${(err as Error).message})`);
    return null;
  }
}

/** One bound role checked against the skills actually installed in the host. */
export interface BindingCheck {
  role: SkillRole;
  skill: string;
  source: SkillBindingSource;
  installed: boolean;
}

export interface BindingValidation {
  checks: BindingCheck[];
  warnings: string[];
  rootsScanned: string[];
}

const BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set(Object.values(BUILTIN_DEFAULT_SKILLS));

/**
 * Best-effort, ADVISORY check of `skills.toml` bindings against installed skills.
 *
 * The resolver itself never validates that a bound skill exists, and never falls
 * back to the default — a typo'd binding silently leaves the role mute. This scans
 * the standard skill roots (cwd + home × each host's skillsDirs) and warns when a
 * user-set binding names a skill that is neither a built-in default nor found
 * installed. It never blocks: a not-found is a hint, not an error (the skill may
 * live somewhere this scan does not cover).
 */
export async function checkInstalledBindings(
  fs: FileSystemPort,
  env: EnvPort,
  resolution: SkillsResolution,
): Promise<BindingValidation> {
  const roots = skillRoots(env);
  const installed = await enumerateInstalledSkills(fs, roots);
  const checks: BindingCheck[] = [];
  const warnings: string[] = [];

  for (const role of SKILL_ROLES) {
    const r = resolution.skills[role];
    if (!r.enabled || r.skill === null || r.source === "default") continue;
    const skill = r.skill;
    if (BUILTIN_SKILL_NAMES.has(skill)) {
      checks.push({ role, skill, source: r.source, installed: true });
      continue;
    }
    const leaf = skill.includes("/") ? (skill.split("/").pop() ?? skill) : skill;
    const installedHere = installed.has(skill) || installed.has(leaf);
    checks.push({ role, skill, source: r.source, installed: installedHere });
    if (!installedHere) {
      warnings.push(
        `role '${role}' is bound to '${skill}' (${r.source}) but no installed skill by that name was found in the standard skill roots (${roots.join(", ")}). The binding is advisory — the CLI does not auto-fallback. Install it (e.g. \`npx skills add <owner/repo>\`) or fix the name; if it lives elsewhere, ignore this.`,
      );
    }
  }

  return { checks, warnings, rootsScanned: roots };
}

/** cwd + home crossed with every host's skill directory (deduped). */
function skillRoots(env: EnvPort): string[] {
  const dirs = [...new Set(HARNESSES.flatMap((h) => [...h.skillsDirs]))];
  const roots: string[] = [];
  for (const d of dirs) {
    roots.push(join(env.cwd(), d));
    roots.push(join(env.homeDir(), d));
  }
  return [...new Set(roots)];
}

/** Collect the names of skills installed under the given roots (dir name + frontmatter name). */
async function enumerateInstalledSkills(fs: FileSystemPort, roots: string[]): Promise<Set<string>> {
  const names = new Set<string>();
  for (const root of roots) {
    await collectNamesFromRoot(fs, root, names);
  }
  return names;
}

async function collectNamesFromRoot(
  fs: FileSystemPort,
  root: string,
  names: Set<string>,
): Promise<void> {
  if (!(await fs.exists(root))) return;
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    names.add(entry.name);
    await addFrontmatterName(fs, join(entry.path, "SKILL.md"), names);
  }
}

async function addFrontmatterName(
  fs: FileSystemPort,
  skillMd: string,
  names: Set<string>,
): Promise<void> {
  if (!(await fs.exists(skillMd))) return;
  try {
    const fm = parseSkillFrontmatter(await fs.readText(skillMd));
    if (fm?.fields.name) names.add(fm.fields.name);
  } catch {
    // ignore unreadable skill files
  }
}

/** Merge one cascade level's `[skills]` table onto the resolved bindings. */
function applyLevel(
  skills: ResolvedSkills,
  table: Record<string, unknown>,
  source: "global" | "workspace",
  path: string,
  warnings: string[],
): void {
  for (const [key, value] of Object.entries(table)) {
    if (!isSkillRole(key)) {
      warnings.push(`${path}: unknown role '${key}' ignored`);
      continue;
    }
    const val = String(value).trim();
    if (val.toLowerCase() === OFF) {
      skills[key] = { role: key, skill: null, source, enabled: false };
    } else if (val.length > 0) {
      skills[key] = { role: key, skill: val, source, enabled: true };
    }
  }
}
