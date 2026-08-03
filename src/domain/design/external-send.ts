import {
  type AdapterProfile,
  type RenderCapability,
  conformanceOf,
  degradationFailure,
  resolveCapability,
} from "./adapter.js";
import type { DataClassification, RenderBundle } from "./render-bundle.js";
import type { DesignFailure } from "./validation.js";

/**
 * The preflight of sending a bundle to somebody else's tool.
 *
 * There is no network client anywhere in this capability — v1 conformance is
 * satisfied by preparing the context and registering the result, so "the operation
 * does not call anybody without visible authorization" is true by construction
 * rather than by a check. What was missing is the other half of AC-SEC-01: before
 * anything leaves the workspace, the person has to be able to SEE what would leave
 * it, under whose authorization and with what visibility.
 *
 * So this produces a plan, always — for the authorized case and for the refused
 * one alike. A refusal that only says "not authorized" leaves the author guessing
 * what they are being asked to approve; a refusal that enumerates the documents,
 * the assets and the data classification is a decision somebody can actually make.
 *
 * And the local handoff never depends on this: the bundle exists, on disk, with no
 * account and no provider. Refusing to send is not refusing to work.
 */

/** What would leave the workspace, enumerated rather than summarized. */
export interface SendManifest {
  package: string;
  baseline: number;
  baseline_digest: string;
  data_classification: DataClassification;
  /** Every revision in the closure, by reference. */
  documents: string[];
  /** Every asset, by package-relative path. */
  assets: string[];
  /** Accessibility obligations travelling with the bundle. */
  obligations: number;
  /** What this profile is known not to represent. */
  losses: string[];
}

export interface ExternalSendPlan {
  adapter: string;
  version: number;
  /** Of `handoff`/`record`/`snapshot`, the ones this profile really declares. */
  conformance: RenderCapability[];
  capability: RenderCapability;
  /** False for a profile that can never reach a third party (`network: never`). */
  requires_authorization: boolean;
  authorized: boolean;
  would_send: SendManifest;
  /** What stays available regardless — the reason a refusal is not a dead end. */
  local_handoff: string;
}

export type ExternalSendOutcome =
  | { ok: true; plan: ExternalSendPlan }
  | { ok: false; plan: ExternalSendPlan; failure: DesignFailure };

export interface ExternalSendInput {
  adapter: AdapterProfile;
  bundle: RenderBundle;
  /** The capability being asked for. `handoff` is the floor. */
  capability?: RenderCapability;
  /** Who authorized reaching the provider, and for what. */
  authorization?: string;
}

/**
 * Plan a send, and say whether it may proceed.
 *
 * Two independent reasons to refuse, checked in this order because they answer
 * different questions: the capability decides whether this profile can do the
 * thing at all, and the authorization decides whether it may do it now. Reporting
 * the missing authorization for an operation the profile never supported would
 * send the author to get approval for something that still would not work.
 */
export function planExternalSend(input: ExternalSendInput): ExternalSendOutcome {
  const capability = input.capability ?? "handoff";
  const requires = input.adapter.network === "opt_in";
  const authorization = (input.authorization ?? "").trim();
  const authorized = !requires || authorization.length > 0;

  const plan: ExternalSendPlan = {
    adapter: input.adapter.id,
    version: input.adapter.version,
    conformance: conformanceOf(input.adapter),
    capability,
    requires_authorization: requires,
    authorized,
    would_send: sendManifest(input.bundle),
    local_handoff:
      "el bundle queda disponible localmente: validar, leer y entregarlo a mano no necesitan proveedor, cuenta ni red",
  };

  const resolution = resolveCapability(input.adapter, capability);
  if (!resolution.ok) {
    return {
      ok: false,
      plan,
      failure: degradationFailure(
        resolution.degradation,
        `${input.bundle.package}/render-bundle.json`,
      ),
    };
  }
  if (!authorized) {
    return { ok: false, plan, failure: unauthorized(plan) };
  }
  return { ok: true, plan };
}

function sendManifest(bundle: RenderBundle): SendManifest {
  return {
    package: bundle.package,
    baseline: bundle.baseline,
    baseline_digest: bundle.baseline_digest,
    data_classification: bundle.data_classification,
    documents: bundle.closure.map((m) => m.ref),
    assets: bundle.assets.map((a) => a.path),
    obligations: bundle.accessibility.length,
    losses: bundle.losses.map((l) => l.subject),
  };
}

/**
 * The refusal. It names what would have been sent, because that IS the thing being
 * authorized — and the count of documents and assets is what makes "real data to a
 * third party" concrete instead of abstract.
 */
function unauthorized(plan: ExternalSendPlan): DesignFailure {
  const sent = plan.would_send;
  return {
    code: "DESIGN_SEND_UNAUTHORIZED",
    artifact: `${sent.package}/render-bundle.json`,
    message: `'${plan.adapter}' alcanza a un tercero y nadie autorizó el envío: se enviarían ${sent.documents.length} revisión(es), ${sent.assets.length} asset(s) y material '${sent.data_classification}' de ${sent.package}@r${sent.baseline}`,
    action:
      "declará la autorización explícita del envío (quién la da y con qué visibilidad), o quedate con el handoff neutral local: el bundle ya está y no necesita proveedor",
  };
}
