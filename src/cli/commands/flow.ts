import { WORKLINE_FLOWS } from "../../application/capability/compose.js";
import { isHarnessId } from "../../application/dev-only-services.js";
import {
  type AnnulPrepareResult,
  type AnnulPreview,
  applyAnnulment,
  prepareAnnulment,
} from "../../application/flow/annul-service.js";
import { publishObservedCheckouts } from "../../application/flow/checkout-observation.js";
import {
  type AdvanceFlowResult,
  advanceFlow,
  recoverFlowBoundary,
  restartFlow,
  retractFlowSignal,
} from "../../application/flow/flow-service.js";
import {
  type InternalActionExecutor,
  internalActionExecutor,
} from "../../application/flow/internal-actions.js";
import {
  type CheckoutProofReceipt,
  type ProveFlowResult,
  proveFlowBoundary,
} from "../../application/flow/prove.js";
import {
  type ReinferBatchPreview,
  applyReinferBatch,
  previewReinferBatch,
} from "../../application/flow/reinfer-batch.js";
import {
  type FlowCheckReceipt,
  type SubmitFlowResult,
  checkFlow,
  submitFlow,
} from "../../application/flow/submit.js";
import { resolveSessionTarget } from "../../application/session-resolver.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import { renderDirectiveHuman } from "../../domain/flow/directive.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId, readRequiredStdin } from "../context-id.js";
import { type ParsedArgs, flagValue, sessionCodeFlag } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
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
type FlowResult =
  | FlowDirective
  | CheckoutProofReceipt
  | AnnulPreview
  | FlowCheckReceipt
  | ReinferBatchPreview;

const VERBS = ["advance", "submit", "recover", "prove", "restart", "annul", "retract"] as const;

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
  "                  En la validación de fase de plan-exec va un ítem `workline.source-bounded` por CADA fuente del lote, cada uno con su prueba ('aw flow prove --source <alias>'), tomada después de los cambios del lote: sin cambios desde su base, o con una prueba que ya acreditó otro lote, no acredita.",
  "                  effects: {planned[], approved[], applied[]} — el registro de clases de efecto, no una lista.",
  "                  output: opcional — {value, reference: {id, revision, digest, locator}, completeness} o null.",
  "",
  "  semantic        signals[]: solo identificadores del vocabulario que esa frontera declara · decisions: objeto con al menos una clave. Alcanza con uno de los dos.",
  "                  artifacts: [{path, content}] — obligatorio cuando la frontera propone efectos locales, rechazado cuando no propone ninguno.",
  "",
  "  human           choice: la etiqueta literal de una de las alternativas que la directiva emitió.",
  "",
  "  authorization   --approval <digest> se exige sólo en fronteras authorization; el digest está en expects.approval.digest y NO es el state_digest. En semantic, human y execution se ignora --approval. Con `Cerrar` o `Compactar` no se pide aprobación.",
  "  submit --check  lee este mismo sobre y lista sus violaciones sin registrar intento, avanzar ni ejecutar acciones internas.",
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
  "  `WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID`, sin gastar intento. Los errores de tipo, forma,",
  "  literal, digest, invocación, gramática del plan o prueba vencida tampoco gastan. Sólo gasta",
  "  un rechazo que juzga la decisión o afirmación de la respuesta: ejecución inconclusa, evidencia",
  "  que no pasa, alcance o decisión que la frontera no acepta, o respuesta vacía.",
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
      `uso: aw flow ${VERBS.join(" | ")} --session <código> [--flow <flow> --adopt] [--approval <digest>] [--transition <id>] [--source <alias>] [--artifact <ruta>] [--from <lote>]`,
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
  flags: {
    known: ["code", "session", "flow", "host"],
    actions: {
      advance: { known: ["adopt"] },
      submit: { known: ["approval", "check"] },
      prove: { known: ["source", "artifact"] },
      recover: { known: ["transition", "reinfer-batch", "approval"] },
      retract: { known: ["signal"] },
      annul: { known: ["from", "approval"] },
      restart: { known: [] },
    },
  },
  describe: `Avanza un recorrido de Workline hasta su primera frontera no determinista y devuelve su directiva. Verbos: ${VERBS.join(" | ")}. La respuesta de submit entra por stdin como JSON y la aprobación de efecto viaja aparte en --approval. recover le devuelve los intentos a la frontera agotada vigente conservando todo lo aplicado, y se niega si esa frontera ya ejerció efectos. restart saca de cualquier estado trabado —frontera agotada con efectos, registro ilegible o sellado mal, anterior a la v11, contador de intentos ilegible o revertido—: archiva el registro y su contador en un archivo con fecha y sello dentro de la sesión, re-adopta el mismo flow (del registro, de la custodia o de --flow) y lo deja en la traza; nunca hace falta tocar .flow-run.json a mano. annul reabre un lote mal acreditado y los posteriores: sin --approval muestra las fases y tareas que reabre y el digest que lo aprueba, sin escribir nada; con ese digest las deja pendientes y abiertas en el plan, retira su sello done si lo tenía, re-adopta la corrida para que las vuelva a inferir y lo deja en la traza; git no se toca. Usage: aw flow advance --session <código> [--flow <flow> --adopt] · aw flow recover --session <código> [--transition <id>] · aw flow prove --session <código> [--source <alias>] [--artifact <ruta>] · aw flow restart --session <código> [--flow <flow>] · aw flow annul --session <código> --from <lote> [--approval <digest>].

retract retira una señal antes de que se aplique su fila consumidora y deja una traza, sin perdonar intentos: aw flow retract --session <código> --signal <señal>.

recover --reinfer-batch muestra el diff del lote inferido sin escribir; con --approval <digest> re-sella el mismo lote no publicado y obliga a repetir validación y revisión. Uso: aw flow recover --session <código> --reinfer-batch [--approval <digest>].

${ENVELOPE}

${CHECKOUT}`,

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<FlowResult>> {
    const parsed = readFlowArgs(args, ctx);
    if (!parsed.ok) return parsed.failure;
    const { verb, flow, session } = parsed;
    if (verb === "retract") return retractVerb(args, ctx, session);

    // Before the executor, and without stdin: recovery is not a walk. It returns
    // the boundary to an answerable state and stops there, so whatever runs next
    // is decided by whoever answers it — never by the command that unblocked it.
    if (verb === "recover") {
      if (args.flags.has("--reinfer-batch")) {
        if (args.values.has("transition"))
          return fail("ARGS_INVALID", "--reinfer-batch no admite --transition");
        return reinferVerb(args, ctx, session);
      }
      if (args.values.has("approval"))
        return fail("ARGS_INVALID", "--approval en recover exige --reinfer-batch");
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
      const source = flagValue(args, "source");
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

    if (verb === "annul") return annulVerb(args, ctx, session, executor);

    if (verb === "restart") return restartVerb(ctx, session, flow, executor);

    if (verb === "submit") {
      const approval = args.values.get("approval");
      if (args.flags.has("--check"))
        return projectCheck(
          await checkFlow(ctx.fs, ctx.paths, {
            ...session,
            raw: await readRequiredStdin(),
            approval: approval ?? null,
            executor,
            git: ctx.git,
          }),
        );
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

  renderHuman(result: CommandResult<FlowResult>, context: HumanRenderContext): string {
    // Derived from the same payload the JSON carries — never a second narrative.
    if (result.data === undefined) return "";
    const data = result.data;
    if ("check" in data)
      return data.valid
        ? "sobre válido: 0 violaciones\n"
        : `${data.violations.map((item) => `${item.field}: ${item.message}`).join("\n")}\n`;
    if ("proof" in data) return `${renderProofHuman(data)}\n`;
    if ("reinfer_batch" in data)
      return `Lote ${data.batch}: ${data.old_digest} → ${data.new_digest}\n${data.diff}\nDigest de aprobación: ${data.approval_digest}\n${data.next}\n`;
    if ("batches" in data) return `${renderAnnulHuman(data)}\n`;
    return `${renderDirectiveHuman(data, context.detail)}\n`;
  },
};

async function reinferVerb(
  args: ParsedArgs,
  ctx: CliContext,
  session: { code?: string; contextId?: string },
): Promise<CommandResult<FlowResult>> {
  const approval = args.values.get("approval");
  const resolved = await resolveSessionTarget(ctx.fs, ctx.paths, {
    ...session,
    intent: approval === undefined ? "read" : "write",
    allowClosed: false,
  });
  if (resolved.outcome !== "resolved")
    return failSessionResolution(resolved) as CommandResult<FlowResult>;
  const folder = resolved.session.folder;
  if (approval === undefined) {
    const preview = await previewReinferBatch(ctx.fs, ctx.paths, folder);
    return preview.ok
      ? { ok: true, data: preview.preview, exitCode: 0 }
      : failSemantic(preview.failure);
  }
  const applied = await applyReinferBatch(ctx.fs, ctx.paths, folder, approval);
  if (!applied.ok) return failSemantic(applied.failure);
  return {
    ok: true,
    data: await publishObservedCheckouts(ctx.fs, ctx.paths, folder, ctx.git, applied.directive),
    exitCode: 0,
  };
}

function projectCheck(result: Awaited<ReturnType<typeof checkFlow>>): CommandResult<FlowResult> {
  if (result.ok) return { ok: true, data: result.receipt, exitCode: 0 };
  if ("session" in result)
    return failSessionResolution(result.session) as CommandResult<FlowResult>;
  return failSemantic(result.failure);
}

async function retractVerb(
  args: ParsedArgs,
  ctx: CliContext,
  session: { code?: string; contextId?: string },
): Promise<CommandResult<FlowResult>> {
  const signal = flagValue(args, "signal")?.trim();
  if (!signal)
    return fail("ARGS_INVALID", "uso: aw flow retract --session <código> --signal <señal>");
  return project(await retractFlowSignal(ctx.fs, ctx.paths, { ...session, signal, git: ctx.git }));
}

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
    ...receipt.warnings.map((warning) => `aviso: ${warning}`),
    "prevalidada con la misma política que aplica submit: pasa",
    `dónde va: ${receipt.usage}`,
    "",
    JSON.stringify(receipt.proof, null, 2),
  ].join("\n");
}

/** Archive the stuck run and re-adopt its flow; `--flow` only when nothing records it. */
async function restartVerb(
  ctx: CliContext,
  session: { code?: string; contextId?: string },
  flow: string | undefined,
  executor: InternalActionExecutor,
): Promise<CommandResult<FlowResult>> {
  return project(
    await restartFlow(ctx.fs, ctx.paths, {
      ...session,
      ...(flow !== undefined ? { flow } : {}),
      executor,
      git: ctx.git,
    }),
  );
}

/** Preview without `--approval`; apply with the digest that preview showed. */
async function annulVerb(
  args: ParsedArgs,
  ctx: CliContext,
  session: { code?: string; contextId?: string },
  executor: InternalActionExecutor,
): Promise<CommandResult<FlowResult>> {
  const from = args.values.get("from");
  if (from === undefined) {
    return fail(
      "ARGS_INVALID",
      "uso: aw flow annul --session <código> --from <lote> [--approval <digest>]",
    );
  }
  const approval = args.values.get("approval");
  const annul = { ...session, from, env: ctx.env, executor, git: ctx.git };
  if (approval === undefined) return projectAnnul(await prepareAnnulment(ctx.fs, ctx.paths, annul));
  return project(await applyAnnulment(ctx.fs, ctx.paths, { ...annul, approval }));
}

/** An annulment preview, read by a person: what reopens, then how to approve it. */
function renderAnnulHuman(preview: AnnulPreview): string {
  return [
    `anular en ${preview.plan}: ${preview.batches.map((batch) => batch.id).join(", ")}`,
    ...preview.batches.map(
      (batch) =>
        `  ${batch.id}: ${batch.phases.map((phase) => `F${phase}`).join(", ")} vuelven a pendiente · ${batch.kind === "validation-only" ? "validación sin cambios, no reabre tareas" : `reabre ${batch.tasks.join(", ")}`}`,
    ),
    ...(preview.unseals_done ? ["  el plan pierde su sello done"] : []),
    "no se escribió nada y git no se toca",
    `para aplicarlo: ${preview.next}`,
  ].join("\n");
}

function projectAnnul(result: AnnulPrepareResult): CommandResult<FlowResult> {
  if (result.ok) return { ok: true, data: result.preview, exitCode: 0 };
  if ("session" in result)
    return failSessionResolution(result.session) as CommandResult<FlowResult>;
  return failSemantic(result.failure);
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
