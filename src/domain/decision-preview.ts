import type { EffectClass } from "./capability/effects.js";
import { SELF_AUTHORIZABLE_CLASSES } from "./capability/effects.js";
import type { DecisionNote, NoteFailure, NoteScope } from "./decision-note.js";
import type { EffectiveContract } from "./effective-contract.js";
import type { EffectGrant } from "./flow/authorization.js";
import type { LocalProposal, PreviewEntry, ProposalArtifact, ProposalBase } from "./proposal.js";
import { destinationsOf, observedEffects, sealProposal } from "./proposal.js";

/**
 * WHAT THE PERSON SEES, once, before deciding — and the seal their single
 * "yes" is given over.
 *
 * The eight sections are not a report format. They are the eight things somebody
 * needs in order to be responsible for the answer: what is being decided over,
 * what actually changes, who else is reached, how far it goes, which evidence
 * survives and which stops counting, what work the decision creates, where
 * execution comes back, and exactly which bytes land where. A preview missing
 * any of them asks for consent to something that was not shown.
 *
 * Every one of them is DERIVED from the composed contract and the sealed note.
 * That is the load-bearing part: a preview authored beside the change is a second
 * description of it, and the moment the two disagree the person is approving the
 * pleasant one. Here, changing anything material changes the proposal's digest,
 * so the grant given over the old seal stops covering the new bytes by
 * construction rather than by anybody remembering to re-check.
 *
 * And it is ONE authorization. Choosing an alternative registers the note and
 * authorizes exactly the previewed effects; there is no second confirmation
 * asking the same question in other words, because {@link grantFor} is derived
 * from the very seal that was shown. What that grant can never carry is the two
 * classes below — a decision note is a document, and a path that wanted to
 * destroy something or leave the machine to register one is not this path.
 */

/**
 * The classes registering a decision may ever exercise.
 *
 * Publishing a note writes a JSON document beside the spec it amends: it creates
 * or it replaces, and nothing else. `destructive` and `network_external` are
 * absent by intent and not by omission — no reachable combination of a note and
 * an index produces them, so their appearance means the artifacts are not the
 * ones this path is for, and the preview refuses instead of asking somebody to
 * authorize them under a decision's name.
 */
export const DECISION_EFFECT_CLASSES: readonly EffectClass[] = [
  "local_additive",
  "mutate_overwrite",
];

/** One assertion the decision moves, and the note that moves it. */
export interface EffectiveChange {
  assertion: string;
  from: "baseline" | "amended";
  to: "amended";
  by: string;
}

export interface DecisionPreview {
  /** 1 — the exact bytes the decision is taken over. */
  baseline: { path: string; number: string; digest: string };
  /** 2 — what the contract stops saying, assertion by assertion. */
  effective_change: EffectiveChange[];
  /** 3 — every plan the note reaches. */
  consumers: string[];
  /** 4 — how far it goes, in the terms `status` will later report. */
  impact: { scope: NoteScope; assertions: number; consumers: number };
  /** 5 — what still counts, and what stopped counting. */
  evidence: { preserved: string[]; invalidated: string[] };
  /** 6 — the compensatory work the decision creates. */
  obligations: string[];
  /** 7 — where execution resumes once this is registered. */
  resume_point: string;
  /** 8 — destination, weight and whether it replaces, plus the classes exercised. */
  effects: { classes: EffectClass[]; entries: PreviewEntry[] };
  /** The single seal covering all of the above. */
  proposal: LocalProposal;
}

export type PreviewBuild =
  | { status: "previewed"; preview: DecisionPreview }
  | { status: "blocked"; failures: NoteFailure[] };

export interface DecisionPreviewInput {
  /** The producer's vocabulary for what is being proposed, e.g. `flow.<id>`. */
  operation: string;
  /** The contract as it composes NOW, WITH this note applied. */
  contract: EffectiveContract;
  /** The note, already sealed — its id and digest come from the chain. */
  note: DecisionNote;
  /**
   * The bytes to publish, with `overwrite` already observed on disk.
   *
   * Observed and not intended: whether a destination exists is the one line of
   * the preview a person most needs to trust, and a caller that guessed it would
   * be showing "creates" over a replacement.
   */
  artifacts: readonly ProposalArtifact[];
  /** Every document the candidate was computed from, re-read at apply time. */
  bases: readonly ProposalBase[];
}

/**
 * Build the preview, or refuse to show one.
 *
 * It blocks rather than trims. A preview that dropped a section it could not
 * fill would be indistinguishable from one where that section was genuinely
 * empty — "no compensatory work" and "we did not work out the compensatory work"
 * look identical on screen and mean opposite things to whoever says yes.
 */
export function buildDecisionPreview(input: DecisionPreviewInput): PreviewBuild {
  const failures: NoteFailure[] = [];
  if (input.artifacts.length === 0) {
    failures.push({
      code: "PREVIEW_NO_ARTIFACTS",
      message: "la vista previa no tiene ningún destino que mostrar",
      action:
        "una decisión sin efectos no se registra: prepará el índice de decisiones antes de previsualizar",
    });
  }
  if (input.note.lineage.spec.digest !== input.contract.spec.digest) {
    failures.push({
      code: "PREVIEW_BASELINE_DRIFTED",
      message: `la nota decide sobre ${input.note.lineage.spec.digest} y el contrato compone sobre ${input.contract.spec.digest}`,
      action:
        "recomponé el contrato sobre la spec vigente y volvé a sellar la nota: previsualizar sobre dos baselines distintos muestra una decisión que nadie tomó",
    });
  }
  if (!input.contract.applied.includes(input.note.id)) {
    failures.push({
      code: "PREVIEW_NOTE_NOT_COMPOSED",
      message: `${input.note.id} no está entre las notas aplicadas del contrato que se muestra`,
      action:
        "componé el contrato incluyendo esta nota: la vista previa enseña el efecto real, no el que tendría si compusiera",
    });
  }
  // The seal has to cover the note that was SHOWN, and the note's own digest is
  // what proves it does. Without this, six of the eight sections are read off a
  // record the proposal never carries: a preview could show one resume point and
  // seal bytes holding another, and the approval would be over the pleasant one.
  // A substring is enough because the digest seals every field of the note — the
  // published record can only carry it by being this record.
  if (!input.artifacts.some((artifact) => artifact.content.includes(input.note.digest))) {
    failures.push({
      code: "PREVIEW_NOTE_NOT_SEALED",
      message: `ningún destino de la propuesta contiene ${input.note.id}`,
      action:
        "publicá la nota dentro de la propuesta que se aprueba: mostrar una decisión y sellar otros bytes es pedir consentimiento sobre algo que no se enseñó",
    });
  }

  const classes = observedEffects(input.artifacts);
  const beyond = classes.filter((effect) => !DECISION_EFFECT_CLASSES.includes(effect));
  if (beyond.length > 0) {
    failures.push({
      code: "PREVIEW_EFFECT_FORBIDDEN",
      message: `registrar una decisión ejercería ${beyond.join(", ")}`,
      action: `una nota sólo escribe su índice: proponé sólo efectos de ${DECISION_EFFECT_CLASSES.join(", ")}`,
    });
  }

  if (failures.length > 0) return { status: "blocked", failures };

  const proposal = sealProposal({
    operation: input.operation,
    artifacts: input.artifacts,
    bases: input.bases,
    effects: classes,
    requiresApproval: classes.filter((effect) => !SELF_AUTHORIZABLE_CLASSES.includes(effect)),
  });

  return {
    status: "previewed",
    preview: {
      baseline: input.contract.spec,
      effective_change: changesOf(input.contract, input.note),
      consumers: [...input.note.consumers],
      impact: {
        scope: input.note.scope,
        assertions: input.note.supersedes_assertions.length,
        consumers: input.note.consumers.length,
      },
      evidence: {
        preserved: [...input.note.evidence_preserved],
        invalidated: [...input.note.evidence_invalidated],
      },
      obligations: [...input.note.obligations],
      resume_point: input.note.resume_point,
      effects: { classes, entries: proposal.preview },
      proposal,
    },
  };
}

/**
 * The assertions THIS note moves, read off the composed contract.
 *
 * `from` comes from the contract's attribution rather than from the note: an
 * assertion another note already amended is not going from `baseline`, and
 * saying so would overstate what this decision costs.
 */
function changesOf(contract: EffectiveContract, note: DecisionNote): EffectiveChange[] {
  const mine = new Set(note.supersedes_assertions);
  return contract.assertions
    .filter((assertion) => mine.has(assertion.id))
    .map((assertion) => ({
      assertion: assertion.id,
      from: assertion.by === note.id ? ("baseline" as const) : ("amended" as const),
      to: "amended" as const,
      by: note.id,
    }));
}

/**
 * The grant one explicit choice gives — over this seal, and nothing wider.
 *
 * Derived from the preview instead of assembled beside it, so "authorize exactly
 * what was shown" is arithmetic. A grant naming a different digest covers
 * nothing, which is what makes a material change between the preview and the
 * write fail closed rather than sail through on a yes that was about other bytes.
 */
export function grantFor(preview: DecisionPreview): EffectGrant {
  return {
    digest: preview.proposal.digest,
    destinations: destinationsOf(preview.proposal),
    classes: [...preview.proposal.requires_approval],
  };
}
