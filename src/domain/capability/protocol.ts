/**
 * One attempt at one operation, described the same way from both routes.
 *
 * The direct wrapper and a composing flow build this envelope with the SAME
 * builder. That is the whole mechanism behind "the two routes share a contract":
 * not a promise in Markdown, but a single function neither caller can bypass
 * without the difference showing up in a digest.
 *
 * **Attempts, not a fourth stage.** `prepare → validate → apply` is the durable
 * handshake for previewing, approving and writing; it is not a conversation.
 * When an operation needs more information it answers `needs_input` and the
 * reply becomes a NEW request: same `invocation_id`, `attempt + 1`, and
 * `parent_request_digest` pointing at the one it answers. Reusing the parent
 * request instead would let a stale envelope be re-submitted against a world
 * that moved, and would make a retry indistinguishable from a new attempt.
 *
 * **Two digests, because two questions.** `request_digest` seals the whole
 * envelope — route, caller, authorizations, everything — and answers "is this
 * the exact attempt I saw?". `semantic_inputs_digest` seals only the normalized
 * semantic entry and answers "is this the same work?". They must be separate:
 * the direct route and a flow legitimately differ in caller and route while
 * asking for identical work, and a single digest would make that equality
 * unprovable.
 *
 * **Nothing invisible.** Every input arrives declared, with provenance. There is
 * no field here for a private prompt or ambient state, and that absence is
 * enforced by a guard: semantics the caller cannot see are semantics the caller
 * cannot audit.
 */

import { randomUUID } from "node:crypto";
import { semanticDigest } from "../../application/semantic-operation/protocol.js";
import type { CheckoutProof } from "../source-boundary.js";
import type {
  CapabilityDescriptor,
  CapabilityExposure,
  CapabilityOperation,
  Completeness,
  DegradationCause,
  InputKind,
  InputSensitivity,
  WorkspaceRequirement,
} from "./descriptor.js";
import { findOperation } from "./descriptor.js";
import type { EffectClass } from "./effects.js";

export const CAPABILITY_PROTOCOL_VERSION = 1;

/** Same shape `failSemantic` consumes, so a failure crosses to the CLI unchanged. */
export interface CapabilityFailure {
  code: string;
  message: string;
  /** One valid next action — never a dead end. */
  action: string;
}

export type CapabilityRoute = CapabilityExposure;

const INVOCATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newInvocationId(): string {
  return randomUUID();
}

/**
 * Where a value came from, carried next to the value itself.
 *
 * Without this an output can be produced from something nobody can name
 * afterwards. `origin` is a locator or a caller-declared source; `seal` is a
 * digest or version WHEN OBTAINABLE — `null` is the honest answer for a value
 * typed into a conversation, and pretending otherwise would make the receipt
 * claim a verifiability it does not have.
 */
export interface InputProvenance {
  kind: InputKind;
  origin: string;
  seal: string | null;
  sensitivity: InputSensitivity;
}

export interface CapabilityInputValue {
  name: string;
  value: unknown;
  provenance: InputProvenance;
}

export interface CapabilityCaller {
  route: CapabilityRoute;
  /** Host alias the invocation came through (`claude`, `codex`, …). */
  host: string;
  /** The composing flow/command, or null on the direct route. */
  flow: string | null;
}

export interface CapabilityContext {
  /** Absolute workspace root when the caller is inside one, else null. */
  workspace: string | null;
  /** Where the output should land, as the caller declared it. */
  target: string | null;
  /** Compare-and-swap base for an operation that revises something. */
  base: string | null;
  profile: string | null;
}

export interface CapabilityDataPolicy {
  /** Whether reading declared SENSITIVE inputs is permitted in this invocation. */
  sensitive_sources: boolean;
  /** Whether any payload may leave the machine. */
  external_transmission: boolean;
}

export interface CapabilityRequest {
  protocol_version: number;
  /** Stable across every attempt of one conversation. */
  invocation_id: string;
  /** 1-based and strictly sequential within the invocation. */
  attempt: number;
  capability: string;
  contract_version: number;
  operation: string;
  caller: CapabilityCaller;
  context: CapabilityContext;
  inputs: CapabilityInputValue[];
  policy: CapabilityDataPolicy;
  /** Effect classes a preflight already approved for this attempt. */
  authorizations: EffectClass[];
  /** The `request_digest` of the attempt this one answers, or null on the first. */
  parent_request_digest: string | null;
  request_digest: string;
  semantic_inputs_digest: string;
}

export interface BuildCapabilityRequestInput {
  invocationId: string;
  attempt: number;
  descriptor: CapabilityDescriptor;
  operation: string;
  caller: CapabilityCaller;
  context: CapabilityContext;
  inputs: CapabilityInputValue[];
  policy: CapabilityDataPolicy;
  authorizations: readonly EffectClass[];
  parentRequestDigest: string | null;
}

export type CapabilityRequestBuild =
  | { ok: true; request: CapabilityRequest; operation: CapabilityOperation }
  | { ok: false; failure: CapabilityFailure };

/**
 * THE builder. Both routes go through it, and it refuses anything the
 * descriptor does not declare — an unknown operation, a route the operation does
 * not answer on, an undeclared input, a missing required one, or an attempt
 * number that does not line up with its parent.
 */
export function buildCapabilityRequest(input: BuildCapabilityRequestInput): CapabilityRequestBuild {
  const gate = checkEnvelope(input);
  if (gate !== null) return { ok: false, failure: gate };

  const operation = findOperation(input.descriptor, input.operation) as CapabilityOperation;
  const inputs = [...input.inputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const seed = {
    protocol_version: CAPABILITY_PROTOCOL_VERSION,
    invocation_id: input.invocationId,
    attempt: input.attempt,
    capability: input.descriptor.name,
    contract_version: input.descriptor.contract_version,
    operation: input.operation,
    caller: input.caller,
    context: input.context,
    inputs,
    policy: input.policy,
    authorizations: [...input.authorizations].sort(),
    parent_request_digest: input.parentRequestDigest,
  };

  return {
    ok: true,
    operation,
    request: {
      ...seed,
      request_digest: semanticDigest(seed),
      semantic_inputs_digest: semanticInputsDigest(seed),
    },
  };
}

/**
 * The seal over WHAT WAS ASKED, deliberately blind to WHO ASKED.
 *
 * Route, host, flow and the authorizations a preflight granted are all excluded:
 * they are properties of the call, not of the work. That exclusion is what lets
 * a conformance test prove the direct wrapper and a flow asked for the same
 * thing without demanding byte equality the contract never promised.
 */
function semanticInputsDigest(seed: {
  capability: string;
  operation: string;
  context: CapabilityContext;
  inputs: readonly CapabilityInputValue[];
}): string {
  return semanticDigest({
    capability: seed.capability,
    operation: seed.operation,
    target: seed.context.target,
    base: seed.context.base,
    profile: seed.context.profile,
    inputs: seed.inputs.map((i) => ({ name: i.name, value: i.value })),
  });
}

function checkEnvelope(input: BuildCapabilityRequestInput): CapabilityFailure | null {
  if (!INVOCATION_ID_RE.test(input.invocationId)) {
    return {
      code: "CAPABILITY_INVOCATION_ID_INVALID",
      message: `'${input.invocationId}' no es un invocation id`,
      action: "generá el id con newInvocationId() y conservalo durante toda la conversación",
    };
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    return {
      code: "CAPABILITY_ATTEMPT_INVALID",
      message: `attempt inválido: ${String(input.attempt)}`,
      action: "el primer intento es 1 y cada continuación suma exactamente 1",
    };
  }
  // The first attempt answers nothing and a continuation always answers
  // something: either mismatch means the chain is not what it claims to be.
  if (input.attempt === 1 && input.parentRequestDigest !== null) {
    return {
      code: "CAPABILITY_PARENT_UNEXPECTED",
      message: "el primer intento declara un request padre",
      action: "dejá 'parent_request_digest' en null para attempt = 1",
    };
  }
  if (input.attempt > 1 && input.parentRequestDigest === null) {
    return {
      code: "CAPABILITY_PARENT_MISSING",
      message: `attempt ${input.attempt} no declara el request padre que contesta`,
      action: "pasá el 'request_digest' del intento anterior como parent_request_digest",
    };
  }

  const operation = findOperation(input.descriptor, input.operation);
  if (operation === null) {
    return {
      code: "CAPABILITY_OPERATION_UNKNOWN",
      message: `'${input.descriptor.name}' no declara la operación '${input.operation}'`,
      action: `usá una de: ${input.descriptor.operations.map((o) => o.name).join(", ")}`,
    };
  }
  if (!operation.exposure.includes(input.caller.route)) {
    return {
      code: "CAPABILITY_ROUTE_UNSUPPORTED",
      message: `'${input.operation}' no se expone por la ruta '${input.caller.route}'`,
      action: `invocala por: ${operation.exposure.join(", ")}`,
    };
  }
  return checkInputs(operation, input);
}

function checkInputs(
  operation: CapabilityOperation,
  input: BuildCapabilityRequestInput,
): CapabilityFailure | null {
  const declared = new Map(operation.inputs.map((i) => [i.name, i]));
  const seen = new Set<string>();

  for (const given of input.inputs) {
    const spec = declared.get(given.name);
    if (spec === undefined) {
      return {
        code: "CAPABILITY_INPUT_UNDECLARED",
        message: `'${operation.name}' no declara el input '${given.name}'`,
        action: `pasá solo: ${operation.inputs.map((i) => i.name).join(", ") || "(ninguno)"}`,
      };
    }
    if (seen.has(given.name)) {
      return {
        code: "CAPABILITY_INPUT_REPEATED",
        message: `el input '${given.name}' viene dos veces`,
        action: "pasá cada input una sola vez",
      };
    }
    seen.add(given.name);

    // Provenance is not decoration: without it the receipt cannot say what the
    // output was derived from, which is the only auditable claim it makes.
    if (given.provenance.origin.trim().length === 0) {
      return {
        code: "CAPABILITY_INPUT_PROVENANCE_MISSING",
        message: `el input '${given.name}' no declara de dónde salió`,
        action: "declará 'origin' con el locator o la fuente que produjo el valor",
      };
    }
    if (given.provenance.sensitivity === "sensitive" && !input.policy.sensitive_sources) {
      return {
        code: "CAPABILITY_SENSITIVE_INPUT_UNAUTHORIZED",
        message: `el input '${given.name}' es sensible y la política de la invocación no lo permite`,
        action: "pedí aprobación para fuentes sensibles o quitá el input",
      };
    }
  }

  for (const spec of operation.inputs) {
    if (spec.required && !seen.has(spec.name)) {
      return {
        code: "CAPABILITY_INPUT_REQUIRED_MISSING",
        message: `'${operation.name}' exige el input '${spec.name}'`,
        action: `pasá '${spec.name}' con su proveniencia`,
      };
    }
  }
  return null;
}

/**
 * Whether the operation can run where the caller is standing.
 *
 * Returning a verdict is the whole contract: being outside a workspace is an
 * answer, never a reason to create one. A capability that scaffolded `.workflow/`
 * to satisfy its own precondition would turn "I asked a question" into "I
 * initialized your project".
 */
export type WorkspaceCheck =
  | { ok: true; requirement: WorkspaceRequirement }
  | { ok: false; failure: CapabilityFailure };

export function checkWorkspaceRequirement(
  operation: CapabilityOperation,
  context: CapabilityContext,
): WorkspaceCheck {
  if (operation.workspace !== "required" || context.workspace !== null) {
    return { ok: true, requirement: operation.workspace };
  }
  return {
    ok: false,
    failure: {
      code: "CAPABILITY_WORKSPACE_REQUIRED",
      message: `'${operation.name}' necesita un workspace Workline y no hay ninguno acá`,
      action: "corré la operación dentro de un workspace, o inicializá uno con 'aw workspace-init'",
    },
  };
}

export interface ContinuationInput {
  parent: CapabilityRequest;
  descriptor: CapabilityDescriptor;
  /** The full input set of the NEXT attempt — the answer, merged by the caller. */
  inputs: CapabilityInputValue[];
  caller: CapabilityCaller;
  context: CapabilityContext;
  policy: CapabilityDataPolicy;
  authorizations: readonly EffectClass[];
}

/**
 * Build the attempt that answers a `needs_input`.
 *
 * The parent is re-sealed before anything else: a caller can hand back an
 * envelope it edited, and the digest is the only thing that notices. Everything
 * downstream — the pinned selection, the receipt chain — trusts that link.
 */
export function continueInvocation(input: ContinuationInput): CapabilityRequestBuild {
  const { parent } = input;
  const resealed = semanticDigest(withoutDigests(parent));
  if (resealed !== parent.request_digest) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_PARENT_ALTERED",
        message: "el request padre no coincide con su propio digest",
        action: "reenviá el request padre tal como lo devolvió el intento anterior",
      },
    };
  }
  return buildCapabilityRequest({
    invocationId: parent.invocation_id,
    attempt: parent.attempt + 1,
    descriptor: input.descriptor,
    operation: parent.operation,
    caller: input.caller,
    context: input.context,
    inputs: input.inputs,
    policy: input.policy,
    authorizations: input.authorizations,
    parentRequestDigest: parent.request_digest,
  });
}

/** The envelope minus its own two seals — what `request_digest` is computed over. */
function withoutDigests(request: CapabilityRequest): unknown {
  const { request_digest: _seal, semantic_inputs_digest: _semantic, ...rest } = request;
  return rest;
}

export type AttemptKind = "new" | "retry";

export type AttemptRecord =
  | { ok: true; kind: AttemptKind }
  | { ok: false; failure: CapabilityFailure };

/**
 * The ledger that tells a retry apart from a second attempt.
 *
 * Same `invocation_id` and same `attempt` with the SAME digest is a resend — the
 * network hiccuped, nothing changed, and answering it twice must not advance the
 * conversation. The same pair with DIFFERENT bytes is two different attempts
 * wearing one number, and accepting it would silently drop one of them.
 *
 * Sequence is checked here too: attempts arrive 1, 2, 3. A jump means the chain
 * has a hole, and a hole is exactly where a stale envelope gets in.
 */
/**
 * The four fields the ledger actually reads.
 *
 * Named apart so anything with an attempt chain can be validated by the SAME
 * rules — a flow run's persisted attempt history does exactly that. A full
 * {@link CapabilityRequest} satisfies it structurally, so no existing caller
 * changes.
 */
export type AttemptIdentity = Pick<
  CapabilityRequest,
  "invocation_id" | "attempt" | "request_digest" | "parent_request_digest"
>;

export class AttemptLedger {
  private readonly seen = new Map<string, Map<number, string>>();

  record(request: AttemptIdentity): AttemptRecord {
    const attempts = this.seen.get(request.invocation_id) ?? new Map<number, string>();
    const known = attempts.get(request.attempt);

    if (known !== undefined) {
      if (known === request.request_digest) return { ok: true, kind: "retry" };
      return {
        ok: false,
        failure: {
          code: "CAPABILITY_ATTEMPT_DIVERGED",
          message: `el intento ${request.attempt} ya existe con otro contenido`,
          action: "para pedir algo distinto usá el attempt siguiente, no el mismo número",
        },
      };
    }

    const highest = Math.max(0, ...attempts.keys());
    if (request.attempt !== highest + 1) {
      return {
        ok: false,
        failure: {
          code: "CAPABILITY_ATTEMPT_OUT_OF_SEQUENCE",
          message: `llegó el intento ${request.attempt} y el anterior registrado es ${highest}`,
          action: `enviá el intento ${highest + 1}`,
        },
      };
    }
    if (request.attempt > 1) {
      const parentDigest = attempts.get(request.attempt - 1);
      if (parentDigest !== request.parent_request_digest) {
        return {
          ok: false,
          failure: {
            code: "CAPABILITY_PARENT_NOT_IMMEDIATE",
            message: "el request padre no es el intento inmediatamente anterior",
            action: `enlazá el intento ${request.attempt} con el digest del intento ${request.attempt - 1}`,
          },
        };
      }
    }

    attempts.set(request.attempt, request.request_digest);
    this.seen.set(request.invocation_id, attempts);
    return { ok: true, kind: "new" };
  }
}

/**
 * How an attempt ended — five values, and none of them means "roughly fine".
 *
 * `completed` is the only success. The other four are distinct on purpose:
 * `needs_input` is a question, `blocked` is a precondition nobody in this run
 * can clear, `failed` is something that broke, and `cancelled` is a human
 * changing their mind. Collapsing them would turn "I need the target directory"
 * and "the provider rejected the payload" into the same word, and the next
 * action for those two has nothing in common.
 */
export const CAPABILITY_OUTCOMES = [
  "completed",
  "needs_input",
  "blocked",
  "failed",
  "cancelled",
] as const;

export type CapabilityOutcome = (typeof CAPABILITY_OUTCOMES)[number];

/**
 * A durable output identified by what it IS, not by where it happens to sit.
 *
 * `id` and `revision` are the identity, `digest` is the proof, and `locator` is
 * a convenience that may go stale without costing anything. That ordering is why
 * a package created through the direct route can be adopted later by a flow with
 * no conversion: the flow re-resolves the identity and verifies the digest.
 */
export interface DurableReference {
  id: string;
  revision: number | null;
  /** `sha256:<64-hex>` over the canonical bytes of the referenced artifact. */
  digest: string;
  /** Workspace-relative path. A hint — the identity is `id`/`revision`. */
  locator: string;
}

/**
 * What an attempt produced.
 *
 * A typed value, a durable reference, or both — never the host's prose. Prose is
 * what a person reads; a flow that consumed it would be parsing a rendering, and
 * the day the wording changes the flow breaks for no functional reason.
 *
 * `completeness` sits here rather than in the outcome because they answer
 * different questions: the outcome says whether the attempt finished, this says
 * whether what came back covers the requested profile.
 */
export interface OperationOutput {
  value: unknown | null;
  reference: DurableReference | null;
  completeness: Completeness | null;
}

/** One instance that actually contributed, in the order it contributed. */
export interface SelectedInstance {
  name: string;
  /** Where the instance is installed (`global`, `workspace`, a host root…). */
  scope: string;
  locator: string;
  version: string | null;
  digest: string;
  /** 1-based position in the host's selection. */
  order: number;
}

/** What happened to each declared input — including the ones nothing read. */
export interface InputDisposition {
  name: string;
  used: boolean;
  /** Why it was not used. Required exactly when `used` is false. */
  reason: string | null;
  provenance: InputProvenance;
}

export interface ValidationOutcome {
  id: string;
  passed: boolean;
  detail: string | null;
  /** Present whenever the evidence is governed by `workline.source-bounded`. */
  proof?: CheckoutProof;
}

/**
 * Effects across their three moments. Keeping them apart is what makes a partial
 * external effect expressible: planned three, approved three, applied one.
 */
export interface EffectLedger {
  planned: EffectClass[];
  approved: EffectClass[];
  applied: EffectClass[];
}

export interface Degradation {
  cause: DegradationCause;
  /** What was lost, observably. Never an attribution to something unverified. */
  loss: string;
}

export interface CapabilityReceipt {
  protocol_version: number;
  invocation_id: string;
  attempt: number;
  capability: string;
  operation: string;
  request_digest: string;
  semantic_inputs_digest: string;
  parent_request_digest: string | null;
  outcome: CapabilityOutcome;
  /** Whether the built-in floor produced the result. */
  floor: boolean;
  selection: SelectedInstance[];
  inputs: InputDisposition[];
  output: OperationOutput | null;
  validations: ValidationOutcome[];
  effects: EffectLedger;
  degradations: Degradation[];
  /** Requirements still missing. Non-empty exactly when outcome is `needs_input`. */
  gaps: string[];
  error: CapabilityFailure | null;
  /** Never empty. A receipt without a next action is a dead end. */
  next_action: string;
}

export interface BuildReceiptInput {
  request: CapabilityRequest;
  descriptor: CapabilityDescriptor;
  outcome: CapabilityOutcome;
  floor: boolean;
  selection?: SelectedInstance[];
  inputs: InputDisposition[];
  output?: OperationOutput | null;
  validations?: ValidationOutcome[];
  effects?: Partial<EffectLedger>;
  degradations?: Degradation[];
  gaps?: string[];
  error?: CapabilityFailure | null;
  nextAction: string;
}

export type ReceiptBuild =
  | { ok: true; receipt: CapabilityReceipt }
  | { ok: false; failure: CapabilityFailure };

/**
 * Build the receipt, refusing the combinations that would let a run lie.
 *
 * Every rule here exists because its absence produces a specific lie: a
 * `completed` with nothing to show, a `failed` that names no error, a
 * `needs_input` that asks for nothing, applied effects nobody planned, a
 * degradation whose cause the contract never declared, or an attribution to an
 * instance the resolution could not identify.
 */
export function buildReceipt(input: BuildReceiptInput): ReceiptBuild {
  const effects: EffectLedger = {
    planned: [...(input.effects?.planned ?? [])],
    approved: [...(input.effects?.approved ?? [])],
    applied: [...(input.effects?.applied ?? [])],
  };
  const receipt: CapabilityReceipt = {
    protocol_version: CAPABILITY_PROTOCOL_VERSION,
    invocation_id: input.request.invocation_id,
    attempt: input.request.attempt,
    capability: input.request.capability,
    operation: input.request.operation,
    request_digest: input.request.request_digest,
    semantic_inputs_digest: input.request.semantic_inputs_digest,
    parent_request_digest: input.request.parent_request_digest,
    outcome: input.outcome,
    floor: input.floor,
    selection: [...(input.selection ?? [])],
    inputs: [...input.inputs],
    output: input.output ?? null,
    validations: [...(input.validations ?? [])],
    effects,
    degradations: [...(input.degradations ?? [])],
    gaps: [...(input.gaps ?? [])],
    error: input.error ?? null,
    next_action: input.nextAction,
  };

  const failure = checkReceipt(receipt, input.descriptor);
  return failure === null ? { ok: true, receipt } : { ok: false, failure };
}

/**
 * Every rule a receipt has to survive, each one closing a specific lie: a
 * `completed` with nothing to show, a `failed` that names no error, a
 * `needs_input` that asks for nothing, an input dropped without a reason,
 * applied effects nobody planned, a degradation the contract never declared, or
 * an attribution to an instance that did not contribute.
 *
 * Split into named checks rather than one long function so each rule can be read
 * — and refuted — on its own.
 */
type ReceiptCheck = (
  receipt: CapabilityReceipt,
  descriptor: CapabilityDescriptor,
) => CapabilityFailure | null;

function reject(code: string, message: string, action: string): CapabilityFailure {
  return { code, message, action };
}

function checkNextAction(receipt: CapabilityReceipt): CapabilityFailure | null {
  if (receipt.next_action.trim().length > 0) return null;
  return reject(
    "CAPABILITY_RECEIPT_NO_NEXT_ACTION",
    "el receipt no dice qué hacer después",
    "declará una próxima acción: un receipt sin salida es un callejón",
  );
}

function checkCompleted(receipt: CapabilityReceipt): CapabilityFailure | null {
  if (receipt.outcome !== "completed") return null;
  if (receipt.output === null || receipt.output.completeness === null) {
    return reject(
      "CAPABILITY_COMPLETED_WITHOUT_OUTPUT",
      "un intento 'completed' no trae output con completitud declarada",
      "declará el output y su completitud, o devolvé el outcome que corresponde",
    );
  }
  if (receipt.error !== null) {
    return reject(
      "CAPABILITY_COMPLETED_WITH_ERROR",
      "un intento 'completed' declara un error",
      "un fallo nunca se reporta como éxito: usá 'failed', 'blocked' o 'cancelled'",
    );
  }
  return null;
}

function checkUnfinished(receipt: CapabilityReceipt): CapabilityFailure | null {
  const broke = receipt.outcome === "failed" || receipt.outcome === "blocked";
  if (broke && receipt.error === null) {
    return reject(
      "CAPABILITY_FAILURE_WITHOUT_ERROR",
      `un intento '${receipt.outcome}' no dice qué falló`,
      "declará el error con código, mensaje y acción",
    );
  }
  if (receipt.outcome === "needs_input" && receipt.gaps.length === 0) {
    return reject(
      "CAPABILITY_NEEDS_INPUT_WITHOUT_GAPS",
      "un intento 'needs_input' no enumera qué falta",
      "declará los requisitos que la continuación tiene que traer",
    );
  }
  if (receipt.outcome !== "needs_input" && receipt.gaps.length > 0) {
    return reject(
      "CAPABILITY_GAPS_WITHOUT_NEEDS_INPUT",
      `un intento '${receipt.outcome}' enumera requisitos pendientes`,
      "si falta información el outcome es 'needs_input'",
    );
  }
  return null;
}

function checkInputDispositions(receipt: CapabilityReceipt): CapabilityFailure | null {
  for (const disposition of receipt.inputs) {
    if (disposition.used || (disposition.reason ?? "").trim().length > 0) continue;
    return reject(
      "CAPABILITY_INPUT_DISCARDED_SILENTLY",
      `el input '${disposition.name}' no se usó y el receipt no dice por qué`,
      "declará el motivo: un input ignorado en silencio es una decisión invisible",
    );
  }
  return null;
}

function checkEffectLedger(receipt: CapabilityReceipt): CapabilityFailure | null {
  const planned = new Set(receipt.effects.planned);
  const stages: Array<[readonly EffectClass[], string]> = [
    [receipt.effects.applied, "aplicó"],
    [receipt.effects.approved, "aprobó"],
  ];
  for (const [effects, verb] of stages) {
    for (const effect of effects) {
      if (planned.has(effect)) continue;
      return reject(
        "CAPABILITY_EFFECT_UNPLANNED",
        `se ${verb} un efecto '${effect}' que no estaba planeado`,
        "declará cada efecto antes de ejercerlo",
      );
    }
  }
  return null;
}

function checkDegradations(
  receipt: CapabilityReceipt,
  descriptor: CapabilityDescriptor,
): CapabilityFailure | null {
  const declared = new Set(descriptor.degradations.map((d) => d.cause));
  for (const degradation of receipt.degradations) {
    if (!declared.has(degradation.cause)) {
      return reject(
        "CAPABILITY_DEGRADATION_UNDECLARED",
        `'${degradation.cause}' no está entre las degradaciones que el contrato declara`,
        "agregá la causa al descriptor o reportá el intento como fallido",
      );
    }
    if (degradation.loss.trim().length === 0) {
      return reject(
        "CAPABILITY_DEGRADATION_WITHOUT_LOSS",
        `la degradación '${degradation.cause}' no dice qué se perdió`,
        "declará la pérdida observable",
      );
    }
  }
  return null;
}

/**
 * Running the floor means no improvement contributed. Listing contributors
 * anyway is the invented attribution the contract forbids outright.
 */
function checkAttribution(receipt: CapabilityReceipt): CapabilityFailure | null {
  if (!receipt.floor || receipt.selection.length === 0) return null;
  return reject(
    "CAPABILITY_FLOOR_WITH_SELECTION",
    "el receipt dice que corrió el floor y a la vez atribuye contribuyentes",
    "si corrió el floor, la selección va vacía: no se atribuye lo que no contribuyó",
  );
}

const RECEIPT_CHECKS: readonly ReceiptCheck[] = [
  checkNextAction,
  checkCompleted,
  checkUnfinished,
  checkInputDispositions,
  checkEffectLedger,
  checkDegradations,
  checkAttribution,
];

function checkReceipt(
  receipt: CapabilityReceipt,
  descriptor: CapabilityDescriptor,
): CapabilityFailure | null {
  for (const check of RECEIPT_CHECKS) {
    const failure = check(receipt, descriptor);
    if (failure !== null) return failure;
  }
  return null;
}

/**
 * The completeness gate, as one predicate everybody shares.
 *
 * A gate that demands completeness cannot accept a `partial` output, and the
 * reason is not pedantry: `partial` means the requested profile is not covered,
 * so accepting it would let an incomplete package satisfy the very check that
 * exists to notice incompleteness.
 */
export function satisfiesCompletenessGate(receipt: CapabilityReceipt): boolean {
  return receipt.outcome === "completed" && receipt.output?.completeness === "complete";
}

/** Where this attempt's receipt belongs — proportional to what it did. */
export type ReceiptPersistence = "none" | "registry";

/**
 * Read-only returns and writes nothing. Anything durable or external keeps its
 * receipt in the registry that ALREADY owns that lifecycle — the governance
 * record, the session — rather than growing a second store next to it.
 */
export function receiptPersistence(receipt: CapabilityReceipt): ReceiptPersistence {
  const touchesTheWorld = receipt.effects.applied.some((e) => e !== "read_only");
  const durable = receipt.output?.reference != null;
  return touchesTheWorld || durable ? "registry" : "none";
}

/**
 * The human synthesis — DERIVED, never authored beside the data.
 *
 * Every line reads a field of the receipt it was given. That is the same rule
 * `renderHumanError` already follows for command failures, and it is what makes
 * "the prose cannot contradict the structured form" a property instead of a
 * hope: there is no second source for it to disagree with.
 */
export function renderReceiptHuman(receipt: CapabilityReceipt): string {
  const lines = [
    `${receipt.capability}.${receipt.operation} — ${receipt.outcome} (intento ${receipt.attempt})`,
  ];
  if (receipt.output?.completeness != null) {
    lines.push(`completitud: ${receipt.output.completeness}`);
  }
  if (receipt.output?.reference != null) {
    const ref = receipt.output.reference;
    const revision = ref.revision === null ? "" : `@r${ref.revision}`;
    lines.push(`salida: ${ref.id}${revision} (${ref.digest}) en ${ref.locator}`);
  }
  lines.push(
    receipt.floor
      ? "ejecutó el floor incorporado"
      : `contribuyentes: ${receipt.selection.map((s) => `${s.order}. ${s.name}@${s.digest}`).join(", ") || "ninguno"}`,
  );
  for (const degradation of receipt.degradations) {
    lines.push(`degradación (${degradation.cause}): ${degradation.loss}`);
  }
  for (const validation of receipt.validations) {
    lines.push(`validación ${validation.id}: ${validation.passed ? "ok" : "falla"}`);
  }
  if (receipt.effects.applied.length > 0) {
    lines.push(`efectos aplicados: ${receipt.effects.applied.join(", ")}`);
  }
  for (const gap of receipt.gaps) lines.push(`falta: ${gap}`);
  if (receipt.error !== null) lines.push(`error ${receipt.error.code}: ${receipt.error.message}`);
  lines.push(`siguiente: ${receipt.next_action}`);
  return lines.join("\n");
}
