/**
 * The one road into a capability — for the direct wrapper and for a flow alike.
 *
 * Everything a caller can influence goes through here: the envelope is built by
 * the shared builder, the capability is resolved against real instances, the
 * effects are authorized before anything runs, and the attempt comes back as
 * outcome + output + receipt. Neither route can take a shortcut around it
 * without the difference showing up in a digest, which is what makes
 * "the two routes share a contract" a checkable property.
 *
 * The four verbs are STAGES of the adapter, not a second operation table. The
 * operation (`create`, `validate`, …) travels in the envelope; `prepare`,
 * `continue`, `validate` and `apply` say where in the durable handshake the
 * attempt is. A capability with a sixth operation adds it to its descriptor; it
 * never adds a verb here.
 *
 * Handlers register themselves by capability NAME in a registry. That is the
 * mechanism behind "no branches by name": adding a capability means adding a
 * descriptor and a handler, and nothing in SPEC, PLAN or QUICK changes.
 */

import {
  type CapabilityDescriptor,
  type CapabilityOperation,
  findOperation,
} from "../../domain/capability/descriptor.js";
import { authorizeEffects } from "../../domain/capability/effects.js";
import type {
  EffectAuthorizationResult,
  EffectClass,
  EffectPolicy,
} from "../../domain/capability/effects.js";
import {
  type CapabilityFailure,
  type CapabilityInputValue,
  type CapabilityReceipt,
  type CapabilityRequest,
  type CapabilityRoute,
  type InputDisposition,
  type OperationOutput,
  type ValidationOutcome,
  buildCapabilityRequest,
  buildReceipt,
  checkWorkspaceRequirement,
  continueInvocation,
  newInvocationId,
  receiptPersistence,
} from "../../domain/capability/protocol.js";
import type { ProposalBase } from "../../domain/proposal.js";
import { RETIRED_SKILL_IDENTITIES, classifyCapabilityBinding } from "../../domain/skills.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { applyLocalProposal, reconcileAfterFailure } from "../local-proposal.js";
import type { ProposalApproval } from "../local-proposal.js";
import type { PathsService } from "../paths-service.js";
import type { PublishableArtifact } from "../semantic-operation/publish.js";
import { resolveSkills } from "../skills-resolver-service.js";
import { type DurableEffectPlan, prepareDurableEffect } from "./durable-effect.js";
import { buildCapabilityInventory } from "./installed-inventory.js";
import {
  type CapabilityResolution,
  type HostSelection,
  type SelectionPin,
  checkPin,
  pinSelection,
  resolveCapability,
} from "./resolution.js";

export type CapabilityVerb = "prepare" | "continue" | "validate" | "apply";

export interface DispatchContext {
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
  /** Absolute workspace root, or null when the caller is not inside one. */
  workspace: string | null;
  host: string;
  /** The host's own effect policy. Always at least as strict as the descriptor. */
  effectPolicy?: EffectPolicy;
}

export interface HandlerContext extends DispatchContext {
  verb: CapabilityVerb;
  request: CapabilityRequest;
  operation: CapabilityOperation;
  /** The authored answer, on the `validate` stage of an authoring operation. */
  answer: string | null;
}

export type HandlerResult =
  | { kind: "completed"; output: OperationOutput; validations?: ValidationOutcome[] }
  | { kind: "needs_input"; gaps: string[] }
  | { kind: "blocked"; failure: CapabilityFailure }
  | {
      kind: "durable";
      artifacts: PublishableArtifact[];
      output: OperationOutput;
      /** Every document the candidate was computed from, re-checked at apply. */
      bases?: ProposalBase[];
    };

export interface CapabilityHandler {
  descriptor: CapabilityDescriptor;
  run(ctx: HandlerContext): Promise<HandlerResult>;
}

const HANDLERS = new Map<string, CapabilityHandler>();

export function registerCapability(handler: CapabilityHandler): void {
  HANDLERS.set(handler.descriptor.name, handler);
}

export function capabilityHandler(name: string): CapabilityHandler | null {
  return HANDLERS.get(name) ?? null;
}

export function registeredCapabilities(): string[] {
  return [...HANDLERS.keys()].sort();
}

export interface CapabilityAttempt {
  request: CapabilityRequest;
  receipt: CapabilityReceipt;
  output: OperationOutput | null;
  resolution: CapabilityResolution;
  /**
   * What this attempt resolved to, sealed. The caller carries it into the next
   * attempt so a skill that changes mid-conversation is caught instead of
   * silently answering the second half of a question the first half never asked.
   */
  pin: SelectionPin;
  /** Where this attempt's receipt belongs — `none` for a read-only return. */
  persistence: ReturnType<typeof receiptPersistence>;
  /** Present when the attempt produced something durable awaiting approval. */
  plan: DurableEffectPlan | null;
}

export type DispatchResult =
  | { ok: true; attempt: CapabilityAttempt }
  | { ok: false; failure: CapabilityFailure };

export interface DispatchInput {
  verb: CapabilityVerb;
  capability: string;
  operation?: string;
  route: CapabilityRoute;
  /** The composing flow, or null on the direct route. */
  flow?: string | null;
  inputs?: CapabilityInputValue[];
  target?: string | null;
  base?: string | null;
  profile?: string | null;
  sensitiveSources?: boolean;
  externalTransmission?: boolean;
  hostSelection?: HostSelection | null;
  /** `continue` only: the attempt being answered. */
  parent?: CapabilityRequest | null;
  /** `validate` only: the authored answer. */
  answer?: string | null;
  /** `apply` only. */
  plan?: DurableEffectPlan | null;
  approval?: ProposalApproval | null;
  /** `apply`/`validate` only: the request the plan belongs to. */
  request?: CapabilityRequest | null;
  /** `continue` only: the pin the previous attempt was resolved under. */
  pin?: SelectionPin | null;
}

export async function dispatchCapability(
  input: DispatchInput,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const retired = RETIRED_SKILL_IDENTITIES.get(input.capability.toLowerCase());
  if (retired !== undefined) {
    // Not an alias, and not a silent fallback to the live name either: honoring
    // it here would make the retired name an accepted one.
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_NAME_RETIRED",
        message: `'${input.capability}' está retirado — ${retired}`,
        action: "invocá la capacidad por su nombre vigente: 'design'",
      },
    };
  }

  const handler = capabilityHandler(input.capability);
  if (handler === null) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_UNKNOWN",
        message: `no hay ninguna capacidad registrada con el nombre '${input.capability}'`,
        action: `usá una de: ${registeredCapabilities().join(", ") || "(ninguna)"}`,
      },
    };
  }

  if (input.verb === "apply") return applyStage(input, ctx, handler);
  return attemptStage(input, ctx, handler);
}

async function attemptStage(
  input: DispatchInput,
  ctx: DispatchContext,
  handler: CapabilityHandler,
): Promise<DispatchResult> {
  const { descriptor } = handler;
  const resolved = await resolveFor(input, ctx, descriptor);

  const operationName = input.operation ?? input.parent?.operation ?? descriptor.default_operation;
  if (operationName === null || operationName === undefined) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_OPERATION_MISSING",
        message: `'${descriptor.name}' no declara operación por defecto`,
        action: `nombrá la operación: ${descriptor.operations.map((o) => o.name).join(", ")}`,
      },
    };
  }

  const built = buildFor(input, ctx, descriptor, operationName);
  if (!built.ok) return { ok: false, failure: built.failure };
  const { request, operation } = built;

  // A continuation runs against the selection the FIRST attempt fixed. If those
  // bytes moved, the conversation is answering something that no longer exists.
  if (input.pin != null) {
    const stillThere = checkPin(
      input.pin,
      await buildCapabilityInventory(ctx.fs, ctx.env, ctx.paths.workspaceDir()),
    );
    if (!stillThere.ok) {
      return receiptOf(request, descriptor, resolved, {
        kind: "blocked",
        failure: {
          code: "CAPABILITY_SELECTION_CHANGED",
          message: stillThere.degradation.loss,
          action: stillThere.action,
        },
      });
    }
  }

  const blocked = blockedByResolution(resolved, operation);
  if (blocked !== null) {
    return receiptOf(request, descriptor, resolved, {
      kind: "blocked",
      failure: blocked,
    });
  }

  const workspace = checkWorkspaceRequirement(operation, request.context);
  if (!workspace.ok) {
    return receiptOf(request, descriptor, resolved, {
      kind: "blocked",
      failure: workspace.failure,
    });
  }

  const authorization = authorizeEffects(
    operation.effects,
    {
      sensitiveSources: input.sensitiveSources === true,
      scopeExpanded: false,
    },
    ctx.effectPolicy,
  );

  const result = await handler.run({
    ...ctx,
    verb: input.verb,
    request,
    operation,
    answer: input.answer ?? null,
  });

  if (result.kind !== "durable") return receiptOf(request, descriptor, resolved, result);

  const prepared = prepareDurableEffect({
    request,
    authorization,
    artifacts: result.artifacts,
    bases: result.bases ?? [],
  });
  if (!prepared.ok) {
    return receiptOf(request, descriptor, resolved, {
      kind: "blocked",
      failure: prepared.failure,
    });
  }
  // A durable candidate is not an applied one. The attempt stops here with the
  // preview and the seal, and `apply` is a separate, authorized step.
  //
  // The gap NAMES the two alternatives instead of describing an authorization.
  // This is the one human boundary of the whole route, and what a person decides
  // is not "which effect classes do I grant" — it is whether this preview gets
  // saved. The classes still travel in the proposal, where the grant reads them.
  const preview = prepared.plan.proposal.preview
    .map((e) => `${e.path} (${e.bytes} B${e.overwrite ? ", reemplaza" : ""})`)
    .join(" · ");
  return receiptOf(
    request,
    descriptor,
    resolved,
    {
      kind: "needs_input",
      gaps: [
        `vista previa: ${preview}`,
        "Aprobar y guardar — se escriben exactamente esos archivos y no se vuelve a preguntar por esos efectos",
        "Refinar — no se escribe nada y la propuesta se vuelve a redactar",
      ],
    },
    { plan: prepared.plan, output: result.output, authorization },
  );
}

async function applyStage(
  input: DispatchInput,
  ctx: DispatchContext,
  handler: CapabilityHandler,
): Promise<DispatchResult> {
  const { descriptor } = handler;
  if (input.plan == null || input.approval == null || input.request == null) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_APPLY_INCOMPLETE",
        message: "apply necesita el plan, su request y la aprobación",
        action: "pasá el plan que devolvió validate junto con el digest aprobado",
      },
    };
  }
  if (ctx.workspace === null) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_WORKSPACE_REQUIRED",
        message: "aplicar un efecto durable necesita un workspace",
        action: "corré apply dentro del workspace donde se preparó la propuesta",
      },
    };
  }

  const resolved = await resolveFor(input, ctx, descriptor);
  const operation = findOperation(descriptor, input.request.operation) as CapabilityOperation;
  const authorization = authorizeEffects(
    operation.effects,
    { sensitiveSources: input.sensitiveSources === true, scopeExpanded: false },
    ctx.effectPolicy,
  );

  const applied = await applyLocalProposal(ctx.fs, ctx.paths, {
    root: ctx.workspace,
    proposal: input.plan.proposal,
    approval: input.approval,
    selfAuthorized: authorization.selfAuthorized,
  });
  if (!applied.ok) {
    // Whatever landed is enumerated with the failure, and the next action is a
    // reconciliation — never a shrug that reads as "nothing happened".
    const reconciliation = reconcileAfterFailure(
      "failed",
      applied.applied.map((cls: EffectClass) => ({
        class: cls,
        what: `efecto '${cls}' ya aplicado`,
      })),
    );
    return receiptOf(
      input.request,
      descriptor,
      resolved,
      { kind: "blocked", failure: { ...applied.failure, action: reconciliation.next_action } },
      { applied: reconciliation.applied, authorization },
    );
  }

  return receiptOf(
    input.request,
    descriptor,
    resolved,
    {
      kind: "completed",
      output: {
        value: { written: applied.result.written },
        reference: null,
        completeness: "complete",
      },
    },
    { applied: applied.result.applied, authorization },
  );
}

async function resolveFor(
  input: DispatchInput,
  ctx: DispatchContext,
  descriptor: CapabilityDescriptor,
): Promise<CapabilityResolution> {
  const skills = await resolveSkills(ctx.fs, ctx.paths);
  const slot = skills.skills[descriptor.name as keyof typeof skills.skills];
  const binding =
    slot === undefined
      ? { state: "floor_and_improvements" as const, reason: null, action: null }
      : classifyCapabilityBinding(slot, descriptor.name);
  const inventory = await buildCapabilityInventory(ctx.fs, ctx.env, ctx.paths.workspaceDir());
  return resolveCapability({
    descriptor,
    binding,
    inventory,
    hostSelection: input.hostSelection ?? null,
    operation: input.operation ?? input.parent?.operation ?? null,
  });
}

function blockedByResolution(
  resolved: CapabilityResolution,
  operation: CapabilityOperation,
): CapabilityFailure | null {
  const availability = resolved.operations.find((o) => o.operation === operation.name);
  if (availability === undefined || availability.available) return null;
  return {
    code: resolved.state === "disabled" ? "CAPABILITY_OPERATION_OFF" : "CAPABILITY_UNAVAILABLE",
    message: availability.reason ?? `'${operation.name}' no está disponible`,
    action: resolved.action ?? "revisá 'aw skills --detail' para ver el estado de la capacidad",
  };
}

interface BuildOk {
  ok: true;
  request: CapabilityRequest;
  operation: CapabilityOperation;
}

function buildFor(
  input: DispatchInput,
  ctx: DispatchContext,
  descriptor: CapabilityDescriptor,
  operationName: string,
): BuildOk | { ok: false; failure: CapabilityFailure } {
  const caller = { route: input.route, host: ctx.host, flow: input.flow ?? null };
  const context = {
    workspace: ctx.workspace,
    target: input.target ?? null,
    base: input.base ?? null,
    profile: input.profile ?? null,
  };
  const policy = {
    sensitive_sources: input.sensitiveSources === true,
    external_transmission: input.externalTransmission === true,
  };

  const built =
    input.verb === "continue" && input.parent != null
      ? continueInvocation({
          parent: input.parent,
          descriptor,
          inputs: input.inputs ?? [],
          caller,
          context,
          policy,
          authorizations: [],
        })
      : buildCapabilityRequest({
          invocationId: input.parent?.invocation_id ?? newInvocationId(),
          attempt: 1,
          descriptor,
          operation: operationName,
          caller,
          context,
          inputs: input.inputs ?? [],
          policy,
          authorizations: [],
          parentRequestDigest: null,
        });

  if (!built.ok) return { ok: false, failure: built.failure };
  return { ok: true, request: built.request, operation: built.operation };
}

interface ReceiptExtras {
  plan?: DurableEffectPlan;
  output?: OperationOutput;
  applied?: string[];
  authorization?: EffectAuthorizationResult;
}

function receiptOf(
  request: CapabilityRequest,
  descriptor: CapabilityDescriptor,
  resolution: CapabilityResolution,
  result: HandlerResult,
  extras: ReceiptExtras = {},
): DispatchResult {
  const dispositions: InputDisposition[] = request.inputs.map((i) => ({
    name: i.name,
    used: true,
    reason: null,
    provenance: i.provenance,
  }));
  const output = result.kind === "completed" ? result.output : (extras.output ?? null);

  const built = buildReceipt({
    request,
    descriptor,
    outcome: result.kind === "durable" ? "completed" : result.kind,
    floor: resolution.floor,
    selection: resolution.selection,
    inputs: dispositions,
    output,
    validations: result.kind === "completed" ? (result.validations ?? []) : [],
    effects: {
      planned: [...(extras.authorization?.planned ?? [])],
      approved: [...(extras.authorization?.needsPreflight ?? [])].filter((c) =>
        (extras.applied ?? []).includes(c),
      ),
      applied: [...(extras.applied ?? [])] as EffectAuthorizationResult["planned"],
    },
    degradations: resolution.degradations,
    gaps: result.kind === "needs_input" ? result.gaps : [],
    error: result.kind === "blocked" ? result.failure : null,
    nextAction: nextAction(result, resolution),
  });
  if (!built.ok) return { ok: false, failure: built.failure };

  return {
    ok: true,
    attempt: {
      request,
      receipt: built.receipt,
      output,
      resolution,
      pin: pinSelection(resolution, descriptor),
      persistence: receiptPersistence(built.receipt),
      plan: extras.plan ?? null,
    },
  };
}

function nextAction(result: HandlerResult, resolution: CapabilityResolution): string {
  if (result.kind === "needs_input") {
    return "contestá con 'aw capability continue'; si ya hay vista previa, elegí 'Aprobar y guardar' (corré 'apply' con su digest) o 'Refinar' (no corras nada y redactá de nuevo)";
  }
  if (result.kind === "blocked") return result.failure.action;
  if (result.kind === "durable") return "revisá la propuesta y aprobala para aplicarla";
  return resolution.degradations.length > 0
    ? "el resultado salió del floor: revisá la degradación del receipt"
    : "nada pendiente: el intento se completó";
}
