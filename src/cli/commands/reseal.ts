/**
 * `aw reseal`: closing a legitimate baseline divergence without walking a whole
 * `plan-refine`.
 *
 * A CROSS-CUTTING command, like the retirement pair: it opens no WorklineFlow and
 * creates no session. There is nothing for a run to direct — `prepare` reads and
 * `apply` writes one line — and giving it a journey would cost the bundle a
 * document per invocation for a decision that is already one question.
 *
 * The question it asks is not technical. Re-sealing ASSERTS that a person read
 * the plan against the spec as it stands and concluded it still holds, so the
 * approval is explicit and the digest is what ties "what I read" to "what was
 * written". `prepare` shows the seal it would replace, the one it would write and
 * the exact next command; `apply` demands that digest back and recomputes
 * everything before touching a byte.
 */

import {
  type ResealPreview,
  applyReseal,
  prepareReseal,
} from "../../application/reseal-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

type Action = "prepare" | "apply";

const ACTIONS = new Set<Action>(["prepare", "apply"]);

const USAGE = "uso: reseal prepare <plan> | reseal apply <plan> --approval <digest>";

/** What `prepare` answers with: the preview, and the digest that authorizes it. */
export interface ResealPrepareOutput {
  action: "prepare";
  /** `already` when the seal is the current one: there is nothing to approve. */
  status: "prepared" | "already";
  /** The seal to approve; `null` when there is nothing to apply. */
  digest: string | null;
  preview: ResealPreview;
  /** The exact command that applies exactly this; `null` when nothing is owed. */
  next: string | null;
}

export interface ResealApplyOutput {
  action: "apply";
  status: "applied" | "already";
  preview: ResealPreview;
  written: string[];
  already_applied: boolean;
}

export type ResealOutput = ResealPrepareOutput | ResealApplyOutput;

/**
 * A refusal, in the canonical envelope: the stable code, the message, and the one
 * next action — the SAME shape every other semantic surface produces, so the
 * human projection and the JSON cannot disagree about what to do next.
 */
function refuse(code: string, message: string, action: string): CommandResult<ResealOutput> {
  return failSemantic<ResealOutput>({ code, message, action });
}

export const resealCommand: CliCommand<ResealOutput> = {
  name: "reseal",
  describe:
    "Re-seal a plan's `> Baseline:` against the current functional content of its spec, when a review concluded the plan still holds. " +
    "Cross-cutting: it opens no flow and creates no session. `prepare` is read-only and returns the line it would write plus its digest; " +
    "`apply` requires that digest, re-runs the whole preparation under the workspace lock and rewrites the seal line only. " +
    "It asserts nothing on its own: the divergence a redesign should close still belongs to /w:plan-refine. " +
    "Usage: aw reseal prepare|apply <ruta del plan|correlativo> [--approval <digest>].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ResealOutput>> {
    const action = args.rest[0] as Action | undefined;
    const target = args.rest[1];
    if (action === undefined || !ACTIONS.has(action) || target === undefined) {
      return refuse("INVALID_INPUT", USAGE, USAGE);
    }

    if (action === "prepare") {
      const prepared = await prepareReseal(ctx.fs, ctx.env, ctx.paths, target);
      if (prepared.status === "failed") {
        return refuse(prepared.failure.code, prepared.failure.message, prepared.failure.action);
      }
      if (prepared.status === "already") {
        return {
          ok: true,
          data: {
            action: "prepare",
            status: "already",
            digest: null,
            preview: prepared.preview,
            next: null,
          },
          exitCode: 0,
        };
      }
      return {
        ok: true,
        data: {
          action: "prepare",
          status: "prepared",
          digest: prepared.proposal.digest,
          preview: prepared.preview,
          next: `aw reseal apply ${prepared.preview.plan} --approval ${prepared.proposal.digest}`,
        },
        exitCode: 0,
      };
    }

    const approval = args.values.get("approval");
    if (approval === undefined || approval.trim().length === 0) {
      const missing = `reseal apply exige --approval <digest>: corré 'aw reseal prepare ${target}' y aprobá el digest que muestra`;
      return refuse("APPROVAL_REQUIRED", missing, missing);
    }
    const applied = await applyReseal(ctx.fs, ctx.env, ctx.paths, {
      target,
      approval: approval.trim(),
    });
    if (applied.status === "failed") {
      return refuse(applied.failure.code, applied.failure.message, applied.failure.action);
    }
    if (applied.status === "already") {
      return {
        ok: true,
        data: {
          action: "apply",
          status: "already",
          preview: applied.preview,
          written: [],
          already_applied: true,
        },
        exitCode: 0,
      };
    }
    return {
      ok: true,
      data: {
        action: "apply",
        status: "applied",
        preview: applied.preview,
        written: applied.written,
        already_applied: applied.already_applied,
      },
      exitCode: 0,
    };
  },

  renderHuman(result, context): string {
    if (!result.ok || result.data === undefined) return "";
    const data = result.data;
    return data.action === "prepare" ? renderPrepare(data, context) : renderApply(data);
  },
};

/** `sellado → vigente`, the line that lands, and the one command that lands it. */
function renderPrepare(data: ResealPrepareOutput, context: HumanRenderContext): string {
  const lines = [`Re-sello de ${data.preview.plan}`, `Spec vigente: ${data.preview.spec}`];
  if (data.status === "already") {
    lines.push(
      `Sello: ${data.preview.current_digest} — ya es el vigente, no hay nada que re-sellar.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `Sello: ${data.preview.sealed_digest ?? "sin sello"} → ${data.preview.current_digest}`,
    "",
    "Línea nueva (lo único que cambia del plan):",
    `  ${data.preview.baseline_line}`,
    "",
    "Aprobar esto AFIRMA que revisaste el plan contra la spec vigente y sigue valiendo. Si el plan hay que rediseñarlo, la salida es /w:plan-refine.",
    "",
    `Para aplicar exactamente esto:\n  ${data.next ?? ""}`,
  );
  if (context.detail) lines.push("", `Digest: ${data.digest ?? "—"}`);
  return lines.join("\n");
}

function renderApply(data: ResealApplyOutput): string {
  if (data.status === "already" || data.already_applied) {
    return [
      `Re-sello de ${data.preview.plan}: el sello ya era el vigente (${data.preview.current_digest}); no se escribió nada.`,
    ].join("\n");
  }
  return [
    `Re-sellado ${data.preview.plan}: ${data.preview.sealed_digest ?? "sin sello"} → ${data.preview.current_digest}`,
    `Línea vigente: ${data.preview.baseline_line}`,
    `Escrito: ${data.written.join(", ")}`,
  ].join("\n");
}
