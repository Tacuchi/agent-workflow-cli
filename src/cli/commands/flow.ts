import { WORKLINE_FLOWS } from "../../application/capability/compose.js";
import { isHarnessId } from "../../application/dev-only-services.js";
import {
  type AdvanceFlowResult,
  advanceFlow,
  recoverFlowBoundary,
} from "../../application/flow/flow-service.js";
import { internalActionExecutor } from "../../application/flow/internal-actions.js";
import { type SubmitFlowResult, submitFlow } from "../../application/flow/submit.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import { renderDirectiveHuman } from "../../domain/flow/directive.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId, readRequiredStdin } from "../context-id.js";
import { type ParsedArgs, sessionCodeFlag } from "../parser.js";
import type { CliCommand } from "../registry.js";
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
 * boundaries. `recover` is the third and the only one that is not part of a
 * walk: it gives a boundary that ran out of attempts a way back to being
 * answerable, which until it existed meant editing the run's state by hand.
 *
 * The directive travels with `ok: true` plus its outcome — with `ok: false` the
 * host never calls `renderHuman`, and a boundary the person cannot see is a
 * boundary that did not happen.
 */

const VERBS = ["advance", "submit", "recover"] as const;

/**
 * The answer envelope, published where an executor can read it WITHOUT running a
 * journey.
 *
 * The contract itself lives in `domain/flow/answer.ts` and is enforced there;
 * this is its documentation, and until now it existed nowhere else. The cost of
 * that was measured: one host opened eleven throwaway sessions whose declared
 * objective was to discover this shape, and a second host, independently,
 * repeated its wrong guess. A contract only a failed attempt can teach is a
 * contract that charges every executor the same tuition.
 *
 * Kept beside the command rather than in the doctrine bundle because the bundle's
 * context budget is frozen and this is reference material: it is read when
 * somebody is composing an answer, not on every run.
 */
const ENVELOPE = [
  "Sobre de `submit` — un único objeto JSON por stdin, con sus campos en el NIVEL SUPERIOR:",
  "",
  "  siempre         input_digest: el `state_digest` de la directiva que contestás — la directiva lo rotula `continuidad:` y el sobre lo llama `input_digest`; es el mismo valor.",
  "",
  "  execution       outcome: completed | needs_input | blocked | failed | cancelled",
  "                  invocation: {program, args[], target, input} — el OBJETO idéntico al que la directiva selló; si cambia el programa, un argumento, el target o el input, se rechaza.",
  "                  validations: [{id, passed, detail, proof?}] — un ítem por CADA evidencia que la directiva exige, con `passed: true` y `detail` no vacío: ahí va la salida real de la herramienta, no una afirmación sobre ella.",
  "                  proof es obligatorio para `workline.source-bounded`: {kind: 'command'|'inspection', source, relative_cwd, checkout_digest, invocation}; sólo acredita un checkout vigente.",
  "                  effects: {planned[], approved[], applied[]} — el registro de clases de efecto, no una lista.",
  "                  output: opcional — {value, reference: {id, revision, digest, locator}, completeness} o null.",
  "",
  "  semantic        signals[]: solo identificadores del vocabulario que esa frontera declara · decisions: objeto con al menos una clave. Alcanza con uno de los dos.",
  "                  artifacts: [{path, content}] — obligatorio cuando la frontera propone efectos locales, rechazado cuando no propone ninguno.",
  "",
  "  human           choice: la etiqueta literal de una de las alternativas que la directiva emitió.",
  "",
  "  authorization   --approval <digest> con el digest que la directiva nombra en `siguiente:` — NO es el state_digest · choice: opcional, y con `Cerrar` o `Compactar` no se pide aprobación.",
].join("\n");

export const flowCommand: CliCommand<FlowDirective> = {
  name: "flow",
  describe: `Avanza un recorrido de Workline hasta su primera frontera no determinista y devuelve su directiva. Verbos: ${VERBS.join(" | ")}. La respuesta de submit entra por stdin como JSON y la aprobación de efecto viaja aparte en --approval. recover le devuelve los intentos a la frontera agotada vigente conservando todo lo aplicado, y se niega si esa frontera ya ejerció efectos. Usage: aw flow advance --session <código> [--flow <flow> --adopt] · aw flow recover --session <código> [--transition <id>].

${ENVELOPE}`,

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
        `uso: aw flow ${VERBS.join(" | ")} --session <código> [--flow <flow> --adopt] [--approval <digest>] [--transition <id>]`,
      ) as CommandResult<FlowDirective>;
    }

    const flow = args.values.get("flow");
    if (flow !== undefined && !(WORKLINE_FLOWS as readonly string[]).includes(flow)) {
      return fail(
        "ARGS_INVALID",
        `--flow no reconoce '${flow}'; los flows son: ${WORKLINE_FLOWS.join(", ")}`,
      ) as CommandResult<FlowDirective>;
    }

    const named = sessionCodeFlag(args);
    if (!named.ok) {
      return fail("ARGS_INVALID", named.message) as CommandResult<FlowDirective>;
    }
    const contextId = readContextId(ctx.env);
    const session = {
      ...(named.code !== undefined ? { code: named.code } : {}),
      ...(contextId !== undefined ? { contextId } : {}),
    };

    // Before the executor, and without stdin: recovery is not a walk. It returns
    // the boundary to an answerable state and stops there, so whatever runs next
    // is decided by whoever answers it — never by the command that unblocked it.
    if (verb === "recover") {
      const transition = args.values.get("transition");
      return project(
        await recoverFlowBoundary(ctx.fs, ctx.paths, {
          ...session,
          ...(transition !== undefined ? { transition } : {}),
        }),
      );
    }

    // Only `submit` reads stdin: an `advance` that waited on a pipe would hang a
    // caller that has nothing to send yet — the same split `capability` makes
    // between `prepare` and the stages that carry content.
    // Built from the live context and handed to BOTH verbs: an internal action is
    // internal wherever the run happens to be standing, and giving only `advance`
    // an executor would make the same step deterministic or delegated depending on
    // which verb reached it.
    const executor = internalActionExecutor({
      fs: ctx.fs,
      env: ctx.env,
      paths: ctx.paths,
      git: ctx.git,
      runtime: ctx.runtime,
    });

    if (verb === "submit") {
      const approval = args.values.get("approval");
      return project(
        await submitFlow(ctx.fs, ctx.paths, {
          ...session,
          raw: await readRequiredStdin(),
          approval: approval ?? null,
          executor,
          git: ctx.git,
        }),
      );
    }

    return project(
      await advanceFlow(ctx.fs, ctx.paths, {
        ...session,
        ...(flow !== undefined ? { flow } : {}),
        adopt: args.flags.has("--adopt"),
        executor,
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
