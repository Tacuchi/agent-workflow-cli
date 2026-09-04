/**
 * Decision registration at the plan-exec deviation gate.
 *
 * The generic decision primitives deliberately know nothing about a flow. This
 * bridge gives them the one thing they must never accept from a human payload:
 * the live spec/plan lineage and its current digests. It also asks
 * `resolveDecision` before preparing a note, so a fact or an already-effective
 * note does not become a fresh preference merely because the gate was reached.
 */

import { basename, join } from "node:path";
import type { CapabilityFailure } from "../domain/capability/protocol.js";
import { type DecisionQuestion, resolveDecision } from "../domain/decision-choice.js";
import type { DecisionNote, ObligationKind } from "../domain/decision-note.js";
import { type BaselineInput, composeEffectiveContract } from "../domain/effective-contract.js";
import type { FlowDecisionPreparation } from "../domain/flow/run-state.js";
import { specBaselineDigest } from "../domain/lineage.js";
import { baseDigest } from "../domain/proposal.js";
import { type PlanReconciliation, reconciliationOf } from "../domain/reconciliation.js";
import { type ObligationSettlement, deriveSettlementNote } from "../domain/settlement.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { noteIndexPath, readNoteIndex } from "./decision-note-service.js";
import {
  type PreparedDecision,
  commitDecision,
  prepareDecision,
} from "./decision-registration-service.js";
import { DEFAULT_DOCS_CANON } from "./docs-canon-service.js";
import { functionalSpecDigest } from "./parsers/spec-functional.js";
import {
  parseDerivedFromPath,
  parseSpecCriteria,
  parseSpecRelation,
} from "./parsers/spec-relation.js";
import type { PathsService } from "./paths-service.js";

/** The only human-supplied portion of the durable decision gate. */
export interface PlanExecDecisionAnswer {
  question: DecisionQuestion;
  /** All note fields except id, digest and lineage; those are derived here. */
  draft: Omit<DecisionNote, "id" | "digest" | "lineage">;
}

export type PlanExecDecisionPreparation =
  | { ok: true; kind: "settled"; decision: string }
  | { ok: true; kind: "reused"; note: string; decision: string; resume_point: string }
  | {
      ok: true;
      kind: "prepared";
      prepared: PreparedDecision;
      baseline: BaselineInput;
      indexPath: string;
    }
  | { ok: false; failure: CapabilityFailure };

export type PlanExecDecisionCommit =
  | { ok: true; kind: "settled" | "reused"; note?: string; resume_point?: string }
  /**
   * A standalone plan's decision: registered, and durable NOWHERE here.
   *
   * There is no `docs/decisions/` index for a plan without a spec — the chain is
   * keyed by the spec's number and slug — so writing one would mint a note under
   * a lineage nobody declared. What comes back is the record itself, for the run's
   * trace and for the session's `DECISION.md`.
   */
  | { ok: true; kind: "standalone"; decision: string; resume_point: string }
  | {
      ok: true;
      kind: "committed";
      note: DecisionNote;
      resume_point: string;
      written: string[];
      already_applied: boolean;
      reconciliation: PlanReconciliation;
    }
  | { ok: false; failure: CapabilityFailure };

export interface PreparePlanExecDecisionInput {
  root: string;
  session: string;
  /** Fixed plan scope of the active plan-exec run. */
  plan: string;
  /** `decisions.decision` from the selected gate answer. */
  value: unknown;
}

/**
 * Resolve fact/preference/reuse and, only for a real preference, build the
 * complete preview that `commitDecision` later publishes verbatim.
 */
export async function preparePlanExecDecision(
  fs: FileSystemPort,
  input: PreparePlanExecDecisionInput,
): Promise<PlanExecDecisionPreparation> {
  const answer = parseAnswer(input.value);
  if (!answer.ok) return answer;
  const read = await readLineage(fs, input);
  if (!read.ok) return read;
  const lineage = read.value;

  const chain = await readNoteIndex(fs, input.root, lineage.indexPath, {
    path: lineage.baseline.path,
    number: lineage.baseline.number,
  });
  if (!chain.ok) return noteFailure(chain.failures[0]);
  const composed = composeEffectiveContract(lineage.baseline, chain.read.index.notes);
  if (composed.status === "blocked") return noteFailure(composed.failures[0]);

  const resolution = resolveDecision(
    answer.value.question,
    composed.contract,
    chain.read.index.notes,
  );
  switch (resolution.kind) {
    case "settled":
      return { ok: true, kind: "settled", decision: resolution.behavior.summary };
    case "reused": {
      const note = chain.read.index.notes.find((entry) => entry.id === resolution.note);
      return {
        ok: true,
        kind: "reused",
        note: resolution.note,
        decision: resolution.decision,
        resume_point: note?.resume_point ?? "",
      };
    }
    case "unresolvable":
      return {
        ok: false,
        failure: {
          code: "FLOW_DECISION_UNRESOLVABLE",
          message: resolution.why,
          action: resolution.action,
        },
      };
    case "ask": {
      const prepared = await prepareDecision(fs, {
        root: input.root,
        operation: "plan-exec.decision-registration",
        indexPath: lineage.indexPath,
        baseline: lineage.baseline,
        draft: {
          ...answer.value.draft,
          lineage: {
            spec: {
              path: lineage.baseline.path,
              number: lineage.baseline.number,
              digest: lineage.baseline.digest,
            },
            plan: {
              path: input.plan,
              number: lineage.planNumber,
              digest: `sha256:${baseDigest(lineage.planText)}`,
            },
            execution: { session: input.session, phase: phaseOf(answer.value.draft.resume_point) },
          },
        },
      });
      if (prepared.status === "prepared") {
        return {
          ok: true,
          kind: "prepared",
          prepared: prepared.prepared,
          baseline: lineage.baseline,
          indexPath: lineage.indexPath,
        };
      }
      if (prepared.status === "already") {
        return {
          ok: true,
          kind: "reused",
          note: prepared.note.id,
          decision: prepared.note.decision,
          resume_point: prepared.resume_point,
        };
      }
      return noteFailure(prepared.failures[0]);
    }
  }
}

/** Commit precisely the preview the selected gate already prepared; never re-preview. */
export async function commitPlanExecDecision(
  fs: FileSystemPort,
  paths: PathsService,
  root: string,
  prepared: PlanExecDecisionPreparation,
  planText: string | undefined,
): Promise<PlanExecDecisionCommit> {
  if (!prepared.ok) return prepared;
  if (prepared.kind === "settled") return { ok: true, kind: "settled" };
  if (prepared.kind === "reused") {
    return { ok: true, kind: "reused", note: prepared.note, resume_point: prepared.resume_point };
  }
  const committed = await commitDecision(fs, paths, root, prepared.prepared);
  if (!committed.ok) return { ok: false, failure: committed.failure };
  const chain = await readNoteIndex(fs, root, prepared.indexPath, {
    path: prepared.baseline.path,
    number: prepared.baseline.number,
  });
  if (!chain.ok) return noteFailure(chain.failures[0]);
  const composed = composeEffectiveContract(
    await withLegacyDigest(fs, root, prepared.baseline),
    chain.read.index.notes,
  );
  if (composed.status === "blocked") return noteFailure(composed.failures[0]);
  return {
    ok: true,
    kind: "committed",
    note: committed.result.note,
    resume_point: committed.result.resume_point,
    written: committed.result.written,
    already_applied: committed.result.already_applied,
    reconciliation: reconciliationOf(composed.contract, chain.read.index.notes, planText),
  };
}

/**
 * Commit the preparation the run persisted before its human gate.
 *
 * There is deliberately no call to `preparePlanExecDecision` here: the stored
 * proposal is the exact full view the choice authorized. Re-preparing after the
 * choice would turn a moved baseline into an invisible different preview.
 */
export async function commitStoredPlanExecDecision(
  fs: FileSystemPort,
  paths: PathsService,
  root: string,
  preparation: FlowDecisionPreparation,
  /** The plan THIS RUN fixed as its scope — the same one the board reads. */
  plan: string | undefined,
): Promise<PlanExecDecisionCommit> {
  // Nothing durable to commit, and nothing to re-read: the standalone record IS
  // what the gate showed. It returns before `commitDecision` on purpose — a note
  // written here would be a decision about a contract that does not exist.
  if (preparation.kind === "standalone") {
    return {
      ok: true,
      kind: "standalone",
      decision: preparation.decision,
      resume_point: preparation.resume_point,
    };
  }
  if (preparation.kind === "settled") return { ok: true, kind: "settled" };
  if (preparation.kind === "reused") {
    return {
      ok: true,
      kind: "reused",
      note: preparation.note,
      resume_point: preparation.resume_point,
    };
  }
  // The plan is read again here, and only to classify legacy obligations: an
  // undeclared one reads as a handoff exactly when this plan enumerates that
  // work. It is read at the path the RUN declared, which is the path the board
  // reads too — the note's pinned path may have moved since, and two paths would
  // be two classifications of one obligation. Failing to read it degrades to the
  // safe reading, never to a guess.
  let planText: string | undefined;
  try {
    planText = plan === undefined ? undefined : await fs.readText(join(root, plan));
  } catch {
    planText = undefined;
  }
  return commitPlanExecDecision(
    fs,
    paths,
    root,
    {
      ok: true,
      kind: "prepared",
      prepared: {
        note: preparation.note,
        preview: preparation.preview,
        indexPath: preparation.index_path,
      },
      baseline: preparation.baseline,
      indexPath: preparation.index_path,
    },
    planText,
  );
}

/**
 * The baseline with the spec's exact-bytes digest alongside its functional one.
 *
 * Needed because the baseline a run PERSISTED before its human gate carries only
 * the functional digest (that is the durable shape, and widening it would change
 * a format for a value that is a pure function of the spec as it reads now). Re-
 * deriving it here is not a re-preview: `digest` and `criteria` are used exactly
 * as they were authorized, and only the tolerance for a note pinned before the
 * functional payload existed is restored — without it, `commitDecision` would
 * WRITE the note and only then refuse to compose the chain it just joined.
 *
 * An unreadable spec degrades to the baseline as given: the composition below
 * then refuses on its own terms, which is the same answer, one step later.
 */
async function withLegacyDigest(
  fs: FileSystemPort,
  root: string,
  baseline: BaselineInput,
): Promise<BaselineInput> {
  if (baseline.legacy_digest !== undefined) return baseline;
  try {
    return {
      ...baseline,
      legacy_digest: specBaselineDigest(await fs.readText(join(root, baseline.path))),
    };
  } catch {
    return baseline;
  }
}

interface DecisionLineage {
  baseline: BaselineInput;
  planNumber: string;
  planText: string;
  indexPath: string;
}

async function readLineage(
  fs: FileSystemPort,
  input: { root: string; plan: string },
): Promise<{ ok: true; value: DecisionLineage } | { ok: false; failure: CapabilityFailure }> {
  let planText: string;
  try {
    planText = await fs.readText(join(input.root, input.plan));
  } catch {
    return fail(
      "FLOW_DECISION_PLAN_UNREADABLE",
      `no se puede leer '${input.plan}' para registrar la decisión`,
      "restaurá el plan del scope y volvé a abrir el gate; no se registra una decisión sin su linaje",
    );
  }
  const relation = parseSpecRelation(planText);
  const specPath = parseDerivedFromPath(planText);
  if (relation.status !== "declared" || specPath === null) {
    // Reserved for the plan that SHOULD name a spec and does not: absent or
    // contradictory evidence. A plan that declares itself standalone never gets
    // here — the gate registers its decision in the session — so the action names
    // both exits instead of demanding a lineage the document may not have.
    return fail(
      "FLOW_DECISION_LINEAGE_INVALID",
      "el plan de la corrida no declara una única spec de origen",
      "abrí el plan con /w:plan-refine y declarale un único 'Derived from docs/specs/NNN-spec-…'; si nació de la conversación y no deriva de ninguna spec, declaralo con '> Standalone: <de dónde salió>' en su cabecera",
    );
  }
  let specText: string;
  try {
    specText = await fs.readText(join(input.root, specPath));
  } catch {
    return fail(
      "FLOW_DECISION_SPEC_UNREADABLE",
      `no se puede leer '${specPath}' contra la cual compondría la decisión`,
      "restaurá la spec de origen o escalá a spec-new; no se inventa un baseline ausente",
    );
  }
  const planNumber = /^([0-9]+)-plan(?:-|\.)/.exec(basename(input.plan))?.[1];
  if (planNumber === undefined) {
    return fail(
      "FLOW_DECISION_LINEAGE_INVALID",
      `la ruta '${input.plan}' no expone el correlative de plan`,
      "normalizá el nombre del plan antes de registrar una decisión durable",
    );
  }
  const slug = specSlug(specPath, relation.number);
  if (slug === null) {
    return fail(
      "FLOW_DECISION_LINEAGE_INVALID",
      `la ruta '${specPath}' no expone el slug de la spec`,
      "normalizá el nombre de la spec antes de registrar una decisión durable",
    );
  }
  return {
    ok: true,
    value: {
      baseline: {
        // The FUNCTIONAL digest, which is also what the board reports for an
        // aligned plan — including one whose seal is the legacy byte-exact one.
        // A note pinning anything else would read, the instant it is published,
        // as deciding on a baseline that is no longer in force.
        path: specPath,
        number: relation.number,
        digest: functionalSpecDigest(specText),
        // And the exact bytes alongside it, which is what every note published
        // BEFORE the functional payload pinned: composing this chain against the
        // functional digest alone would refuse an old note over a spec nobody
        // touched, and that refusal has no repair (the substitute note it asks
        // for cannot be prepared — this very composition runs first).
        legacy_digest: specBaselineDigest(specText),
        criteria: parseSpecCriteria(specText, relation.number),
      },
      planNumber,
      planText,
      indexPath: noteIndexPath(DEFAULT_DOCS_CANON.decision, relation.number, slug),
    },
  };
}

function parseAnswer(
  value: unknown,
): { ok: true; value: PlanExecDecisionAnswer } | { ok: false; failure: CapabilityFailure } {
  if (!isRecord(value) || !isQuestion(value.question) || !isRecord(value.draft)) {
    return fail(
      "FLOW_DECISION_INPUT_INVALID",
      "'decisions.decision' debe traer question (assertions y behaviors) y draft de nota",
      "devolvé la pregunta que queda abierta y todos los campos de la nota; el CLI deriva id, digests y lineage",
    );
  }
  const rawDraft = Object.fromEntries(
    Object.entries(value.draft).filter(([key]) => !["id", "digest", "lineage"].includes(key)),
  );
  return {
    ok: true,
    value: {
      question: value.question,
      draft: rawDraft as unknown as Omit<DecisionNote, "id" | "digest" | "lineage">,
    },
  };
}

function isQuestion(value: unknown): value is DecisionQuestion {
  if (!isRecord(value) || !isStringList(value.assertions) || !Array.isArray(value.behaviors))
    return false;
  if (value.assertions.length === 0 || new Set(value.assertions).size !== value.assertions.length)
    return false;
  const keys = new Set<string>();
  return value.behaviors.every((behavior) => {
    if (
      !isRecord(behavior) ||
      typeof behavior.key !== "string" ||
      typeof behavior.summary !== "string"
    ) {
      return false;
    }
    if (
      behavior.key.trim().length === 0 ||
      behavior.summary.trim().length === 0 ||
      keys.has(behavior.key)
    ) {
      return false;
    }
    keys.add(behavior.key);
    return true;
  });
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function specSlug(path: string, number: string): string | null {
  const prefix = `${number}-spec-`;
  const file = basename(path);
  if (!file.startsWith(prefix) || !file.endsWith(".md")) return null;
  const slug = file.slice(prefix.length, -".md".length);
  return slug.length > 0 ? slug : null;
}

function phaseOf(resumePoint: string): string {
  return /^F\d+/.exec(resumePoint)?.[0] ?? "F?";
}

function noteFailure(failure: { code: string; message: string; action: string } | undefined): {
  ok: false;
  failure: CapabilityFailure;
} {
  return failure === undefined
    ? fail(
        "FLOW_DECISION_PREPARATION_FAILED",
        "no se pudo preparar una decisión sin diagnóstico",
        "revisá el linaje y reintentá desde el gate",
      )
    : { ok: false, failure };
}

function fail(
  code: string,
  message: string,
  action: string,
): { ok: false; failure: CapabilityFailure } {
  return { ok: false, failure: { code, message, action } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SETTLE WHAT THE CLOSURE DISCHARGED, through the same sealed primitive.
 *
 * The successor of each carrier note is DERIVED (`deriveSettlementNote`) and then
 * published by `prepareDecision`/`commitDecision` — the exact pair the deviation
 * gate uses. Nothing here writes an index: a second writer would be a second set
 * of chain rules, and the one property the chain has is that its rules are one
 * implementation.
 *
 * Idempotent by content identity, like every registration: a run that published
 * and died comes back to a chain that already holds the successor, and
 * `prepareDecision` reports it as already landed instead of appending a twin.
 */
export interface SettlePlanExecInput {
  root: string;
  /** The plan THIS RUN fixed as its scope. */
  plan: string;
  /** Calendar date of the settlement. */
  date: string;
  /** What the run declared about each live compensation. */
  declarations: readonly ObligationSettlement[];
  /**
   * The session and phase each successor records, resolved PER CARRIER.
   *
   * Per carrier because two carriers can come from two different runs, and
   * filing the second one's successor under the first one's session would put a
   * decision where it did not happen. A closure answers the same for all of
   * them — its own run, at its closure — and `aw settle`, which has no run,
   * answers with each carrier's own lineage.
   */
  execution: (carrier: DecisionNote) => { session: string; phase: string };
}

export type SettlePlanExecResult =
  | {
      ok: true;
      /** The successor notes actually published, in the order they landed. */
      published: DecisionNote[];
      /** Obligations discharged, by their own text. */
      settled: string[];
      /** Where the plan stands once every successor is in the chain. */
      reconciliation: PlanReconciliation;
    }
  | { ok: false; failure: CapabilityFailure };

export async function settlePlanExecObligations(
  fs: FileSystemPort,
  paths: PathsService,
  input: SettlePlanExecInput,
): Promise<SettlePlanExecResult> {
  const read = await readLineage(fs, { root: input.root, plan: input.plan });
  if (!read.ok) return read;
  const lineage = read.value;

  const published: DecisionNote[] = [];
  const settled: string[] = [];
  // One carrier at a time, and each one re-reads the chain: publishing a
  // successor changes which notes are in force, so a second carrier resolved
  // against the first reading would decide against a chain that no longer is.
  for (const carrierId of carriersOf(input.declarations)) {
    const landed = await settleOneCarrier(fs, paths, input, lineage, carrierId);
    if (!landed.ok) return landed;
    if (landed.note !== null) published.push(landed.note);
    settled.push(...landed.settled);
  }

  const chain = await readNoteIndex(fs, input.root, lineage.indexPath, {
    path: lineage.baseline.path,
    number: lineage.baseline.number,
  });
  if (!chain.ok) return noteFailure(chain.failures[0]);
  const composed = composeEffectiveContract(lineage.baseline, chain.read.index.notes);
  if (composed.status === "blocked") return noteFailure(composed.failures[0]);
  return {
    ok: true,
    published,
    settled,
    reconciliation: reconciliationOf(composed.contract, chain.read.index.notes, lineage.planText),
  };
}

/** The carrier notes named by the declarations, in the order they first appear. */
function carriersOf(declarations: readonly ObligationSettlement[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const declaration of declarations) {
    if (seen.has(declaration.note)) continue;
    seen.add(declaration.note);
    out.push(declaration.note);
  }
  return out;
}

/**
 * The successor of ONE carrier note, published or recognized as already there.
 *
 * Extracted so the loop above reads as what it is — one settlement per carrier,
 * in chain order — instead of interleaving four refusal shapes with the walk.
 */
async function settleOneCarrier(
  fs: FileSystemPort,
  paths: PathsService,
  input: SettlePlanExecInput,
  lineage: DecisionLineage,
  carrierId: string,
): Promise<
  | { ok: true; note: DecisionNote | null; settled: string[] }
  | { ok: false; failure: CapabilityFailure }
> {
  const chain = await readNoteIndex(fs, input.root, lineage.indexPath, {
    path: lineage.baseline.path,
    number: lineage.baseline.number,
  });
  if (!chain.ok) return noteFailure(chain.failures[0]);
  const composed = composeEffectiveContract(lineage.baseline, chain.read.index.notes);
  if (composed.status === "blocked") return noteFailure(composed.failures[0]);
  const carrier = chain.read.index.notes.find((note) => note.id === carrierId);
  if (carrier === undefined) {
    return fail(
      "SETTLEMENT_NOTE_ABSENT",
      `${carrierId} no está en la cadena de ${lineage.baseline.path}`,
      "el saldo se publica sobre la nota que cargaba la obligación: volvé a leer el tablero y reintentá",
    );
  }
  // IN FORCE, and the composition is who says so — `applied` is the list of
  // notes it really applied, so this is not a second derivation of the same
  // question. Superseding a note somebody already superseded would put TWO
  // successors of it in force, and the contract would hold its assertions and
  // its obligations twice.
  if (!composed.contract.applied.includes(carrierId)) {
    const successor = chain.read.index.notes.find((note) => note.supersedes_note === carrierId);
    // Already settled — by this run before it was interrupted, or by somebody
    // else. That is the finished result, not a second successor to append.
    if (successor !== undefined) return { ok: true, note: successor, settled: [] };
    return fail(
      "SETTLEMENT_NOTE_ABSENT",
      `${carrierId} ya no está vigente en la cadena de ${lineage.baseline.path}`,
      "el saldo se publica sobre la nota vigente que cargaba la obligación: volvé a leer el tablero y reintentá",
    );
  }
  const reading = reconciliationOf(composed.contract, chain.read.index.notes, lineage.planText);
  const derived = deriveSettlementNote(carrier, input.declarations, {
    ...input.execution(carrier),
    date: input.date,
    resolved: resolvedKinds(reading, carrierId),
  });
  if (!derived.ok) return noteFailure(derived.failures[0]);
  if (derived.draft === null) return { ok: true, note: null, settled: [] };

  const prepared = await prepareDecision(fs, {
    root: input.root,
    operation: "plan-exec.settlement-publication",
    indexPath: lineage.indexPath,
    baseline: lineage.baseline,
    draft: derived.draft,
  });
  if (prepared.status === "blocked") return noteFailure(prepared.failures[0]);
  // Already in the chain by content identity: a run that published and died
  // comes back to its own finished result, never to a twin note.
  if (prepared.status === "already") {
    return { ok: true, note: prepared.note, settled: [...derived.settled] };
  }
  const committed = await commitDecision(fs, paths, input.root, prepared.prepared);
  if (!committed.ok) return { ok: false, failure: committed.failure };
  return { ok: true, note: committed.result.note, settled: [...derived.settled] };
}

/**
 * The class the reconciliation read for each obligation of ONE note, by position.
 *
 * Both lists, because both are readings of the same chain: a compensation and a
 * handoff are equally "what the board says this obligation is", and a successor
 * that only knew about one of them would re-mint the other unclassed.
 */
function resolvedKinds(
  reading: PlanReconciliation,
  carrierId: string,
): ReadonlyMap<number, ObligationKind> {
  const out = new Map<number, ObligationKind>();
  for (const obligation of [...reading.pending, ...reading.handoffs]) {
    if (obligation.by === carrierId) out.set(obligation.index, obligation.kind);
  }
  return out;
}
