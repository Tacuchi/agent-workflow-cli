import {
  type DecisionNote,
  type NoteFailure,
  type NoteObligation,
  effectiveNotes,
} from "./decision-note.js";

/**
 * THE effective contract: the baseline plus its notes in force, applied in
 * order, read by exactly ONE function.
 *
 * Every surface that says anything about a lineage — execution, `status`,
 * `resume`, a receipt, a later validation — goes through here. That is the whole
 * point and not an implementation preference: two places deriving "what this
 * plan is really committed to" is how a receipt and the validation that follows
 * it end up disagreeing about the same lineage, each of them internally
 * consistent and one of them wrong.
 *
 * And it either composes or it BLOCKS. There is no third answer where the
 * composition picks a winner by implicit precedence: an overlap resolved by
 * "the newest note wins" would let two readings of one contract coexist in
 * silence, which is strictly worse than refusing and naming the correction.
 */

export interface EffectiveAssertion {
  /** `S033/AC-05` — addressed with the grammar that already existed. */
  id: string;
  /** `baseline` while nobody amended it; `amended` once a note supersedes it. */
  state: "baseline" | "amended";
  /** The note that amended it, or `null`. */
  by: string | null;
}

/**
 * An obligation in force, with its class and its cause.
 *
 * The class travels with it because every surface downstream needs it and none
 * of them may re-derive it: what blocks a closure and what merely stays visible
 * is one answer, and two places computing it is how a board and the gate that
 * follows it end up disagreeing about the same plan.
 */
export interface EffectiveObligation extends NoteObligation {
  /** The note that created it — an obligation always keeps its cause. */
  by: string;
  /**
   * Its position in that note's list.
   *
   * The only stable name an obligation has: it carries no id, and its text is
   * not unique — a note may owe the same sentence twice. Settling one names the
   * note and this position, so "which one was discharged" is never a guess.
   */
  index: number;
}

export interface EffectiveContract {
  spec: { path: string; number: string; digest: string };
  assertions: EffectiveAssertion[];
  obligations: EffectiveObligation[];
  evidence_preserved: string[];
  evidence_invalidated: string[];
  /** The notes actually applied, in the order they were applied. */
  applied: string[];
}

export type Composition =
  | { status: "composed"; contract: EffectiveContract }
  | { status: "blocked"; failures: NoteFailure[] };

export interface BaselineInput {
  path: string;
  number: string;
  /** The spec's digest as it reads NOW — the functional payload's. */
  digest: string;
  /**
   * The digest of the spec's EXACT bytes as it reads now, when the caller can
   * compute it — and the second half of the same migration `alignSpecBaseline`
   * performs one level up.
   *
   * Every note published before the functional payload existed pinned this one,
   * because it was what the baseline meant then. Comparing such a note against
   * the functional digest alone reads it as deciding on a baseline that is no
   * longer in force, over a spec NOBODY TOUCHED — and there is no way out of
   * that inside the product: the substitute note the message asks for cannot be
   * published (its own preparation composes the chain first and refuses with
   * this same code), editing the JSON by hand breaks the note's seal, and
   * "restore the spec to its sealed baseline" names an edit that never happened.
   *
   * So both readings are accepted, for exactly as long as the spec is untouched
   * — which is precisely the tolerance a legacy SEAL gets. `undefined` when the
   * caller has no spec text to digest, and then only `digest` is accepted.
   */
  legacy_digest?: string | undefined;
  /** The criteria the spec states, in document order. */
  criteria: readonly string[];
}

/**
 * Compose the baseline with the chain, or block naming the correction.
 *
 * Ordering is the chain's (`effectiveNotes` → date, then correlative), so the
 * result does not depend on the order the notes were handed over. Two callers
 * reading the same lineage from different directions get the same contract or
 * the same refusal.
 */
export function composeEffectiveContract(
  baseline: BaselineInput,
  chain: readonly DecisionNote[],
): Composition {
  const notes = effectiveNotes(chain);
  const failures: NoteFailure[] = [];
  const known = new Set(baseline.criteria);
  const amendedBy = new Map<string, string>();
  const obligations: EffectiveObligation[] = [];
  const preservedBy = new Map<string, string>();
  const invalidatedBy = new Map<string, string>();
  const applied: string[] = [];

  for (const note of notes) {
    failures.push(...checkBaseline(note, baseline));
    failures.push(...checkAssertions(note, known, amendedBy));
    failures.push(...checkContradiction(note));
    for (const id of note.supersedes_assertions) amendedBy.set(id, note.id);
    for (const [index, obligation] of note.obligations.entries()) {
      obligations.push({ ...obligation, by: note.id, index });
    }
    // First note wins the attribution: the chain is applied in order, so the
    // earliest one to say something about a piece of evidence is the one whose
    // claim the conflict check has to name.
    claimFirst(preservedBy, note.evidence_preserved, note.id);
    claimFirst(invalidatedBy, note.evidence_invalidated, note.id);
    applied.push(note.id);
  }
  failures.push(...checkEvidenceConflict(preservedBy, invalidatedBy));

  if (failures.length > 0) return { status: "blocked", failures };

  return {
    status: "composed",
    contract: {
      spec: { path: baseline.path, number: baseline.number, digest: baseline.digest },
      assertions: baseline.criteria.map((id) => ({
        id,
        state: amendedBy.has(id) ? "amended" : "baseline",
        by: amendedBy.get(id) ?? null,
      })),
      obligations,
      evidence_preserved: [...preservedBy.keys()],
      evidence_invalidated: [...invalidatedBy.keys()],
      applied,
    },
  };
}

function claimFirst(into: Map<string, string>, items: readonly string[], noteId: string): void {
  for (const item of items) {
    if (!into.has(item)) into.set(item, noteId);
  }
}

/**
 * A note that decided on other bytes is not stale trivia: it decided elsewhere.
 *
 * "Other bytes" means neither reading of the spec as it reads now — see
 * {@link BaselineInput.legacy_digest}: a note pinned before the functional
 * payload existed decided on THIS spec, and calling that "no longer in force"
 * would block a lineage nobody moved with no repair available.
 */
function checkBaseline(note: DecisionNote, baseline: BaselineInput): NoteFailure[] {
  const pinned = note.lineage.spec.digest;
  if (pinned === baseline.digest || pinned === baseline.legacy_digest) return [];
  return [
    {
      code: "CONTRACT_BASELINE_ABSENT",
      message: `${note.id} decide sobre un baseline de ${note.lineage.spec.path} que ya no es el vigente`,
      action:
        "revisá la nota contra la spec actual y publicá otra que la sustituya, o volvé la spec a su baseline sellado",
    },
  ];
}

/**
 * An amendment must name something that exists, and only once.
 *
 * Two notes in force over the same assertion is an OVERLAP unless the later one
 * explicitly supersedes the earlier: without that reference nobody can say which
 * of the two the contract means, and choosing by recency would be inventing the
 * answer.
 */
function checkAssertions(
  note: DecisionNote,
  known: ReadonlySet<string>,
  amendedBy: ReadonlyMap<string, string>,
): NoteFailure[] {
  const failures: NoteFailure[] = [];
  for (const id of note.supersedes_assertions) {
    if (!known.has(id)) {
      failures.push({
        code: "CONTRACT_ASSERTION_ABSENT",
        message: `${note.id} sustituye ${id}, que la spec no enuncia`,
        action: `direccioná una afirmación que exista en ${note.lineage.spec.path}, o corregí la nota con otra que la sustituya`,
      });
      continue;
    }
    const previous = amendedBy.get(id);
    if (previous !== undefined && note.supersedes_note !== previous) {
      failures.push({
        code: "CONTRACT_OVERLAP",
        message: `${note.id} y ${previous} están vigentes sobre ${id} y ninguna sustituye a la otra`,
        action: `publicá una nota que sustituya explícitamente a ${previous}: la precedencia por fecha sería una respuesta inventada`,
      });
    }
  }
  return failures;
}

/** A note that both keeps and drops the same evidence contradicts itself. */
function checkContradiction(note: DecisionNote): NoteFailure[] {
  const preserved = new Set(note.evidence_preserved);
  const both = note.evidence_invalidated.filter((item) => preserved.has(item));
  if (both.length === 0) return [];
  return [
    {
      code: "CONTRACT_CONTRADICTION",
      message: `${note.id} conserva e invalida a la vez: ${both.join(", ")}`,
      action: "una evidencia sigue valiendo o dejó de valer; decidí cuál y volvé a sellar la nota",
    },
  ];
}

/**
 * Two DIFFERENT notes in force where one keeps exactly what another drops.
 *
 * Left unresolved this is the same ambiguity as an overlap, one level down: the
 * contract would claim a piece of evidence is both usable and void. Attributing
 * each side to its note is what keeps this distinct from a single note
 * contradicting itself — that one is already reported against the note itself,
 * and reporting it twice would send the reader to fix two things.
 */
function checkEvidenceConflict(
  preservedBy: ReadonlyMap<string, string>,
  invalidatedBy: ReadonlyMap<string, string>,
): NoteFailure[] {
  const failures: NoteFailure[] = [];
  for (const [item, keeper] of preservedBy) {
    const dropper = invalidatedBy.get(item);
    if (dropper === undefined || dropper === keeper) continue;
    failures.push({
      code: "CONTRACT_CONTRADICTION",
      message: `${keeper} conserva '${item}' y ${dropper} la invalida, y las dos están vigentes`,
      action: `publicá una nota que sustituya a ${keeper} o a ${dropper}: el contrato no puede afirmar las dos`,
    });
  }
  return failures;
}
