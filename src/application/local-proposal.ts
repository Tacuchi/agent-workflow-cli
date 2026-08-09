/**
 * Applying a sealed local proposal — the one path, for whoever proposed it.
 *
 * The capability dispatcher and the flow engine both reach here, and that is the
 * point: two implementations of "check the approval, re-read the base, publish
 * all-or-nothing" would be two answers to whether a publication was legitimate,
 * and the weaker of the two would be the one that decides.
 *
 * What has to be true together before the first byte lands:
 *
 * - the approval was given over THIS proposal's seal, not a neighbouring one;
 * - every class the taxonomy demands a preflight for was actually granted;
 * - every base is still what the candidate output was computed from.
 *
 * Any of the three failing stops before `publishArtifacts` is called at all. And
 * a base that moved is not automatically a refusal: a publication that already
 * landed and whose confirmation never got written is the recoverable case F1
 * introduced, so it is recognized as such instead of being reported as a
 * conflict nobody can resolve.
 */

import { join } from "node:path";
import type { EffectClass } from "../domain/capability/effects.js";
import type { CapabilityFailure } from "../domain/capability/protocol.js";
import type { LocalProposal, ProposalArtifact } from "../domain/proposal.js";
import { baseDigest } from "../domain/proposal.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { publishArtifacts } from "./semantic-operation/publish.js";
import type { PublishableArtifact } from "./semantic-operation/publish.js";

export interface ProposalApproval {
  /** The seal the approval was given over. */
  digest: string;
  /** Classes explicitly granted. */
  granted: readonly EffectClass[];
}

export interface AppliedProposal {
  written: string[];
  applied: EffectClass[];
  /**
   * The bytes were already on disk, so nothing was written this time.
   *
   * Distinct from a fresh publication because the two mean different things to
   * whoever resumes: one says "it happened now", the other says "it had already
   * happened and this invocation only confirmed it".
   */
  already_applied: boolean;
}

export type ProposalApply =
  | { ok: true; result: AppliedProposal }
  /** Never reported as success: what landed is enumerated even on failure. */
  | { ok: false; failure: CapabilityFailure; applied: EffectClass[] };

export interface ApplyProposalInput {
  root: string;
  proposal: LocalProposal;
  approval: ProposalApproval;
  /** Classes the invocation authorized by itself, applied without approval. */
  selfAuthorized: readonly EffectClass[];
}

export async function applyLocalProposal(
  fs: FileSystemPort,
  paths: PathsService,
  input: ApplyProposalInput,
): Promise<ProposalApply> {
  const gate = checkApproval(input);
  if (gate !== null) return { ok: false, failure: gate, applied: [] };

  const applied = appliedClasses(input);

  if (await alreadyLanded(fs, input.root, input.proposal.artifacts)) {
    return {
      ok: true,
      result: { written: [], applied, already_applied: true },
    };
  }

  const stale = await checkBases(fs, input);
  if (stale !== null) return { ok: false, failure: stale, applied: [] };

  const outcome = await withCwdLock(fs, paths, async () =>
    publishArtifacts(fs, input.root, publishable(input.proposal.artifacts)),
  );
  if ("error" in outcome) {
    return {
      ok: false,
      failure: {
        code: "PROPOSAL_LOCKED",
        message: outcome.error,
        action: "esperá a que se libere el lock del workspace y volvé a aplicar",
      },
      applied: [],
    };
  }
  if (!outcome.ok) {
    // `publishArtifacts` is all-or-nothing and rolls back, so nothing landed —
    // and saying so explicitly is what makes the empty list a claim rather than
    // an omission.
    return {
      ok: false,
      failure: {
        code: outcome.failure.code,
        message: outcome.failure.message,
        action: outcome.failure.action,
      },
      applied: [],
    };
  }

  return {
    ok: true,
    result: { written: outcome.value.written, applied, already_applied: false },
  };
}

function publishable(artifacts: readonly ProposalArtifact[]): PublishableArtifact[] {
  return artifacts.map((a) => ({ path: a.path, content: a.content, overwrite: a.overwrite }));
}

/** Only the durable classes, and only the ones somebody really authorized. */
function appliedClasses(input: ApplyProposalInput): EffectClass[] {
  return [...new Set([...input.selfAuthorized, ...input.approval.granted])].filter((c) =>
    input.proposal.effects.includes(c),
  );
}

function checkApproval(input: ApplyProposalInput): CapabilityFailure | null {
  if (input.approval.digest !== input.proposal.digest) {
    return {
      code: "PROPOSAL_APPROVAL_MISMATCH",
      message: "lo aprobado no es la propuesta que se va a escribir",
      action: "volvé a preparar la propuesta y aprobá exactamente la vista previa que se muestra",
    };
  }
  const missing = input.proposal.requires_approval.filter(
    (c) => !input.approval.granted.includes(c),
  );
  if (missing.length > 0) {
    return {
      code: "PROPOSAL_APPROVAL_MISSING",
      message: `falta aprobación visible para: ${missing.join(", ")}`,
      action: "mostrá datos, destino y efecto, y pedí aprobación antes de aplicar",
    };
  }
  return null;
}

/**
 * Whether every destination already holds exactly these bytes.
 *
 * This is the re-entry case, not an optimization. A process that published and
 * died before its confirmation was persisted comes back with the base moved — by
 * its own write — and refusing it as stale would strand a run on a conflict that
 * does not exist. Checked on the artifacts and never on the bases, because the
 * question is "is the result already there", and only the exact bytes answer it:
 * a destination holding anything else is not this publication.
 */
async function alreadyLanded(
  fs: FileSystemPort,
  root: string,
  artifacts: readonly ProposalArtifact[],
): Promise<boolean> {
  for (const artifact of artifacts) {
    const absolute = join(root, artifact.path);
    if (!(await fs.exists(absolute))) return false;
    try {
      if ((await fs.readText(absolute)) !== artifact.content) return false;
    } catch {
      return false;
    }
  }
  return artifacts.length > 0;
}

/**
 * Every base has to still be the base.
 *
 * A candidate output computed from revision N and published on top of revision
 * N+1 is a silent overwrite of whatever happened in between — the reason the
 * compare-and-swap exists at all. Re-read at apply, never trusted from prepare.
 */
async function checkBases(
  fs: FileSystemPort,
  input: ApplyProposalInput,
): Promise<CapabilityFailure | null> {
  for (const base of input.proposal.bases) {
    const absolute = join(input.root, base.path);
    if (!(await fs.exists(absolute))) {
      return {
        code: "PROPOSAL_BASE_GONE",
        message: `la base '${base.path}' ya no existe`,
        action: "volvé a preparar la operación sobre la base vigente",
      };
    }
    const current = baseDigest(await fs.readText(absolute));
    if (current !== base.digest) {
      return {
        code: "PROPOSAL_BASE_STALE",
        message: `'${base.path}' cambió después de preparar la propuesta`,
        action: "volvé a preparar la operación sobre la base vigente y revisá el resultado",
      };
    }
  }
  return null;
}

export interface PartialEffect {
  class: EffectClass;
  /** What actually landed, in terms a person can act on. */
  what: string;
}

export interface Reconciliation {
  applied: EffectClass[];
  next_action: string;
}

/**
 * What to say when something broke or was cancelled AFTER an effect landed.
 *
 * The failure mode this closes is the comfortable one: reporting a cancellation
 * as if nothing had happened, because the operation "did not finish". An
 * external step that already left the machine cannot be un-left, so the honest
 * report enumerates it and hands back the reconciliation to run.
 */
export function reconcileAfterFailure(
  outcome: "failed" | "cancelled",
  partial: readonly PartialEffect[],
): Reconciliation {
  if (partial.length === 0) {
    return {
      applied: [],
      next_action:
        outcome === "cancelled"
          ? "no se aplicó ningún efecto: podés volver a intentar cuando quieras"
          : "no se aplicó ningún efecto: corregí la causa del fallo y volvé a intentar",
    };
  }
  const detail = partial.map((p) => `${p.class}: ${p.what}`).join("; ");
  return {
    applied: [...new Set(partial.map((p) => p.class))],
    next_action: `quedaron efectos aplicados que hay que reconciliar a mano — ${detail}`,
  };
}
