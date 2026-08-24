import { WORKLINE_FLOWS } from "../../application/capability/compose.js";
import { isHarnessId } from "../../application/dev-only-services.js";
import {
  type AdvanceFlowResult,
  advanceFlow,
  recoverFlowBoundary,
} from "../../application/flow/flow-service.js";
import { internalActionExecutor } from "../../application/flow/internal-actions.js";
import {
  type CheckoutProofReceipt,
  type ProveFlowResult,
  proveFlowBoundary,
} from "../../application/flow/prove.js";
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

/**
 * What this command can return: a directive, or the receipt of a capture.
 *
 * `prove` is the one verb that does not answer or advance a boundary, so it has
 * nothing to say in the shape of a directive. Pretending otherwise — emitting a
 * directive whose action carried the proof — would make the run look like it had
 * moved when nothing did.
 */
type FlowResult = FlowDirective | CheckoutProofReceipt;

const VERBS = ["advance", "submit", "recover", "prove"] as const;

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

/**
 * How the eligible aliases resolve to real directories on THIS machine.
 *
 * It lives beside the envelope for the same reason the envelope does: the doctrine
 * bundle's context budget is frozen, and this is reference material read when
 * somebody is composing a proof, not on every run.
 *
 * The cost of its absence was measured too. A run on a nested hub was told its
 * checkout "changed" while the tree was provably intact: the digest was correct on
 * both sides, and what differed was the directory each side measured. Two attempts
 * spent that way exhaust a boundary. The rule below is the portable half — the
 * absolute path a directive prints is an observation of one host, and the rule is
 * what makes that path predictable somewhere else.
 */
const CHECKOUT = [
  "Fronteras con evidencia `workline.source-bounded` — contra qué checkout se valida:",
  "",
  "  La directiva imprime `checkout que validará: <alias> → <raíz>`. Esa raíz es una observación",
  "  de ESTE host, no una identidad transferible: no la copies a otra máquina ni a otro sobre.",
  "  Lo portable es la regla que la eligió, y es determinista:",
  "",
  "  workspace       la raíz DOCUMENTAL: se sube desde el directorio del workspace y se para en el",
  "                  PRIMER ancestro que contiene el marcador de Workline. En un hub anidado ese",
  "                  directorio NO es la raíz del repo git, y el digest se calcula sobre él, no sobre",
  "                  el repo. Es el caso que más intentos cuesta, porque `git status` en la raíz git",
  "                  puede estar limpio mientras la huella del subdirectorio es otra.",
  "  otros alias     la unidad de aislamiento de ESTA sesión para ese alias de `AGENTS.md > Fuentes`.",
  "                  Una prueba no puede prestarse el worktree de otra corrida por escribir su alias.",
  "",
  "  Una frontera ausente, ilegible o cuya huella no es reproducible falla CERRADA: no se trata como",
  "  un árbol limpio. El digest caduca con cada escritura al árbol probado, así que el orden es",
  "  correr la invocación sellada → capturar la prueba → hacer el submit, sin tocar el repo en medio",
  "  (el sobre JSON va a un directorio temporal FUERA del checkout probado).",
  "",
  "  No calcules el digest a mano. `aw flow prove --session <código>` produce la prueba COMPLETA que",
  "  el `kind` de la frontera vigente exige, contra la raíz que la directiva publicó, y la prevalida",
  "  con la MISMA política que aplicará el submit: si pasa acá, sólo puede fallar allá porque el árbol",
  "  se movió en el medio. No avanza la frontera, no gasta intento y no escribe en el checkout que mide.",
  "    --source <alias>     qué frontera probar; por defecto `workspace`.",
  "    --artifact <ruta>    produce una prueba `inspection` sobre esa ruta relativa en vez de la",
  "                         prueba `command` de la invocación sellada.",
  "  Devuelve la prueba lista para pegar como campo `proof` del ítem de `validations` que acredita",
  "  esa frontera. Si la raíz no se observa o la huella no es estable, falla cerrada y dice cuál de",
  "  las dos cosas pasó, porque estabilizar y recapturar no son el mismo arreglo.",
  "",
  "  Y conviene usarlo: una prueba cuya forma no coincide con su `kind` vuelve como",
  "  `WORKLINE_CHECKOUT_PROOF_INVALID` — nombrando el kind, los campos esperados y las claves que",
  "  llegaron — y ESO GASTA UN INTENTO de la frontera. `FLOW_RESULT_INVALID` queda para el resultado",
  "  o la lista `validations` que incumplen su propia forma, y no cobra. Capturar con `prove` caza el",
  "  defecto de forma antes del submit, gratis.",
].join("\n");

/**
 * The four refusals every verb shares, answered before any of them runs.
 *
 * Split from `execute` because they are one concern — "is this invocation even
 * addressable?" — and leaving them inline made the dispatch below read as if the
 * validation were part of choosing a verb. Each refusal names the accepted values,
 * so a wrong flag is corrected from the message and not from the source.
 */
function readFlowArgs(
  args: ParsedArgs,
  ctx: CliContext,
):
  | {
      ok: true;
      verb: string;
      flow: string | undefined;
      session: { code?: string; contextId?: string };
    }
  | { ok: false; failure: CommandResult<FlowResult> } {
  const refuse = (message: string) => ({
    ok: false as const,
    failure: fail("ARGS_INVALID", message) as CommandResult<FlowResult>,
  });

  const requestedHost = args.values.get("host");
  if (requestedHost !== undefined && !isHarnessId(requestedHost)) {
    return refuse(`--host no reconoce '${requestedHost}'; elegí un host del catálogo instalado.`);
  }
  const verb = args.rest[0];
  if (verb === undefined || !(VERBS as readonly string[]).includes(verb)) {
    return refuse(
      `uso: aw flow ${VERBS.join(" | ")} --session <código> [--flow <flow> --adopt] [--approval <digest>] [--transition <id>] [--source <alias>] [--artifact <ruta>]`,
    );
  }
  const flow = args.values.get("flow");
  if (flow !== undefined && !(WORKLINE_FLOWS as readonly string[]).includes(flow)) {
    return refuse(`--flow no reconoce '${flow}'; los flows son: ${WORKLINE_FLOWS.join(", ")}`);
  }
  const named = sessionCodeFlag(args);
  if (!named.ok) return refuse(named.message);

  const contextId = readContextId(ctx.env);
  return {
    ok: true,
    verb,
    flow,
    session: {
      ...(named.code !== undefined ? { code: named.code } : {}),
      ...(contextId !== undefined ? { contextId } : {}),
    },
  };
}

export const flowCommand: CliCommand<FlowResult> = {
  name: "flow",
  describe: `Avanza un recorrido de Workline hasta su primera frontera no determinista y devuelve su directiva. Verbos: ${VERBS.join(" | ")}. La respuesta de submit entra por stdin como JSON y la aprobación de efecto viaja aparte en --approval. recover le devuelve los intentos a la frontera agotada vigente conservando todo lo aplicado, y se niega si esa frontera ya ejerció efectos. Usage: aw flow advance --session <código> [--flow <flow> --adopt] · aw flow recover --session <código> [--transition <id>] · aw flow prove --session <código> [--source <alias>] [--artifact <ruta>].

${ENVELOPE}

${CHECKOUT}`,

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<FlowResult>> {
    const parsed = readFlowArgs(args, ctx);
    if (!parsed.ok) return parsed.failure;
    const { verb, flow, session } = parsed;

    // Before the executor, and without stdin: recovery is not a walk. It returns
    // the boundary to an answerable state and stops there, so whatever runs next
    // is decided by whoever answers it — never by the command that unblocked it.
    if (verb === "recover") {
      const transition = args.values.get("transition");
      return project(
        await recoverFlowBoundary(ctx.fs, ctx.paths, {
          ...session,
          git: ctx.git,
          ...(transition !== undefined ? { transition } : {}),
        }),
      );
    }

    // Also before the executor, and for the same reason as `recover`: proving is
    // not a walk. It reads the boundary, captures its proof and stops — nothing is
    // applied, no attempt is spent, and the tree it measures is left untouched.
    if (verb === "prove") {
      const source = args.values.get("source");
      const artifact = args.values.get("artifact");
      return projectProof(
        await proveFlowBoundary(ctx.fs, ctx.paths, {
          ...session,
          ...(source !== undefined ? { source } : {}),
          ...(artifact !== undefined ? { artifact } : {}),
          git: ctx.git,
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
        git: ctx.git,
      }),
    );
  },

  renderHuman(result: CommandResult<FlowResult>): string {
    // Derived from the same payload the JSON carries — never a second narrative.
    if (result.data === undefined) return "";
    const data = result.data;
    if ("proof" in data) return `${renderProofHuman(data)}\n`;
    return `${renderDirectiveHuman(data)}\n`;
  },
};

/**
 * A capture, read by a person: the root it measured first, the bytes to paste last.
 *
 * The root leads because it is the fact the reader could not deduce and the one a
 * wrong answer hinges on. The JSON is emitted whole and unwrapped so it can be
 * copied into the envelope without editing.
 */
function renderProofHuman(receipt: CheckoutProofReceipt): string {
  return [
    `frontera: ${receipt.boundary ?? "recorrido terminado"}`,
    `evidencia exigida: ${receipt.evidence.join(", ")}`,
    `checkout probado (local de esta corrida): ${receipt.checkout.source} → ${receipt.checkout.root}`,
    "prevalidada con la misma política que aplica submit: pasa",
    `dónde va: ${receipt.usage}`,
    "",
    JSON.stringify(receipt.proof, null, 2),
  ].join("\n");
}

function projectProof(result: ProveFlowResult): CommandResult<FlowResult> {
  if (result.ok) return { ok: true, data: result.receipt, exitCode: 0 };
  if ("session" in result)
    return failSessionResolution(result.session) as CommandResult<FlowResult>;
  return failSemantic(result.failure);
}

function project(result: AdvanceFlowResult | SubmitFlowResult): CommandResult<FlowResult> {
  if (result.ok) return { ok: true, data: result.directive, exitCode: 0 };
  if ("session" in result)
    return failSessionResolution(result.session) as CommandResult<FlowResult>;
  return failSemantic(result.failure);
}
