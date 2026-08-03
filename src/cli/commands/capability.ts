import {
  type CapabilityAttempt,
  type CapabilityVerb,
  type DispatchInput,
  dispatchCapability,
  registeredCapabilities,
} from "../../application/capability/dispatcher.js";
// Side-effect import: registering the floor is what makes `design` dispatchable.
// Without it the registry is empty and every invocation answers CAPABILITY_UNKNOWN.
import "../../application/capability/design-handler.js";
import type { DurableEffectPlan } from "../../application/capability/durable-effect.js";
import { runHarness } from "../../application/dev-only-services.js";
import type { CapabilityInputValue } from "../../domain/capability/protocol.js";
import { renderReceiptHuman } from "../../domain/capability/protocol.js";
import type { CapabilityRequest } from "../../domain/capability/protocol.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail, failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

/**
 * The shared entry both routes go through.
 *
 * The direct wrapper's `SKILL.md` calls this, and so does a composing flow. That
 * is the mechanism — not a convention — behind "the two routes share a
 * contract": there is one dispatcher and neither caller can reach the handlers
 * without it.
 *
 * The four verbs are stages, never operations. `--operation` carries the
 * operation, and a capability with a sixth one adds it to its descriptor
 * without touching this file.
 */

const VERBS: readonly CapabilityVerb[] = ["prepare", "continue", "validate", "apply"];

export const capabilityCommand: QtcCommand<CapabilityAttempt> = {
  name: "capability",
  describe:
    "Invoca una capacidad conformante por su contrato: prepare | continue | validate | apply. " +
    "La operación viaja en --operation y cada intento devuelve envelope, output y receipt. " +
    "Usage: aw capability prepare --capability design --operation validate --input package=DES-001.",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<CapabilityAttempt>> {
    const verb = args.rest[0] as CapabilityVerb | undefined;
    if (verb === undefined || !VERBS.includes(verb)) {
      return fail(
        "ARGS_INVALID",
        `uso: aw capability ${VERBS.join(" | ")} --capability <nombre> --operation <op>`,
      ) as CommandResult<CapabilityAttempt>;
    }

    const capability = args.values.get("capability") ?? args.valuesMulti.get("capability")?.[0];
    if (capability === undefined) {
      return fail(
        "ARGS_INVALID",
        `falta --capability; registradas: ${registeredCapabilities().join(", ") || "(ninguna)"}`,
      ) as CommandResult<CapabilityAttempt>;
    }

    const inputs = parseInputs(args);
    if (!inputs.ok) return fail("ARGS_INVALID", inputs.why) as CommandResult<CapabilityAttempt>;

    // Only the two stages that carry authored content or an approval read stdin.
    // A `prepare` that waited on a pipe would hang a wrapper that has nothing to
    // send yet.
    const raw = verb === "prepare" ? "" : await readRequiredStdin();
    const carried = parseCarried(raw, verb);
    if (!carried.ok) return fail("ARGS_INVALID", carried.why) as CommandResult<CapabilityAttempt>;

    const result = await dispatchCapability(
      dispatchInputFrom(args, verb, capability, inputs.values, carried),
      {
        fs: ctx.fs,
        env: ctx.env,
        paths: ctx.paths,
        workspace: ctx.paths.workspaceDir(),
        host: runHarness((k) => ctx.env.get(k)).harness,
      },
    );

    if (!result.ok) return failSemantic(result.failure);
    return { ok: true, data: result.attempt, exitCode: 0 };
  },

  renderHuman(result: CommandResult<CapabilityAttempt>): string {
    // Derived from the same receipt the JSON carries — never a second narrative.
    if (result.data === undefined) return "";
    return `${renderReceiptHuman(result.data.receipt)}\n`;
  },
};

/**
 * Assemble the dispatch input from flags and whatever the previous stage
 * carried. Kept apart from `execute` so the command body stays about the two
 * things it owns: reading the stage and reporting the attempt.
 */
function dispatchInputFrom(
  args: ParsedArgs,
  verb: CapabilityVerb,
  capability: string,
  inputs: CapabilityInputValue[],
  carried: Carried,
): DispatchInput {
  const operation = args.values.get("operation");
  const approval = args.values.get("approval");
  const flow = args.values.get("flow");
  return {
    verb,
    capability,
    ...(operation !== undefined ? { operation } : {}),
    route: flow === undefined ? "direct" : "compose",
    flow: flow ?? null,
    inputs,
    target: args.values.get("target") ?? null,
    base: args.values.get("base") ?? null,
    profile: args.values.get("profile") ?? null,
    sensitiveSources: args.flags.has("--sensitive-sources"),
    parent: carried.parent,
    request: carried.request,
    plan: carried.plan,
    ...(approval !== undefined
      ? { approval: { digest: approval, granted: carried.plan?.requires_approval ?? [] } }
      : {}),
    answer: carried.answer,
  };
}

interface ParsedInputs {
  ok: true;
  values: CapabilityInputValue[];
}

/**
 * `--input name=value`, repeatable. Provenance is `caller` because that is the
 * truth: a value typed on a command line came from whoever typed it, and
 * claiming a locator or a digest for it would be a verifiability nobody has.
 */
function parseInputs(args: ParsedArgs): ParsedInputs | { ok: false; why: string } {
  const raw = args.valuesMulti.get("input") ?? [];
  const single = args.values.get("input");
  const all = single === undefined ? raw : [...raw, single];
  const values: CapabilityInputValue[] = [];
  for (const entry of all) {
    const eq = entry.indexOf("=");
    if (eq <= 0) return { ok: false, why: `--input espera 'nombre=valor', llegó '${entry}'` };
    values.push({
      name: entry.slice(0, eq),
      value: entry.slice(eq + 1),
      provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
    });
  }
  return { ok: true, values };
}

interface Carried {
  ok: true;
  parent: CapabilityRequest | null;
  request: CapabilityRequest | null;
  plan: DurableEffectPlan | null;
  answer: string | null;
}

/**
 * What a stage receives from the previous one, by stdin.
 *
 * `continue` needs the attempt it answers; `validate` needs the request plus the
 * authored answer; `apply` needs the request and the plan. Carrying them instead
 * of rebuilding is what makes the chain verifiable: the parent's digest is
 * re-sealed before it is trusted.
 */
function parseCarried(raw: string, verb: CapabilityVerb): Carried | { ok: false; why: string } {
  const empty: Carried = { ok: true, parent: null, request: null, plan: null, answer: null };
  if (raw.trim().length === 0) {
    if (verb === "prepare") return empty;
    return { ok: false, why: `'${verb}' lee por stdin el estado del intento anterior` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, why: "lo que llegó por stdin no es un único objeto JSON" };
  }
  return {
    ok: true,
    parent: (parsed.parent ?? null) as CapabilityRequest | null,
    request: (parsed.request ?? null) as CapabilityRequest | null,
    plan: (parsed.plan ?? null) as DurableEffectPlan | null,
    answer: parsed.answer === undefined ? null : JSON.stringify(parsed.answer),
  };
}
