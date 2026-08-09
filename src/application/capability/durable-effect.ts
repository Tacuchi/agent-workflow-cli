/**
 * The bridge from a capability attempt to the durable handshake that already
 * exists — and the line that keeps the two from merging.
 *
 * `prepare → validate → apply` is how this repo previews, approves and writes.
 * It is not a conversation, and a capability's attempts are not stages of it.
 * The distinction is load-bearing: an operation that only reads, or an attempt
 * that answers `needs_input`, must not manufacture a preview and an approval for
 * something that will never be written. So this adapter is entered ONLY when an
 * attempt is about to produce a durable effect, and it refuses otherwise.
 *
 * What it no longer owns is the seal, the preview, the compare-and-swap and the
 * write: those are the {@link LocalProposal} contract, shared with the flow
 * engine. What stays here is the capability's own half — refusing a non-durable
 * or denied attempt, and carrying the request's identity into the receipt.
 */

import type { EffectAuthorizationResult, EffectClass } from "../../domain/capability/effects.js";
import type { CapabilityFailure, CapabilityRequest } from "../../domain/capability/protocol.js";
import type { LocalProposal, ProposalBase } from "../../domain/proposal.js";
import { sealProposal } from "../../domain/proposal.js";
import type { PublishableArtifact } from "../semantic-operation/publish.js";

/**
 * A proposal plus the request identity the receipt has to quote back.
 *
 * The two are kept in one record rather than threaded separately because the
 * apply stage receives exactly this from the caller: splitting them would let a
 * proposal arrive paired with a different request's digests, which is the drift
 * the seal exists to prevent.
 */
export interface DurableEffectPlan {
  capability: string;
  operation: string;
  request_digest: string;
  semantic_inputs_digest: string;
  proposal: LocalProposal;
}

export type PreparedEffect =
  | { ok: true; plan: DurableEffectPlan }
  | { ok: false; failure: CapabilityFailure };

export interface PrepareDurableEffectInput {
  request: CapabilityRequest;
  authorization: EffectAuthorizationResult;
  artifacts: PublishableArtifact[];
  base?: ProposalBase | null;
}

const DURABLE_CLASSES: readonly EffectClass[] = [
  "local_additive",
  "mutate_overwrite",
  "execute",
  "network_external",
  "destructive",
];

export function prepareDurableEffect(input: PrepareDurableEffectInput): PreparedEffect {
  const durable = input.authorization.planned.filter((c) => DURABLE_CLASSES.includes(c));
  if (durable.length === 0) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_EFFECT_NOT_DURABLE",
        message: `'${input.request.operation}' no declara ningún efecto durable`,
        action:
          "una operación read-only devuelve su resultado y no atraviesa preview ni aprobación",
      },
    };
  }
  if (input.authorization.denied.length > 0) {
    const first = input.authorization.denied[0];
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_EFFECT_DENIED",
        message: `la política del host no admite el efecto '${first?.class}'`,
        action: "quitá la operación o ajustá la política del host, que siempre prevalece",
      },
    };
  }
  if (input.artifacts.length === 0) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_EFFECT_EMPTY",
        message: "no hay ningún artefacto candidato que publicar",
        action: "producí el output antes de preparar el efecto durable",
      },
    };
  }

  return {
    ok: true,
    plan: {
      capability: input.request.capability,
      operation: input.request.operation,
      request_digest: input.request.request_digest,
      semantic_inputs_digest: input.request.semantic_inputs_digest,
      proposal: sealProposal({
        operation: `${input.request.capability}.${input.request.operation}`,
        artifacts: input.artifacts.map((a) => ({
          path: a.path,
          content: a.content,
          overwrite: a.overwrite === true,
        })),
        bases: input.base == null ? [] : [input.base],
        // The capability's own policy inputs, sealed rather than assumed: an
        // attempt that read a sensitive source is not the same proposal as one
        // that did not, even when every byte matches.
        scope: {
          sensitive_sources: input.request.policy.sensitive_sources === true,
          scope_expanded: false,
        },
        effects: durable,
        requiresApproval: input.authorization.needsPreflight,
      }),
    },
  };
}
