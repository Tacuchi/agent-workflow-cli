/**
 * Workline's overview binding in the skills cascade.
 *
 * The overview role → skill binding is resolved from `skills.toml`
 * (cascade: built-in default → global → workspace). See skills-resolver-service.
 *
 * Generic, stack-agnostic conventions are standalone skills discovered by the
 * host; Workline never binds a specific one or credits it by installation.
 */
export const SKILL_ROLES = ["overview"] as const;

export type SkillRole = (typeof SKILL_ROLES)[number];

/** Built-in default for the overview role. */
export const BUILTIN_DEFAULT_SKILLS: Record<SkillRole, string> = {
  overview: "w",
};

export type SkillBindingSource = "default" | "global" | "hub";

export interface ResolvedSkill {
  role: SkillRole;
  /** Concrete skill bound to the role, or null when disabled ("off"). */
  skill: string | null;
  source: SkillBindingSource;
  enabled: boolean;
}

export type ResolvedSkills = Record<SkillRole, ResolvedSkill>;

const ROLE_SET: ReadonlySet<string> = new Set(SKILL_ROLES);

export function isSkillRole(value: string): value is SkillRole {
  return ROLE_SET.has(value);
}

/** Names the Workline bundle itself retired; unknown plugin skills are never inferred retired. */
export const RETIRED_WORKLINE_SKILLS: ReadonlySet<string> = new Set(["agent-workflow:rules"]);
