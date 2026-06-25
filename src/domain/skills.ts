/**
 * Capability roles for the pluggable skills model.
 *
 * A loop composes a CAPABILITY by its role (e.g. "ui-design"), not a concrete
 * skill. The role → skill binding is resolved from `skills.toml`
 * (cascade: built-in default → global → workspace). See skills-resolver-service.
 *
 * Only WORKFLOW-SPECIFIC capabilities are roles here. Generic, stack-agnostic
 * conventions (coding standards, testing strategy, technical writing) are NOT
 * roles: they live as standalone skills the host auto-discovers by `description`
 * and applies whenever relevant. The workflow stays indifferent — it never reads
 * or binds a specific convention skill; the host surfaces any useful one that is
 * installed (e.g. from the `dev-conventions` marketplace plugin, or anywhere).
 */
export const SKILL_ROLES = [
  "ui-design",
  "sql",
  "git",
  "research",
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
  research: "research",
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
