/**
 * The exact local change somebody is about to approve — bytes, destinations,
 * bases, scope and effects — under ONE seal.
 *
 * Before this, "what was approved" was two different things depending on who
 * asked. The capability path sealed the artifacts and kept the base, the scope
 * and the effect classes outside the seal; the flow sealed the effect CLASSES of
 * a transition and no bytes at all. Both are approvals, and neither could answer
 * the question the whole handshake exists for: *is this still the same thing the
 * person said yes to?* A base that moved, a destination that changed, a scope
 * that widened or one more effect class would all have slipped through one of the
 * two.
 *
 * So the proposal is one record and the seal covers all of it. Anything material
 * that changes produces a different digest, which is what makes "an identical
 * retry never asks again, and any material change always does" a property of the
 * data rather than a rule somebody has to remember to apply.
 *
 * The preview is DERIVED here and never stored twice: what is shown and what is
 * sealed have to come from the same bytes, or the preview becomes a second
 * description of the change that can disagree with it.
 */

import { semanticDigest } from "../application/semantic-operation/protocol.js";
import type { EffectClass } from "./capability/effects.js";

export interface ProposalArtifact {
  /** Workspace-relative destination. */
  path: string;
  /** The exact bytes to write. */
  content: string;
  /** Replace an existing target. Never implicit — it is part of the seal. */
  overwrite: boolean;
}

/** The compare-and-swap base: what the candidate output was computed FROM. */
export interface ProposalBase {
  /** Workspace-relative path, re-read at apply time. */
  path: string;
  /** Its digest when the proposal was sealed, always via {@link baseDigest}. */
  digest: string;
}

/**
 * The one way to digest a base.
 *
 * Two conventions for "the digest of this file" is a comparison that fails for a
 * reason nobody can see: one side would seal one form and the other recompute the
 * other, and every publication would look stale.
 */
export function baseDigest(text: string): string {
  return semanticDigest(text);
}

/**
 * The facts that widen what is being asked, beyond the bytes themselves.
 *
 * They are in the seal for the same reason the destinations are: approving a
 * change that reads no sensitive source is not approving the same change once it
 * does, even when every byte is identical.
 */
export interface ProposalScope {
  sensitive_sources: boolean;
  scope_expanded: boolean;
}

/** What a person sees before deciding: destination, weight, and whether it replaces. */
export interface PreviewEntry {
  path: string;
  bytes: number;
  overwrite: boolean;
}

export interface LocalProposal {
  /** What is being proposed, in its producer's vocabulary (`flow.<id>`, `<cap>.<op>`). */
  operation: string;
  artifacts: ProposalArtifact[];
  /** Derived from {@link artifacts}, never authored beside them. */
  preview: PreviewEntry[];
  bases: ProposalBase[];
  scope: ProposalScope;
  /** Effect classes publishing this proposal really exercises. */
  effects: EffectClass[];
  /** Of those, the ones no invocation may grant itself. */
  requires_approval: EffectClass[];
  /** The single seal over everything above. */
  digest: string;
}

export interface SealProposalInput {
  operation: string;
  artifacts: readonly ProposalArtifact[];
  bases?: readonly ProposalBase[];
  scope?: Partial<ProposalScope>;
  effects: readonly EffectClass[];
  requiresApproval: readonly EffectClass[];
}

export function sealProposal(input: SealProposalInput): LocalProposal {
  const artifacts = input.artifacts.map((a) => ({
    path: a.path,
    content: a.content,
    overwrite: a.overwrite,
  }));
  const body = {
    operation: input.operation,
    artifacts,
    preview: previewOf(artifacts),
    bases: [...(input.bases ?? [])],
    scope: {
      sensitive_sources: input.scope?.sensitive_sources === true,
      scope_expanded: input.scope?.scope_expanded === true,
    },
    effects: [...input.effects],
    requires_approval: [...input.requiresApproval],
  };
  return { ...body, digest: proposalDigest(body) };
}

export function previewOf(artifacts: readonly ProposalArtifact[]): PreviewEntry[] {
  return artifacts.map((a) => ({
    path: a.path,
    bytes: Buffer.byteLength(a.content, "utf8"),
    overwrite: a.overwrite,
  }));
}

/**
 * The seal, over the SET rather than the order it was listed in.
 *
 * Sorting is the same reason `effectApprovalDigest` sorts its classes: two
 * publications of identical content that happened to enumerate their files in a
 * different order are the same proposal, and asking a second time for it would be
 * the "identical retry never re-asks" rule failing on a detail nobody can see.
 * Content travels as its own digest so the seal stays a fixed size whatever the
 * dossier weighs.
 */
export function proposalDigest(body: Omit<LocalProposal, "digest">): string {
  return semanticDigest({
    operation: body.operation,
    artifacts: [...body.artifacts]
      .map((a) => ({
        path: a.path,
        content_digest: semanticDigest(a.content),
        overwrite: a.overwrite,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    bases: [...body.bases].sort((a, b) => a.path.localeCompare(b.path)),
    scope: body.scope,
    effects: [...body.effects].sort(),
    requires_approval: [...body.requires_approval].sort(),
  });
}

/** The destinations a grant over this proposal covers, and nothing wider. */
export function destinationsOf(proposal: LocalProposal): string[] {
  return [...new Set(proposal.artifacts.map((a) => a.path))].sort();
}
