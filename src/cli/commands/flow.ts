import { WORKLINE_FLOWS } from "../../application/capability/compose.js";
import { isHarnessId } from "../../application/dev-only-services.js";
import { type AdvanceFlowResult, advanceFlow } from "../../application/flow/flow-service.js";
import { type SubmitFlowResult, submitFlow } from "../../application/flow/submit.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import { renderDirectiveHuman } from "../../domain/flow/directive.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId, readRequiredStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail, failSemantic, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

/**
 * The deterministic direction engine, as a public command.
 *
 * Sibling of `aw capability`, and for the same reason: one entry both the agent
 * and a host adapter reach, so neither can re-derive a transition on its own.
 * `advance` applies every consecutive transition the CLI owns and returns the
 * first boundary it does not; `submit` (the second verb) brings an answer, a
 * choice or an approval back and is delivered by the phases that own the
 * boundaries.
 *
 * The directive travels with `ok: true` plus its outcome — with `ok: false` the
 * host never calls `renderHuman`, and a boundary the person cannot see is a
 * boundary that did not happen.
 */

const VERBS = ["advance", "submit"] as const;

export const flowCommand: QtcCommand<FlowDirective> = {
  name: "flow",
  describe: `Avanza un recorrido de Workline hasta su primera frontera no determinista y devuelve su directiva. Verbos: ${VERBS.join(" | ")}. La respuesta de submit entra por stdin como JSON y la aprobación de efecto viaja aparte en --approval. Usage: aw flow advance --session <código> [--flow <flow> --adopt].`,

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<FlowDirective>> {
    const requestedHost = args.values.get("host");
    if (requestedHost !== undefined && !isHarnessId(requestedHost)) {
      return fail(
        "ARGS_INVALID",
        `--host no reconoce '${requestedHost}'; elegí un host del catálogo instalado.`,
      ) as CommandResult<FlowDirective>;
    }
    const verb = args.rest[0];
    if (verb === undefined || !(VERBS as readonly string[]).includes(verb)) {
      return fail(
        "ARGS_INVALID",
        `uso: aw flow ${VERBS.join(" | ")} --session <código> [--flow <flow> --adopt] [--approval <digest>]`,
      ) as CommandResult<FlowDirective>;
    }

    const flow = args.values.get("flow");
    if (flow !== undefined && !(WORKLINE_FLOWS as readonly string[]).includes(flow)) {
      return fail(
        "ARGS_INVALID",
        `--flow no reconoce '${flow}'; los flows son: ${WORKLINE_FLOWS.join(", ")}`,
      ) as CommandResult<FlowDirective>;
    }

    const code = args.values.get("session");
    const contextId = readContextId(ctx.env);
    const session = {
      ...(code !== undefined ? { code } : {}),
      ...(contextId !== undefined ? { contextId } : {}),
    };

    // Only `submit` reads stdin: an `advance` that waited on a pipe would hang a
    // caller that has nothing to send yet — the same split `capability` makes
    // between `prepare` and the stages that carry content.
    if (verb === "submit") {
      const approval = args.values.get("approval");
      return project(
        await submitFlow(ctx.fs, ctx.paths, {
          ...session,
          raw: await readRequiredStdin(),
          approval: approval ?? null,
        }),
      );
    }

    return project(
      await advanceFlow(ctx.fs, ctx.paths, {
        ...session,
        ...(flow !== undefined ? { flow } : {}),
        adopt: args.flags.has("--adopt"),
      }),
    );
  },

  renderHuman(result: CommandResult<FlowDirective>): string {
    // Derived from the same directive the JSON carries — never a second narrative.
    if (result.data === undefined) return "";
    return `${renderDirectiveHuman(result.data)}\n`;
  },
};

function project(result: AdvanceFlowResult | SubmitFlowResult): CommandResult<FlowDirective> {
  if (result.ok) return { ok: true, data: result.directive, exitCode: 0 };
  if ("session" in result)
    return failSessionResolution(result.session) as CommandResult<FlowDirective>;
  return failSemantic(result.failure);
}
