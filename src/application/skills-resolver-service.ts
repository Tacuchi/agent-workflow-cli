import { parse as parseToml } from "smol-toml";
import {
  BUILTIN_DEFAULT_SKILLS,
  type ResolvedSkills,
  SKILL_ROLES,
  isSkillRole,
} from "../domain/skills.js";
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
