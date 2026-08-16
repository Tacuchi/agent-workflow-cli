import { join } from "node:path";
import type { CapabilityFailure } from "../domain/capability/protocol.js";
import type { DecisionNote, NoteFailure } from "../domain/decision-note.js";
import { sameDecision } from "../domain/decision-note.js";
import type { DecisionPreview } from "../domain/decision-preview.js";
import { buildDecisionPreview, grantFor } from "../domain/decision-preview.js";
import type { BaselineInput } from "../domain/effective-contract.js";
import { composeEffectiveContract } from "../domain/effective-contract.js";
import type { ProposalBase } from "../domain/proposal.js";
import { baseDigest } from "../domain/proposal.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  appendNote,
  checkNoBaselineRewrite,
  noteIndexArtifact,
  readNoteIndex,
  sealNote,
} from "./decision-note-service.js";
import { applyLocalProposal } from "./local-proposal.js";
import type { PathsService } from "./paths-service.js";

/**
 * Registering a decision, in two steps and one durable transition.
 *
 * The split is the whole design. {@link prepareDecision} works out everything a
 * person needs and writes NOTHING; {@link commitDecision} takes the answer to
 * that exact preview and lands it, or lands none of it. Between the two sits one
 * question asked once — there is no second confirmation, because the grant the
 * answer produces is derived from the seal that was shown, so nothing is left
 * for a second question to be about.
 *
 * "Or nothing" is meant literally, and it is why the note, its effects and the
 * resume point travel as one artifact: `resume_point` is a FIELD of the note, so
 * a publication cannot land the decision and lose where to come back from. What
 * remains is the interleaving — a baseline or a destination that moves between
 * the preview and the write — and that fails closed on the compare-and-swap,
 * handing the sealed decision back so it can be re-previewed against what is
 * there now instead of being applied over it.
 *
 * The one case that is NOT a conflict is the same decision arriving twice. A run
 * that published and died before recording it comes back to a chain that already
 * holds the note; that is the finished result, not a duplicate to append, and it
 * is recognized by content through {@link sameDecision} rather than by a token
 * nobody kept.
 */

export interface PreparedDecision {
  /** The note as it will be published — id and seal already assigned by the chain. */
  note: DecisionNote;
  /** The eight sections and the one seal the answer is given over. */
  preview: DecisionPreview;
  /** Workspace-relative path of the chain this note joins. */
  indexPath: string;
}

export type DecisionPreparation =
  | { status: "prepared"; prepared: PreparedDecision }
  /** This exact decision is already in the chain: there is nothing to ask. */
  | { status: "already"; note: DecisionNote; resume_point: string }
  | { status: "blocked"; failures: NoteFailure[] };

export interface RegisteredDecision {
  note: DecisionNote;
  written: string[];
  /** The bytes were already there — a re-entry, not a fresh publication. */
  already_applied: boolean;
  resume_point: string;
}

export type DecisionCommit =
  | { ok: true; result: RegisteredDecision }
  /**
   * Nothing landed, and the decision survives the refusal.
   *
   * `decision` is handed back on purpose: losing it would make an interleaving
   * cost the person their answer, which is the one thing the preview asked them
   * to spend attention on.
   */
  | { ok: false; failure: CapabilityFailure; decision: DecisionNote; revalidate: string[] };

export interface PrepareDecisionInput {
  /** Workspace root; every path below is relative to it. */
  root: string;
  /** The producer's vocabulary for what is being proposed. */
  operation: string;
  /** Where this lineage's chain lives, from `noteIndexPath`. */
  indexPath: string;
  /** The spec as it reads NOW: digest and criteria, in document order. */
  baseline: BaselineInput;
  /** Everything the note says. Its id and seal come from the chain, never here. */
  draft: Omit<DecisionNote, "id" | "digest">;
}

/**
 * Work out the decision and show it. Writes nothing, ever.
 *
 * The order of the checks is the order in which a wrong answer gets cheaper to
 * fix: re-entry first (there may be nothing to decide), then the chain's rules,
 * then whether the result even composes, and only then the bytes. Composing
 * BEFORE previewing is what keeps a note that would block the contract from
 * being offered for approval — showing it would ask somebody to authorize a
 * lineage nobody can read afterwards.
 */
export async function prepareDecision(
  fs: FileSystemPort,
  input: PrepareDecisionInput,
): Promise<DecisionPreparation> {
  const spec = { path: input.baseline.path, number: input.baseline.number };
  const read = await readNoteIndex(fs, input.root, input.indexPath, spec);
  if (!read.ok) return { status: "blocked", failures: read.failures };
  const { index, exists } = read.read;

  const sealed = sealNote(index, input.draft);
  const landed = index.notes.find((note) => sameDecision(note, sealed));
  if (landed !== undefined) {
    return { status: "already", note: landed, resume_point: landed.resume_point };
  }

  const appended = appendNote(index, sealed);
  if (!appended.ok) return { status: "blocked", failures: appended.failures };

  const composed = composeEffectiveContract(input.baseline, appended.index.notes);
  if (composed.status === "blocked") return { status: "blocked", failures: composed.failures };

  const artifact = noteIndexArtifact(input.indexPath, appended.index);
  const rewrite = checkNoBaselineRewrite([artifact], sealed.lineage);
  if (rewrite.length > 0) return { status: "blocked", failures: rewrite };

  const bases = await readBases(fs, input, exists);
  if ("failures" in bases) return { status: "blocked", failures: bases.failures };

  const built = buildDecisionPreview({
    operation: input.operation,
    contract: composed.contract,
    note: sealed,
    artifacts: [{ path: artifact.path, content: artifact.content, overwrite: exists }],
    bases: bases.bases,
  });
  if (built.status === "blocked") return { status: "blocked", failures: built.failures };

  return {
    status: "prepared",
    prepared: { note: sealed, preview: built.preview, indexPath: input.indexPath },
  };
}

/**
 * Land exactly what was previewed, or nothing at all.
 *
 * The approval handed over is {@link grantFor}'s — the preview's own seal. It
 * cannot be widened by this function because it is not assembled here, and it
 * cannot travel to other bytes because `applyLocalProposal` compares it against
 * the proposal it is about to write.
 */
export async function commitDecision(
  fs: FileSystemPort,
  paths: PathsService,
  root: string,
  prepared: PreparedDecision,
): Promise<DecisionCommit> {
  const { proposal } = prepared.preview;
  const grant = grantFor(prepared.preview);
  const applied = await applyLocalProposal(fs, paths, {
    root,
    proposal,
    approval: { digest: grant.digest, granted: grant.classes },
    selfAuthorized: proposal.effects.filter(
      (effect) => !proposal.requires_approval.includes(effect),
    ),
  });
  if (!applied.ok) {
    return {
      ok: false,
      failure: applied.failure,
      decision: prepared.note,
      revalidate: proposal.bases.map((base) => base.path),
    };
  }
  return {
    ok: true,
    result: {
      note: prepared.note,
      written: applied.result.written,
      already_applied: applied.result.already_applied,
      resume_point: prepared.note.resume_point,
    },
  };
}

/**
 * The documents the decision was computed from, digested as they read now.
 *
 * All three, and each for a different interleaving: the spec because the
 * contract was composed over it, the plan because the note anchors its lineage
 * to those exact bytes, and the chain because the next correlative and the
 * append-only check were both read off it. Leaving any of them out would let
 * that one change between the preview and the write without the compare-and-swap
 * noticing.
 *
 * A base that is not there is a refusal and never a skipped check: a note whose
 * spec or plan vanished mid-decision has lost the thing it decides about.
 */
async function readBases(
  fs: FileSystemPort,
  input: PrepareDecisionInput,
  indexExists: boolean,
): Promise<{ bases: ProposalBase[] } | { failures: NoteFailure[] }> {
  const wanted = [input.baseline.path, input.draft.lineage.plan.path];
  if (indexExists) wanted.push(input.indexPath);

  const bases: ProposalBase[] = [];
  const failures: NoteFailure[] = [];
  for (const path of wanted) {
    const absolute = join(input.root, path);
    if (!(await fs.exists(absolute))) {
      failures.push({
        code: "DECISION_BASE_ABSENT",
        message: `'${path}' no está: la decisión se calcula sobre documentos que existen`,
        action: "verificá el linaje de la nota contra el workspace y volvé a preparar la decisión",
      });
      continue;
    }
    bases.push({ path, digest: baseDigest(await fs.readText(absolute)) });
  }
  return failures.length > 0 ? { failures } : { bases };
}
