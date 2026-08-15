/**
 * `aw discard` and `aw reset`: the two surfaces of one retirement contract.
 *
 * Both are CROSS-CUTTING commands, and deliberately so: neither opens a
 * WorklineFlow nor creates a session. A retirement can end by deleting the very
 * session that drove it, so a run of its own would be a run that erases its own
 * state mid-flight — the one shape this feature must not have.
 *
 * `prepare` is read-only and answers with the sealed proposal plus its digest.
 * `apply` demands that digest back, RE-computes everything under the workspace
 * lock, and only then delegates to the coordinator. Approving is not applying, and
 * the digest is what makes those two the same decision rather than two.
 *
 * The two verbs share every rule; what differs is the mode, which is the whole
 * reason they are two commands and not one with a flag: `discard` takes work away
 * and `reset` puts a document back, and a person typing the wrong one should be
 * typing a different WORD, not a different option.
 */

import { applyRetirement } from "../../application/retirement/apply.js";
import type { ApplyResult } from "../../application/retirement/apply.js";
import { prepareRetirement } from "../../application/retirement/prepare.js";
import {
  type RetirementPreview,
  renderRetirementPreview,
  retirementPreview,
} from "../../application/retirement/preview.js";
import type { RetirementMode } from "../../domain/retirement/proposal.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { HumanRenderContext, QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

type Action = "prepare" | "apply";

const ACTIONS = new Set<Action>(["prepare", "apply"]);

/** What `prepare` answers with: the preview, and the digest that authorizes it. */
export interface PrepareOutput {
  mode: RetirementMode;
  action: "prepare";
  /** The seal to approve. Nothing applies without it. */
  digest: string;
  preview: RetirementPreview;
  /** The exact command that applies exactly this. */
  next: string;
}

export interface ApplyOutput extends ApplyResult {
  action: "apply";
}

export type RetirementOutput = PrepareOutput | ApplyOutput;

/**
 * A refusal, in this command's own result type.
 *
 * The diagnostic detail travels in the ERROR and not in `data`, because `data` is
 * this command's output shape and a rejection is not a retirement. Conflating them
 * would let a caller read a refusal as if it were a result.
 */
function refuse(code: string, message: string, detail: unknown): CommandResult<RetirementOutput> {
  return { ok: false, error: { code, message, ...asDetail(detail) }, exitCode: 1 };
}

function asDetail(detail: unknown): { details?: Record<string, unknown> } {
  return detail !== null && typeof detail === "object"
    ? { details: detail as Record<string, unknown> }
    : {};
}

function usage(mode: RetirementMode): string {
  return `uso: ${mode} prepare <objetivo> | ${mode} apply <objetivo> --approval <digest>`;
}

function retirementCommand(mode: RetirementMode): QtcCommand<RetirementOutput> {
  return {
    name: mode,
    describe: describeOf(mode),
    async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<RetirementOutput>> {
      const action = args.rest[0] as Action | undefined;
      const target = args.rest[1];
      if (action === undefined || !ACTIONS.has(action) || target === undefined) {
        return refuse("INVALID_INPUT", usage(mode), { error: usage(mode) });
      }
      const deps = { fs: ctx.fs, env: ctx.env, git: ctx.git, paths: ctx.paths };

      if (action === "prepare") {
        const outcome = await prepareRetirement(deps, { mode, target });
        if (!outcome.ok) {
          return refuse(outcome.rejection.code, outcome.rejection.message, outcome.rejection);
        }
        const preview = retirementPreview(outcome.proposal);
        return {
          ok: true,
          data: {
            mode,
            action: "prepare",
            digest: outcome.proposal.digest,
            preview,
            next: `aw ${mode} apply ${target} --approval ${outcome.proposal.digest}`,
          },
          exitCode: 0,
        };
      }

      const approval = args.values.get("approval");
      if (approval === undefined || approval.trim().length === 0) {
        const missing = `${mode} apply exige --approval <digest>: corré '${mode} prepare ${target}' y aprobá el digest que muestra`;
        return refuse("APPROVAL_REQUIRED", missing, { error: missing });
      }
      const applied = await applyRetirement(deps, { mode, target, approval: approval.trim() });
      if (!applied.ok) {
        return refuse(applied.rejection.code, applied.rejection.message, applied.rejection);
      }
      return { ok: true, data: { action: "apply", ...applied.result }, exitCode: 0 };
    },
    renderHuman(result, context): string {
      return render(mode, result, context);
    },
  };
}

function describeOf(mode: RetirementMode): string {
  const shared =
    "Cross-cutting: it opens no flow and creates no session. `prepare` is read-only and returns the sealed proposal + its digest; " +
    "`apply` requires that digest, recomputes everything under the workspace lock and converges all-or-nothing. " +
    "Local changes attributable to the scope are discarded; commits are only reverted as new commits, never rewritten, and no push happens.";
  return mode === "discard"
    ? `Retire a spec, plan, quick or session together with every descendant it exclusively owns. ${shared} Usage: aw discard prepare|apply <spec:NNN|plan:PPP|quick:NNN|session:NNN|ruta> [--approval <digest>].`
    : `Return an incomplete session's inputs to the exact bytes they had before it ran, and retire the session with its outputs. ${shared} Usage: aw reset prepare|apply <plan:PPP|session:NNN|ruta> [--approval <digest>].`;
}

/**
 * The human projection of the SAME result the JSON carries.
 *
 * A terminal reader and an agent host must be able to differ in shape and never in
 * scope, so this only chooses a rendering — it re-derives nothing.
 */
function render(
  mode: RetirementMode,
  result: CommandResult<RetirementOutput>,
  context: HumanRenderContext,
): string {
  if (!result.ok || result.data === undefined) return "";
  const data = result.data;
  if (data.action === "prepare") {
    const lines = [renderRetirementPreview(data.preview)];
    if (data.preview.touches_git_history) {
      lines.push(
        "",
        "Aprobar esto AUTORIZA commits: se agregan reverts a la rama de arriba. Los originales siguen alcanzables y ningún push ocurre.",
      );
    }
    lines.push("", `Para aplicar exactamente esto:\n  ${data.next}`);
    return lines.join("\n");
  }

  const lines = [
    data.already_applied
      ? `${mode}: la operación ya estaba aplicada; esta corrida sólo la terminó.`
      : `${mode} aplicado: ${data.target}`,
  ];
  if (data.removed.length > 0) lines.push(`Retirado: ${data.removed.join(", ")}`);
  if (data.restored.length > 0) {
    lines.push(`Restaurado: ${data.restored.join(", ")}`);
  } else if (mode === "reset") {
    // The other half of the same rule the preview applies: an empty list renders
    // as an ABSENT line, and "reset aplicado" on its own reads as "you are back
    // where you started". A reset with no declared input restores nothing, and
    // that has to survive into the report, not only into the preview nobody
    // re-reads afterwards.
    lines.push("Nada volvió atrás: la sesión no declaraba entradas en su custodia.");
  }
  if (data.published !== null) {
    lines.push(`Publicado en ${data.published.ref}: ${data.published.to.slice(0, 12)}`);
  }
  if (data.pending_remote_publication.length > 0) {
    lines.push(
      `Pendiente y externo: publicar el revert de ${data.pending_remote_publication.join(", ")} (el retiro nunca pushea)`,
    );
  }
  if (data.pending_reconciliation.length > 0) {
    lines.push(
      `Sin reconciliar: ${data.pending_reconciliation.join(", ")} — la unidad tiene trabajo sin commitear y no se fuerza`,
    );
  }
  if (context.detail) {
    lines.push(
      `Digest: ${data.digest}`,
      `Asociaciones invalidadas: ${data.bindings_invalidated}`,
      `Unidades devueltas: ${data.units_released.length}`,
    );
  }
  return lines.join("\n");
}

export const discardCommand = retirementCommand("discard");
export const resetCommand = retirementCommand("reset");
