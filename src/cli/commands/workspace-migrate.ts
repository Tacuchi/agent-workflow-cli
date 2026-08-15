/**
 * `aw workspace-migrate`: bring a hub that carries a legacy session series up to
 * the model the rest of the CLI operates.
 *
 * Read-only by default and explicit by design. It is a PUNCTUAL operation, not
 * a reconciliation another command performs on the side: it decides by
 * comparing the durable record against the disk, the two can disagree, and a
 * disagreement is answered by leaving that session exactly as it was and saying
 * so. Nothing is written until somebody types `--apply`, and what gets written
 * is re-derived under the workspace lock at that moment.
 */

import {
  type WorkspaceMigrationApplied,
  applyWorkspaceMigration,
} from "../../application/workspace-migrate/apply.js";
import { planWorkspaceMigration } from "../../application/workspace-migrate/plan.js";
import {
  type WorkspaceMigrationPreview,
  migrationPreview,
  renderMigrationApplied,
  renderMigrationPreview,
} from "../../application/workspace-migrate/preview.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";
import { type FlagContract, reviewFlags, unknownFlagMessage } from "./unknown-flags.js";

// A command born today has no caller that ever passed it a flag of more, so
// there is nothing to break by refusing one — which is why the rejection can be
// total here and had to be scoped elsewhere.
const FLAGS: FlagContract = { known: ["apply"] };

export interface MigratePreviewOutput extends WorkspaceMigrationPreview {
  action: "preview";
  /** The exact command that performs exactly this. */
  next: string;
}

export interface MigrateApplyOutput extends WorkspaceMigrationApplied {
  action: "apply";
}

export type WorkspaceMigrateOutput = MigratePreviewOutput | MigrateApplyOutput;

export const workspaceMigrateCommand: QtcCommand<WorkspaceMigrateOutput> = {
  name: "workspace-migrate",
  describe:
    "Pone al día un workspace con serie legacy: renombra los marcadores del bloque de proyecto al namespace vigente, " +
    "siembra los centinelas de cierre que el histórico ya declara y reserva los números legacy en el registro durable. " +
    "Sin --apply no escribe nada: muestra qué va a pasar. Una sesión sobre la que el histórico y el disco se contradicen " +
    "queda intacta y se reporta. Usage: aw workspace-migrate [--apply].",

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<WorkspaceMigrateOutput>> {
    const review = reviewFlags(args, FLAGS);
    if (review.unknown.length > 0) {
      return failSemantic<WorkspaceMigrateOutput>({
        code: "UNKNOWN_FLAG",
        message: unknownFlagMessage(review, FLAGS),
        action: "corregí el flag y reintentá: `aw workspace-migrate [--apply]`",
      });
    }

    if (!args.flags.has("--apply")) {
      const plan = await planWorkspaceMigration(ctx.fs, ctx.paths);
      return {
        ok: true,
        data: {
          action: "preview",
          ...migrationPreview(plan),
          next: "aw workspace-migrate --apply",
        },
        exitCode: 0,
      };
    }

    const applied = await applyWorkspaceMigration(ctx.fs, ctx.paths);
    if ("error" in applied) {
      return failSemantic<WorkspaceMigrateOutput>({
        code: "LOCK_BUSY",
        message: applied.error,
        action: "esperá a que termine la operación en curso y reintentá",
      });
    }
    return { ok: true, data: { action: "apply", ...applied }, exitCode: 0 };
  },

  renderHuman(result, context): string {
    if (!result.ok || result.data === undefined) return "";
    const data = result.data;
    const lines =
      data.action === "apply" ? [renderMigrationApplied(data)] : [renderMigrationPreview(data)];
    if (context.detail && data.action === "preview") {
      lines.push("", `Serie legacy: ${data.legacy.join(", ") || "(ninguna)"}`);
    }
    // The writer emits this verbatim, so the trailing newline belongs here.
    return `${lines.join("\n").trimEnd()}\n`;
  },
};
