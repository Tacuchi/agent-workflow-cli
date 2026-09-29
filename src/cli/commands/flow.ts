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
import { runWorkspaceCommit } from "../../application/workspace-commit-service.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import { renderDirectiveHuman } from "../../domain/flow/directive.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId, readRequiredStdin } from "../context-id.js";
import { usageLine } from "../help-groups.js";
import { type ParsedArgs, flagValue, sessionCodeFlag } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { failSemantic, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

/**
 * The deterministic direction engine, as a public command.
 *
 * One entry both the agent and a host adapter reach, so neither can re-derive
 * a transition on its own.
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
const ENVELOPE_NOTES = [
  "Minimal answer: {transition, ...your judgment} plus, at an execution boundary, outcome and detail (the real output). The CLI fills what it knows before judging: input_digest, the sealed invocation, the effects, the id of the single evidence the row demands, and one checkout proof per eligible source captured in the submit itself (expects.proofs_captured); an `artifact` field makes it an inspection proof. Any field you send instead is judged as sent. A resent answer whose transition is no longer in force is refused as stale.",
  "Documents by path: at a save-proposal boundary send artifacts [{path, draft}] where draft is relative to the session folder and stays inside it; the CLI reads the bytes and seals `status: ready-for-plan` (spec) or `> Estado: open` (plan) in the proposal. Inline {path, content} still works and seals the same digest.",
  "Submit envelope: one JSON object on stdin, fields at the TOP level. Always: input_digest, the `state_digest` of the directive being answered; it is the same value, and the human directive labels it `continuidad:`.",
  "execution boundary: outcome (completed | needs_input | blocked | failed | cancelled); invocation {program, args[], target, input}, the exact object the directive sealed (any change to program, an argument, target or input is rejected); validations [{id, passed, detail, proof?}], one item per evidence the directive demands, with passed: true and a non-empty detail carrying the real tool output, not a claim about it; effects {planned[], approved[], applied[]}, the effect-class ledger, not a list; output, optional: {value, reference: {id, revision, digest, locator}, completeness} or null.",
  "proof is mandatory for `workline.source-bounded`: {kind: 'command'|'inspection', source, relative_cwd, checkout_digest, invocation}; it only credits a current checkout. In the plan-exec phase validation, send one `workline.source-bounded` item per source of the batch, each with its own proof (`aw flow prove --source <alias>`) taken after the batch changes: a source unchanged since its base, or a proof another batch already credited, does not credit. Which checkout each source resolves to: see `aw flow prove --help`.",
  "semantic boundary: signals[] (only ids from the vocabulary that boundary declares) and/or decisions (an object with at least one key); one of the two suffices. artifacts [{path, content}] is mandatory when the boundary proposes local effects and rejected when it proposes none.",
  "human boundary: choice, the literal label of one of the choices the directive emitted.",
  "authorization boundary: --approval <digest> is required only here; the digest is expects.approval.digest and is NOT the state_digest. semantic, human and execution boundaries ignore --approval. The close and compact choices need no approval.",
  "At the workspace commit gate the directive carries workspace_commit_preview; to approve it include decisions.commit_approval with that preview's approval digest.",
] as const;

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
const CHECKOUT_NOTES = [
  "Which checkout a `workline.source-bounded` evidence is validated against: the directive prints the checkout it will validate (alias and root). That root is an observation of THIS host, not a transferable identity: never copy it to another machine or envelope. The rule that chose it is portable and deterministic.",
  "workspace alias: the DOCUMENT root, found by walking up from the workspace directory to the FIRST ancestor holding the Workline marker. In a nested hub that directory is NOT the git repo root and the digest is computed over it, not over the repo; `git status` at the git root can be clean while the subdirectory fingerprint differs. Other aliases: this session's isolation unit for that alias of the AGENTS.md sources table; a proof cannot borrow another run's worktree by naming its alias.",
  "A boundary that is absent, unreadable or whose fingerprint is not reproducible fails CLOSED; it is never treated as a clean tree. The digest expires with every write to the proven tree, so the order is: run the sealed invocation, capture the proof, submit, without touching the repo in between (write the JSON envelope to a temporary directory OUTSIDE the proven checkout).",
] as const;

const PROVE_NOTES = [
  "Never compute the digest by hand. prove builds the COMPLETE proof the current boundary kind demands, against the root the directive published, and prevalidates it with the SAME policy submit applies: if it passes here it can only fail there because the tree moved. It does not advance the boundary, spends no attempt and never writes to the checkout it measures.",
  "The result's proof is ready to paste as the `proof` field of the validations item that credits that boundary. If the root cannot be observed or the fingerprint is unstable it fails closed and says which, because stabilizing and recapturing are different fixes.",
  ...CHECKOUT_NOTES,
] as const;

const ATTEMPT_NOTES = [
  "Attempts: a proof whose shape does not match its kind returns WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID without spending an attempt. Type, shape, literal, digest, invocation, plan grammar and expired-proof errors spend none either. Only a rejection that judges the answer's decision or claim spends one: inconclusive execution, failing evidence, a scope or decision the boundary does not accept, or an empty answer.",
] as const;

/**
 * The four refusals every verb shares, answered before any of them runs.
 *
 * Split from `execute` because they are one concern — "is this invocation even
 * addressable?" — and leaving them inline made the dispatch below read as if the
 * validation were part of choosing a verb. Each refusal names the accepted values,
 * so a wrong flag is corrected from the message and not from the source.
 */
/** The error action of a malformed flow invocation: its usage, generated from its contract. */
function usageAction(verb: string | undefined): { action: string } {
  return { action: `uso: \`${usageLine(flowCommand, verb)}\`` };
}

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
    failure: failSemantic<FlowResult>({
      code: "ARGS_INVALID",
      message,
      ...usageAction(args.rest[0]),
    }),
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

const DIRECTIVE_OUTPUT =
  "The directive: {version, flow, tranche, session, boundary {transition, kind, ...}, outcome, state_digest, applied[], pending[], request, action, choices[], proposal, decision_preview, fix_preview, route, effects, expects {effects[], approval {required, digest}, decisions, note, source_scope}, authorizations[], degradations[], error, attempt_accounting, next_action}. request is set only at a semantic boundary, action only at an execution one, choices only at human or authorization ones.";

export const flowCommand: CliCommand<FlowResult> = {
  name: "flow",
  flags: {
    known: ["code", "session", "flow", "host"],
    actions: {
      advance: { known: ["adopt"] },
      submit: { known: ["approval", "check"] },
      prove: { known: ["source", "artifact"] },
      recover: { known: ["transition", "reinfer-batch", "approval"] },
      retract: { known: ["signal"], required: ["signal"] },
      annul: { known: ["from", "approval"], required: ["from"] },
      restart: { known: [] },
    },
  },
  help: {
    purpose:
      "Drive a Workline journey: apply every transition the CLI owns and return the directive of the first boundary it does not.",
    flags: {
      code: {
        value: "<code>",
        effect: "Session to act on; defaults to the session bound to this host context.",
      },
      session: { value: "<code>", effect: "Alias of --code." },
      flow: {
        value: "<flow>",
        effect: `Flow to adopt (advance --adopt) or to re-adopt on restart when nothing records it: ${WORKLINE_FLOWS.join(", ")}.`,
      },
      host: { value: "<host>", effect: "Host id; refused unless it is in the installed catalog." },
    },
    notes: [
      "Order of a walk: advance returns a directive; answer its boundary with submit (JSON on stdin); for evidence `workline.source-bounded`, run the sealed invocation, then prove, then submit. Every directive carries state_digest, the seal an answer quotes back as input_digest.",
    ],
    actions: {
      advance: {
        purpose:
          "Apply the consecutive CLI-owned transitions and return the directive of the first boundary that needs an answer.",
        flags: {
          adopt: { effect: "Start the run of --flow in this session when none is adopted yet." },
        },
        output: DIRECTIVE_OUTPUT,
        notes: [
          "Reads no stdin. At the closing commit gate the directive adds workspace_commit_preview {repo, branch, head, message, paths[], excluded[], approval}.",
        ],
      },
      submit: {
        purpose:
          "Answer the boundary in force with the JSON envelope read from stdin and continue the walk.",
        flags: {
          approval: {
            value: "<digest>",
            effect:
              "Effect approval digest (expects.approval.digest); read only at authorization boundaries.",
          },
          check: {
            effect:
              "Validate the envelope and list its violations without recording an attempt, advancing or running internal actions.",
          },
        },
        output: `${DIRECTIVE_OUTPUT} With --check: {check: true, valid, error, violations[] ({field, message})}.`,
        notes: [...ENVELOPE_NOTES, ...ATTEMPT_NOTES],
      },
      prove: {
        purpose:
          "Capture the checkout proof the current boundary demands, prevalidated, without advancing or spending an attempt.",
        flags: {
          source: {
            value: "<alias>",
            effect: "Source whose boundary to prove; defaults to workspace.",
          },
          artifact: {
            value: "<path>",
            effect:
              "Build an `inspection` proof over this relative path instead of the `command` proof of the sealed invocation.",
          },
        },
        output:
          "{session, boundary, evidence[], checkout {source, root}, proof, warnings[], usage}.",
        notes: [...PROVE_NOTES, ...ATTEMPT_NOTES],
      },
      recover: {
        purpose:
          "Give the exhausted boundary in force back its attempts, keeping everything applied; or re-seal the inferred batch.",
        flags: {
          transition: {
            value: "<id>",
            effect: "Transition expected to be in force; refused if another one is.",
          },
          "reinfer-batch": {
            effect:
              "Preview the diff of the re-inferred batch without writing; with --approval, re-seal the same unpublished batch.",
          },
          approval: {
            value: "<digest>",
            effect:
              "Approval digest from the --reinfer-batch preview; only valid with --reinfer-batch.",
          },
        },
        output: `${DIRECTIVE_OUTPUT} With --reinfer-batch and no --approval: {reinfer_batch: true, session, batch, old_digest, new_digest, diff, approval_digest, next}.`,
        notes: [
          "Reads no stdin and does not walk: it returns the boundary to an answerable state and stops. It refuses when that boundary already exercised effects (use restart). --reinfer-batch refuses --transition; re-sealing forces validation and review to run again.",
        ],
      },
      restart: {
        purpose:
          "Archive a stuck run record and re-adopt the same flow, so the session never needs hand edits to its run state.",
        flags: {},
        output: DIRECTIVE_OUTPUT,
        notes: [
          "Covers any stuck state: an exhausted boundary with effects, an unreadable or badly sealed record, a record older than v11, an unreadable or reverted attempt counter. The record and its counter are archived to a dated, sealed file inside the session; the flow is re-adopted from the record, the custody or --flow, and the restart is traced. Never edit .flow-run.json by hand.",
        ],
      },
      annul: {
        purpose:
          "Reopen a wrongly credited batch and every later one, previewing first and applying with its digest.",
        flags: {
          from: { value: "<batch>", effect: "First batch to reopen; later batches reopen too." },
          approval: {
            value: "<digest>",
            effect:
              "Digest from the preview; applies the annulment. Without it nothing is written.",
          },
        },
        output: `Preview: {session, plan, batches[] ({id, phases[], tasks[], kind?}), phases[], tasks[], unseals_done, digest, next}. Applied: ${DIRECTIVE_OUTPUT}`,
        notes: [
          "Applying leaves the phases and tasks pending and open in the plan, removes its done seal if present, re-adopts the run so it infers them again and traces it. Git is never touched.",
        ],
      },
      retract: {
        purpose:
          "Withdraw a signal before its consuming row applies, leaving a trace and without refunding attempts.",
        flags: { signal: { value: "<signal>", effect: "Signal id to withdraw." } },
        output: DIRECTIVE_OUTPUT,
      },
    },
  },

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
          return failSemantic({
            code: "ARGS_INVALID",
            message: "--reinfer-batch no admite --transition",
            ...usageAction(verb),
          });
        return reinferVerb(args, ctx, session);
      }
      if (args.values.has("approval"))
        return failSemantic({
          code: "ARGS_INVALID",
          message: "--approval en recover exige --reinfer-batch",
          ...usageAction(verb),
        });
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
            process: ctx.process,
          }),
        );
      return await projectWithCommit(
        ctx,
        await submitFlow(ctx.fs, ctx.paths, {
          ...session,
          raw: await readRequiredStdin(),
          approval: approval ?? null,
          executor,
          git: ctx.git,
          process: ctx.process,
        }),
      );
    }

    return await projectWithCommit(
      ctx,
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
    return failSemantic({
      code: "ARGS_INVALID",
      message: "uso: aw flow retract --session <código> --signal <señal>",
      ...usageAction("retract"),
    });
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
    return failSemantic({
      code: "ARGS_INVALID",
      message: "uso: aw flow annul --session <código> --from <lote> [--approval <digest>]",
      ...usageAction("annul"),
    });
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

async function projectWithCommit(
  ctx: CliContext,
  result: AdvanceFlowResult | SubmitFlowResult,
): Promise<CommandResult<FlowResult>> {
  if (!result.ok || result.directive.boundary.transition !== "chassis.commit-choice")
    return project(result);
  const offer = await runWorkspaceCommit(ctx.fs, ctx.git, ctx.process, ctx.paths, {
    code: result.directive.session,
  });
  const directive = result.directive;
  if ("error" in offer) {
    return project({
      ...result,
      directive: {
        ...directive,
        next_action: `${directive.next_action} · commit no disponible: ${offer.error}`,
      },
    });
  }
  const proposal = offer.proposal;
  const detail = `${proposal.message}; rutas: ${proposal.paths.join(", ")}; excluidas: ${proposal.excluded.join(", ") || "ninguna"}; digest ${proposal.approval}`;
  return project({
    ...result,
    directive: {
      ...directive,
      workspace_commit_preview: proposal,
      choices: directive.choices.map((choice) =>
        choice.label === "Aprobar commit del workspace"
          ? { ...choice, consequence: `${choice.consequence}. ${detail}` }
          : choice,
      ),
      next_action: `${directive.next_action} · para aprobar incluí decisions.commit_approval: ${proposal.approval}`,
    },
  });
}
