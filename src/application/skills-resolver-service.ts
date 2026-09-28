import { join } from "node:path";
import { HARNESSES } from "../domain/harnesses.js";
import {
  BUILTIN_DEFAULT_SKILLS,
  RETIRED_SKILL_IDENTITIES,
  type ResolvedSkills,
  SKILL_ROLES,
  isSkillRole,
} from "../domain/skills.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseToml } from "./parsers/toml.js";
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

/**
 * cwd + home crossed with every host's skill directory (deduped).
 *
 * Legacy inventory location; the invocation path stops using it in F3.
 */
export function skillRoots(env: EnvPort, workspaceRoot: string = env.cwd()): string[] {
  const dirs = [...new Set(HARNESSES.flatMap((h) => [...h.skillsDirs]))];
  const roots: string[] = [];
  for (const d of dirs) {
    roots.push(join(workspaceRoot, d));
    roots.push(join(env.homeDir(), d));
  }
  return [...new Set(roots)];
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
      const retired = RETIRED_SKILL_IDENTITIES.get(key);
      warnings.push(
        retired === undefined
          ? `${path}: role '${key}' no aplicable a Workline; el archivo se conserva sin cambios`
          : `${path}: role '${key}' está retirado y se ignora — ${retired}`,
      );
      continue;
    }
    const val = String(value).trim();
    if (val.toLowerCase() === OFF) {
      skills[key] = { role: key, skill: null, source, enabled: false };
      continue;
    }
    if (val.length === 0) continue;
    // Un nombre retirado se RECHAZA, no se resuelve: honrarlo lo convertiría en
    // un nombre aceptado. Se compara en minúsculas igual que `off`, tres líneas
    // arriba: dos reglas distintas en la misma función es una costura.
    const retired = RETIRED_SKILL_IDENTITIES.get(val.toLowerCase());
    if (retired !== undefined) {
      // La línea se IGNORA. No se nombra un destino: si otro nivel de la
      // cascada ya bindeó el role, el role NO queda en su built-in default y
      // decirlo sería mentir. Lo que resolvió de verdad va al lado, en `skills`.
      warnings.push(
        `${path}: role '${key}' apunta a '${val}', que está retirado y no se acepta — ${retired}. Se ignora la línea`,
      );
      continue;
    }
    if (val !== BUILTIN_DEFAULT_SKILLS[key]) {
      warnings.push(
        `${path}: role '${key}' apunta a '${val}'; binding externo no aplicable a Workline. Gestioná esa skill desde el host o marketplace elegido; el archivo se conserva sin cambios`,
      );
      continue;
    }
    skills[key] = { role: key, skill: val, source, enabled: true };
  }
}
