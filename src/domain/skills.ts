/**
 * Capability roles for the pluggable skills model.
 *
 * A loop composes a CAPABILITY by its role (e.g. "ui-design"), not a concrete
 * skill. The role → skill binding is resolved from `skills.toml`
 * (cascade: built-in default → global → workspace). See skills-resolver-service.
 */
export const SKILL_ROLES = [
  "ui-design",
  "sql",
  "git",
  "coding-standards",
  "writing",
  "research",
  "testing",
  "tools",
  "diagrams",
  "overview",
] as const;

export type SkillRole = (typeof SKILL_ROLES)[number];

/** Built-in default skill name for each capability role. */
export const BUILTIN_DEFAULT_SKILLS: Record<SkillRole, string> = {
  "ui-design": "ui-spec",
  sql: "sql",
  git: "git",
  "coding-standards": "coding-standards",
  writing: "writing",
  research: "research",
  testing: "testing",
  tools: "tools",
  diagrams: "diagrams",
  overview: "workflow",
};

export type SkillBindingSource = "default" | "global" | "workspace";

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
