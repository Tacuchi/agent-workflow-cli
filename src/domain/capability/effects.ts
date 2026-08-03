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
