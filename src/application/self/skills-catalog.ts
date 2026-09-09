// Data contract of the CURATED catalog (Spec 043): what Workline recommends,
// under which observable condition, and with which reviewed identity.
//
// Pure data + two predicates, no I/O: the entries themselves live in the TUI
// data module and are passed in as a parameter, the same way the seed always
// was (`application` does not import from `cli/`).
//
// Recommendation and installation are DIFFERENT facts. A disposition never
// creates, deletes or hides a file: `withdrawn` drops an entry from the
// habitual set and keeps its metadata so an existing installation stays
// readable in the full inventory.

/**
 * The curation verdict an entry carries — the vocabulary `Recommendation`
 * renders (DES-001@r7 / SCR-001@r3): keep it, condition it, repair/replace it,
 * try it as a candidate, or withdraw it from the habitual set.
 */
export type SkillDisposition = "keep" | "conditional" | "repair" | "candidate" | "withdrawn";

/**
 * One reviewed catalog entry. `name`/`source`/`description` are the seed's
 * original shape (a legacy row carrying only those reads as `keep`); the rest
 * is the review's own record.
 */
export interface SeedSkill {
  /** Catalog label — the name the list shows and the manager registers by. */
  name: string;
  source: string;
  description: string;
  /** Curation verdict; absent reads as `keep`. */
  disposition?: SkillDisposition;
  /** Why this verdict — one readable line, never a compatibility claim. */
  reason?: string;
  /** The observable condition that makes the skill pertinent. */
  useWhen?: string;
  /** Limits the review found. Unknown is said as unknown, never inferred. */
  knownLimits?: string;
  /** Invocable identity, when it differs from the catalog label. */
  skillName?: string;
  /** Path inside the source, when the entry is not the source's root. */
  path?: string;
  /** Revision the review inspected — NOT the ref an acquisition resolves. */
  reviewedRef?: string;
  /** Where the review's evidence can be read. */
  evidence?: string;
  /** Source a repair would move to, when it differs from the registered one. */
  proposedSource?: string;
}

/** The curation of an entry, with the absent disposition read as `keep`. */
export type SkillCuration = Omit<SeedSkill, "name" | "source" | "description" | "disposition"> & {
  disposition: SkillDisposition;
};

/**
 * Why an alternative stays OUT of the recommended set — data, not a row:
 * `on-request` is chooseable when somebody asks for it, `incompatible` was
 * reviewed against another version of this stack, and `not-operational` is an
 * example or template that must never arrive as a working skill.
 */
export type CatalogReserveAvailability = "on-request" | "incompatible" | "not-operational";

/** A reviewed alternative that is documented without being recommended. */
export interface CatalogReserve {
  name: string;
  source: string;
  path?: string;
  reviewedRef?: string;
  availability: CatalogReserveAvailability;
  reason: string;
}

/** Whether the entry belongs to the habitual recommended set. */
export function isRecommendedEntry(entry: SeedSkill): boolean {
  return (entry.disposition ?? "keep") !== "withdrawn";
}

/**
 * The entry's curation, or `undefined` when the catalog does not know the
 * name: an unreviewed installation says so instead of borrowing a verdict.
 */
export function curationOf(entry: SeedSkill | undefined): SkillCuration | undefined {
  if (entry === undefined) return undefined;
  return {
    disposition: entry.disposition ?? "keep",
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.useWhen !== undefined ? { useWhen: entry.useWhen } : {}),
    ...(entry.knownLimits !== undefined ? { knownLimits: entry.knownLimits } : {}),
    ...(entry.skillName !== undefined ? { skillName: entry.skillName } : {}),
    ...(entry.path !== undefined ? { path: entry.path } : {}),
    ...(entry.reviewedRef !== undefined ? { reviewedRef: entry.reviewedRef } : {}),
    ...(entry.evidence !== undefined ? { evidence: entry.evidence } : {}),
    ...(entry.proposedSource !== undefined ? { proposedSource: entry.proposedSource } : {}),
  };
}
