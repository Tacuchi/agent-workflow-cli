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
 * What it adds on top of the existing machinery is the four things that have to
 * be true together before the first byte lands: the request is the one that was
 * sealed, the candidate output is the one that was shown, the authorization
 * covers the effect classes about to be exercised, and the base has not moved.
 * Any of the four failing stops before `publishArtifacts` is called at all.
 */

import { join } from "node:path";
import type { EffectAuthorizationResult, EffectClass } from "../../domain/capability/effects.js";
import type { CapabilityRequest } from "../../domain/capability/protocol.js";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { withCwdLock } from "../lock-service.js";
import type { PathsService } from "../paths-service.js";
import {
  SEMANTIC_PROTOCOL_VERSION,
  approvalDigest,
  semanticDigest,
} from "../semantic-operation/protocol.js";
import type { SemanticResponse } from "../semantic-operation/protocol.js";
import { publishArtifacts } from "../semantic-operation/publish.js";
import type { PublishableArtifact } from "../semantic-operation/publish.js";

export interface PreviewEntry {
  path: string;
  bytes: number;
  overwrite: boolean;
}

/** The compare-and-swap base: what the candidate output was computed FROM. */
export interface EffectBase {
  /** Workspace-relative path re-read at apply time. */
  path: string;
  /** Its digest at prepare time, ALWAYS produced by {@link baseDigest}. */
  digest: string;
}

/**
 * The one way to digest a base.
 *
 * Two conventions for "the digest of this file" is a comparison that fails for a
 * reason nobody can see: prepare would seal one form and apply recompute the
 * other, and every publication would look stale. Exported so both sides call the
 * same function rather than each reaching for a hash.
 */
export function baseDigest(text: string): string {
  return semanticDigest(text);
}

export interface DurableEffectPlan {
  capability: string;
  operation: string;
  request_digest: string;
  semantic_inputs_digest: string;
  artifacts: PublishableArtifact[];
  preview: PreviewEntry[];
  /** Seal over the exact bytes shown to the human. */
  approval_digest: string;
  /** Classes that cannot be exercised without a visible approval. */
  requires_approval: EffectClass[];
  base: EffectBase | null;
}

export type PreparedEffect =
  | { ok: true; plan: DurableEffectPlan }
  | { ok: false; failure: CapabilityFailure };

export interface PrepareDurableEffectInput {
  request: CapabilityRequest;
  authorization: EffectAuthorizationResult;
  artifacts: PublishableArtifact[];
  base?: EffectBase | null;
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

  const response = asSemanticResponse(input.request, input.artifacts);
  return {
    ok: true,
    plan: {
      capability: input.request.capability,
      operation: input.request.operation,
      request_digest: input.request.request_digest,
      semantic_inputs_digest: input.request.semantic_inputs_digest,
      artifacts: input.artifacts,
      preview: input.artifacts.map((a) => ({
        path: a.path,
        bytes: Buffer.byteLength(a.content, "utf8"),
        overwrite: a.overwrite === true,
      })),
      approval_digest: approvalDigest(response),
      requires_approval: [...input.authorization.needsPreflight],
      base: input.base ?? null,
    },
  };
}

/**
 * The exact bytes proposed, in the shape the existing seal already understands.
 *
 * Reusing `approvalDigest` rather than inventing a capability-flavoured one is
 * the whole point of the adapter: one seal over "what was approved is what gets
 * written", not two that can disagree.
 */
function asSemanticResponse(
  request: CapabilityRequest,
  artifacts: PublishableArtifact[],
): SemanticResponse {
  return {
    version: SEMANTIC_PROTOCOL_VERSION,
    operation: `${request.capability}.${request.operation}`,
    input_digest: request.semantic_inputs_digest,
    state: "proposed",
    artifacts: artifacts.map((a) => ({ path: a.path, content: a.content })),
  };
}

export interface EffectApproval {
  /** The digest the human was shown. */
  digest: string;
  /** Classes the human explicitly approved. */
  granted: readonly EffectClass[];
}

export interface AppliedEffect {
  written: string[];
  applied: EffectClass[];
}

export type EffectApply =
  | { ok: true; result: AppliedEffect }
  /** Never reported as success: what landed is enumerated even on failure. */
  | { ok: false; failure: CapabilityFailure; applied: EffectClass[] };

export interface ApplyDurableEffectInput {
  root: string;
  plan: DurableEffectPlan;
  approval: EffectApproval;
  /** Classes the invocation authorized by itself, applied without approval. */
  selfAuthorized: readonly EffectClass[];
}

export async function applyDurableEffect(
  fs: FileSystemPort,
  paths: PathsService,
  input: ApplyDurableEffectInput,
): Promise<EffectApply> {
  const gate = checkApproval(input);
  if (gate !== null) return { ok: false, failure: gate, applied: [] };

  const stale = await checkBase(fs, input);
  if (stale !== null) return { ok: false, failure: stale, applied: [] };

  const outcome = await withCwdLock(fs, paths, async () =>
    publishArtifacts(fs, input.root, input.plan.artifacts),
  );
  if ("error" in outcome) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_EFFECT_LOCKED",
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
    result: {
      written: outcome.value.written,
      applied: [...new Set([...input.selfAuthorized, ...input.approval.granted])].filter((c) =>
        DURABLE_CLASSES.includes(c),
      ),
    },
  };
}

function checkApproval(input: ApplyDurableEffectInput): CapabilityFailure | null {
  if (input.approval.digest !== input.plan.approval_digest) {
    return {
      code: "CAPABILITY_APPROVAL_MISMATCH",
      message: "lo aprobado no son los bytes que se van a escribir",
      action: "volvé a preparar el efecto y aprobá la propuesta que se muestra",
    };
  }
  const missing = input.plan.requires_approval.filter((c) => !input.approval.granted.includes(c));
  if (missing.length > 0) {
    return {
      code: "CAPABILITY_APPROVAL_MISSING",
      message: `falta aprobación visible para: ${missing.join(", ")}`,
      action: "mostrá datos, destino y efecto, y pedí aprobación antes de aplicar",
    };
  }
  return null;
}

/**
 * The base has to still be the base.
 *
 * A candidate output computed from revision N and published on top of revision
 * N+1 is a silent overwrite of whatever happened in between — the reason the
 * compare-and-swap exists at all. Re-read at apply, never trusted from prepare.
 */
async function checkBase(
  fs: FileSystemPort,
  input: ApplyDurableEffectInput,
): Promise<CapabilityFailure | null> {
  const base = input.plan.base;
  if (base === null) return null;
  const absolute = join(input.root, base.path);
  if (!(await fs.exists(absolute))) {
    return {
      code: "CAPABILITY_BASE_GONE",
      message: `la base '${base.path}' ya no existe`,
      action: "volvé a preparar la operación sobre la base vigente",
    };
  }
  const current = baseDigest(await fs.readText(absolute));
  if (current !== base.digest) {
    return {
      code: "CAPABILITY_BASE_STALE",
      message: `'${base.path}' cambió después de preparar la propuesta`,
      action: "volvé a preparar la operación sobre la base vigente y revisá el resultado",
    };
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
