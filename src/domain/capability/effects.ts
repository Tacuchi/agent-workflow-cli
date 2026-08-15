/**
 * What an operation is allowed to DO, said as a closed taxonomy.
 *
 * The six classes are ordered by how much trust they need, and the order is the
 * point: the first two are what an invocation may authorize by itself, and
 * everything below them needs a preflight the human can see before it happens.
 * A descriptor that declares an operation `read_only` and then writes is a lie
 * the runtime can catch, which is only possible because the declaration exists.
 *
 * `class` alone is not enough to decide, so each declaration also carries
 * whether repeating it is safe (`idempotent`), who grants it (`authorization`)
 * and whether a human sees it first (`approval`). Those three are what the
 * authorization policy reads; the class is what makes them comparable across
 * capabilities that share no code.
 */

export const EFFECT_CLASSES = [
  /** Reads declared, non-sensitive sources and returns. Persists nothing. */
  "read_only",
  /** Creates something new INSIDE the requested target. Overwrites nothing. */
  "local_additive",
  /** Rewrites or replaces something that already exists. */
  "mutate_overwrite",
  /** Runs code — a build, a renderer, a subprocess. */
  "execute",
  /** Leaves the machine: network, or a third-party provider. */
  "network_external",
  /** Removes or invalidates something a later run cannot reconstruct. */
  "destructive",
] as const;

export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** Who grants the effect: the invocation itself, or a preflight the human sees. */
export type EffectAuthorization = "invocation" | "preflight";

/** Whether a human is shown the effect before it happens. */
export type EffectApproval = "none" | "visible";

export interface EffectDeclaration {
  class: EffectClass;
  /** Whether repeating the effect with the same request is safe. */
  idempotent: boolean;
  authorization: EffectAuthorization;
  approval: EffectApproval;
}

const CLASS_SET: ReadonlySet<string> = new Set(EFFECT_CLASSES);

export function isEffectClass(value: unknown): value is EffectClass {
  return typeof value === "string" && CLASS_SET.has(value);
}

/**
 * The only two classes an invocation may grant itself, and even then not always.
 *
 * Reading declared, non-sensitive sources and creating something new inside the
 * target the caller already named are the two effects where asking would be
 * ceremony: the caller asked for exactly that. Everything else — rewriting,
 * running code, leaving the machine, destroying — is a decision someone has to
 * see before it happens, and the ordering of `EFFECT_CLASSES` says which is
 * which.
 */
export const SELF_AUTHORIZABLE_CLASSES: readonly EffectClass[] = ["read_only", "local_additive"];

/**
 * Whether these classes reach anything a second attempt could double.
 *
 * `read_only` is the one class that leaves nothing behind: repeating it produces
 * the same reading and credits nothing. Every other class writes, runs, leaves
 * the machine or destroys, and each of those makes "do it again" a different
 * question from "do it once". Two guards ask exactly this — whether an exhausted
 * boundary may be passed over, and whether one may be handed back as answerable
 * — and they ask it through this predicate so they cannot answer it differently.
 */
export function touchesTheWorld(classes: readonly EffectClass[]): boolean {
  return classes.some((effect) => effect !== "read_only");
}

/**
 * What the HOST forbids or hardens, independent of what any descriptor says.
 *
 * The strictest policy always wins. A descriptor is authored by whoever wrote
 * the skill, so it can only ever RESTRICT further — never buy back something the
 * host took away.
 */
export interface EffectPolicy {
  /** Classes the host refuses outright. */
  denied: readonly EffectClass[];
  /** Classes the host demands a preflight for, even when the taxonomy would not. */
  preflight: readonly EffectClass[];
}

export const OPEN_EFFECT_POLICY: EffectPolicy = { denied: [], preflight: [] };

/**
 * A capability hint a host or an MCP server attached to a tool.
 *
 * Useful for discovery and **never** authorization. An annotation saying "this
 * is read-only" is a claim by the same party that would benefit from it being
 * believed; the implementation and the policy decide, and the annotation is only
 * ever recorded.
 */
export interface EffectAnnotation {
  class: EffectClass;
  source: "host" | "mcp";
}

export interface EffectContext {
  /** Whether any input declared `sensitive` is actually being read. */
  sensitiveSources: boolean;
  /** Whether the operation would write outside the target the caller named. */
  scopeExpanded: boolean;
}

export interface DeniedEffect {
  class: EffectClass;
  why: string;
}

export interface EffectAuthorizationResult {
  planned: EffectClass[];
  /** Granted by the invocation itself. */
  selfAuthorized: EffectClass[];
  /** Requires a preflight the human sees before anything happens. */
  needsPreflight: EffectClass[];
  denied: DeniedEffect[];
  /** Recorded for the receipt. Never consulted to grant anything. */
  annotations: EffectAnnotation[];
}

/**
 * Decide, for one operation, what the invocation may do by itself and what has
 * to be shown first.
 *
 * Four gates, and a class has to clear all of them to be self-authorized: the
 * taxonomy allows it, the descriptor asked for `invocation` rather than
 * `preflight`, the host does not demand a preflight, and the concrete context
 * has not turned it into something bigger — reading SENSITIVE sources is not the
 * `read_only` the caller authorized, and writing OUTSIDE the named target is not
 * the `local_additive` they asked for.
 */
export function authorizeEffects(
  effects: readonly EffectDeclaration[],
  context: EffectContext,
  policy: EffectPolicy = OPEN_EFFECT_POLICY,
  annotations: readonly EffectAnnotation[] = [],
): EffectAuthorizationResult {
  const planned: EffectClass[] = [];
  const selfAuthorized: EffectClass[] = [];
  const needsPreflight: EffectClass[] = [];
  const denied: DeniedEffect[] = [];

  for (const effect of effects) {
    planned.push(effect.class);
    if (policy.denied.includes(effect.class)) {
      denied.push({
        class: effect.class,
        why: "la política del host no admite esta clase de efecto",
      });
      continue;
    }
    if (selfAuthorizes(effect, context, policy)) {
      selfAuthorized.push(effect.class);
      continue;
    }
    needsPreflight.push(effect.class);
  }

  return { planned, selfAuthorized, needsPreflight, denied, annotations: [...annotations] };
}

function selfAuthorizes(
  effect: EffectDeclaration,
  context: EffectContext,
  policy: EffectPolicy,
): boolean {
  if (!SELF_AUTHORIZABLE_CLASSES.includes(effect.class)) return false;
  if (effect.authorization !== "invocation" || effect.approval !== "none") return false;
  if (policy.preflight.includes(effect.class)) return false;
  if (effect.class === "read_only") return !context.sensitiveSources;
  return !context.scopeExpanded;
}
