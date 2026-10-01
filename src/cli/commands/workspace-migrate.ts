/**
 * `aw hub-migrate`: bring a hub that carries a legacy session series up to
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
  applyRenumber,
  applyWorkspaceMigration,
} from "../../application/workspace-migrate/apply.js";
import { planRenumber, planWorkspaceMigration } from "../../application/workspace-migrate/plan.js";
import {
  type WorkspaceMigrationPreview,
  migrationPreview,
  renderMigrationApplied,
  renderMigrationPreview,
} from "../../application/workspace-migrate/preview.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, CommandFlags } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

const FLAGS: CommandFlags = { known: ["apply", "renumber"] };

export interface MigratePreviewOutput extends WorkspaceMigrationPreview {
  action: "preview";
  /** The exact command that performs exactly this. */
  next: string;
}

export interface MigrateApplyOutput extends WorkspaceMigrationApplied {
  action: "apply";
}

export type WorkspaceMigrateOutput =
  | MigratePreviewOutput
  | MigrateApplyOutput
  | {
      action: "renumber-preview";
      moves: Awaited<ReturnType<typeof planRenumber>>["moves"];
      blocked: string[];
      next: string;
    }
  | {
      action: "renumber-apply";
      moved: Awaited<ReturnType<typeof planRenumber>>["moves"];
      blocked: string[];
    };

export const workspaceMigrateCommand: CliCommand<WorkspaceMigrateOutput> = {
  name: "hub-migrate",
  flags: FLAGS,
  help: {
    purpose:
      "Bring a hub with a legacy session series up to the current model: markers, closing sentinels and reserved numbers.",
    flags: {
      apply: {
        effect: "Write the migration under the hub lock; without it nothing is written.",
      },
      renumber: { effect: "Instead, renumber colliding session folders (preview unless --apply)." },
    },
    output:
      "{action: preview, workspace, markers[], sentinels[], rows[], conflicts[], legacy[], next_correlative, pending, next} | {action: apply, workspace, markers_renamed[], duplicates_dropped[], sentinels_seeded[], rows_seeded[], rows_without_date[], conflicts[], next_correlative} | {action: renumber-preview, moves[], blocked[], next} | {action: renumber-apply, moved[], blocked[]}.",
    notes: [
      "Renames the hub block markers to the current namespace, seeds the closing sentinels the history already declares and reserves the legacy numbers in the durable ledger. A session whose history and disk disagree is left intact and reported. A busy lock fails with LOCK_BUSY.",
    ],
  },

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<WorkspaceMigrateOutput>> {
    if (args.flags.has("--renumber")) {
      if (!args.flags.has("--apply")) {
        return {
          ok: true,
          data: {
            action: "renumber-preview",
            ...(await planRenumber(ctx.fs, ctx.paths, ctx.git)),
            next: "aw hub-migrate --renumber --apply",
          },
          exitCode: 0,
        };
      }
      const result = await applyRenumber(ctx.fs, ctx.paths, ctx.git);
      if ("error" in result)
        return failSemantic<WorkspaceMigrateOutput>({
          code: "LOCK_BUSY",
          message: result.error,
          action: "reintentá cuando termine la operación en curso",
        });
      return { ok: true, data: { action: "renumber-apply", ...result }, exitCode: 0 };
    }
    if (!args.flags.has("--apply")) {
      const plan = await planWorkspaceMigration(ctx.fs, ctx.paths);
      return {
        ok: true,
        data: {
          action: "preview",
          ...migrationPreview(plan),
          next: "aw hub-migrate --apply",
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
    if (data.action === "renumber-preview" || data.action === "renumber-apply") {
      const moves = data.action === "renumber-preview" ? data.moves : data.moved;
      return `${moves.map((move) => `${move.from} → ${move.to} (${move.reason})`).join("\n") || "Sin colisiones para renumerar"}${data.blocked.length ? `\nBloqueadas: ${data.blocked.join("; ")}` : ""}${data.action === "renumber-preview" ? `\n${data.next}` : ""}\n`;
    }
    const lines =
      data.action === "apply" ? [renderMigrationApplied(data)] : [renderMigrationPreview(data)];
    if (context.detail && data.action === "preview") {
      lines.push("", `Serie legacy: ${data.legacy.join(", ") || "(ninguna)"}`);
    }
    // The writer emits this verbatim, so the trailing newline belongs here.
    return `${lines.join("\n").trimEnd()}\n`;
  },
};
