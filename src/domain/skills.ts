/**
 * Capability roles for the pluggable skills model.
 *
 * A loop composes a CAPABILITY by its role (e.g. "design"), not a concrete
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
export const SKILL_ROLES = ["design", "sql", "git", "research", "diagrams", "overview"] as const;

export type SkillRole = (typeof SKILL_ROLES)[number];

/** Built-in default skill name for each capability role. */
export const BUILTIN_DEFAULT_SKILLS: Record<SkillRole, string> = {
  design: "design",
  sql: "sql",
  git: "git",
  research: "research",
  diagrams: "diagrams",
  overview: "w",
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

/**
 * Names this contract does NOT accept, and what to say instead.
 *
 * `ui-design` was the design role and `ui-spec` its default implementation.
 * Both are retired: the public identity is `design`, and its only output is the
 * UI Design Package v1. They are not aliases and not alternative implementations
 * — a second name for one capability is a second contract in disguise, and the
 * day the two disagree there is no way to say which one the package obeys.
 *
 * So a config naming either is REFUSED, not silently honored: accepting
 * `design = "ui-spec"` would make `ui-spec` an accepted name, which is exactly
 * what the contract forbids. The role keeps its built-in default, so refusing
 * the binding never leaves the capability mute.
 */
/**
 * What a role's binding MEANS for a capability that carries a built-in floor.
 *
 * The cascade answers "which name is bound"; this answers "and therefore what
 * runs". Three states, exhaustive on purpose:
 *
 * - **unset or the canonical name** → the floor runs, and the host may add
 *   whatever compatible improvements it selected. This is the ordinary case, and
 *   it is the same for a workspace that never wrote a `skills.toml`.
 * - **`off`** → the capability's own policy decides operation by operation. No
 *   host, wrapper or legacy name reverts it.
 * - **anything else** → `misconfigured`. A replacement binding does NOT select an
 *   improvement: improvements are chosen by the host among instances it can
 *   identify exactly, and honoring a name here would resurrect the "installed
 *   implies compatible" shortcut the contract exists to close. The binding is not
 *   rewritten either — the owner decides whether to adopt unset, the canonical
 *   name or `off`.
 *
 * Takes the canonical NAME rather than the descriptor: the policy is about a
 * role binding, and a capability-specific branch here would be exactly the
 * per-name branching the evolution criterion forbids.
 */
export type CapabilityBindingState = "floor_and_improvements" | "off" | "misconfigured";

export interface CapabilityBindingPolicy {
  state: CapabilityBindingState;
  /** Why, when it is not the ordinary case. */
  reason: string | null;
  action: string | null;
}

export function classifyCapabilityBinding(
  resolved: ResolvedSkill,
  canonicalName: string,
): CapabilityBindingPolicy {
  if (!resolved.enabled || resolved.skill === null) {
    return { state: "off", reason: `'${resolved.role}' está en off`, action: null };
  }
  if (resolved.skill === canonicalName) {
    return { state: "floor_and_improvements", reason: null, action: null };
  }
  return {
    state: "misconfigured",
    reason: `'${resolved.role}' apunta a '${resolved.skill}', y un binding de reemplazo no selecciona una mejora`,
    action: `dejá el binding sin declarar, ponelo en '${canonicalName}' o desactivalo con "off"`,
  };
}

export const RETIRED_SKILL_IDENTITIES: ReadonlyMap<string, string> = new Map([
  [
    "ui-design",
    "el role de diseño ahora es 'design' y su implementación por defecto también: no hay alias",
  ],
  [
    "ui-spec",
    "'ui-spec' es el render legacy y no implementa 'design', cuyo único formato es el UI Design Package v1",
  ],
]);
