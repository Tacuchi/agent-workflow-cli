/**
 * `aw hub-migrate`: bring a hub that carries a legacy session series up to
 * the model the rest of the CLI operates.
 *
 * Read-only by default and explicit by design. It is a PUNCTUAL operation, not
 * a reconciliation another command performs on the side: it decides by
 * comparing the durable record against the disk, the two can disagree, and a
 * disagreement is answered by leaving that session exactly as it was and saying
 * so. Nothing is written until somebody types `--apply`, and what gets written
 * is re-derived under the hub lock at that moment.
 */

import { ensureWorklineMaterialized } from "../../application/hub-materialization-service.js";
import {
  type HubMigrationApplied,
  applyHubMigration,
} from "../../application/hub-migrate/apply.js";
import { KEEP_CHOICE_TEXT, type KeepChoice } from "../../application/hub-migrate/block-file.js";
import { planHubMigration } from "../../application/hub-migrate/plan.js";
import {
  type HubMigrationPreview,
  migrationPreview,
  renderMigrationApplied,
  renderMigrationPreview,
} from "../../application/hub-migrate/preview.js";
import { BLOCK_FILE, LEGACY_BLOCK_FILE } from "../../application/parsers/hub-block.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, CommandFlags } from "../registry.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";
import { type SessionMigrationOutput, sessionsMigrationVerb } from "./hub-migrate-sessions.js";

const FLAGS: CommandFlags = { known: ["apply", "keep", "documents", "commit", "approval"] };
const KEEP_CHOICES: readonly KeepChoice[] = [BLOCK_FILE, LEGACY_BLOCK_FILE];

export interface MigratePreviewOutput extends HubMigrationPreview {
  action: "preview";
}

export interface MigrateApplyOutput extends HubMigrationApplied {
  action: "apply";
}

export type HubMigrateOutput = MigratePreviewOutput | MigrateApplyOutput | SessionMigrationOutput;

export const hubMigrateCommand: CliCommand<HubMigrateOutput> = {
  name: "hub-migrate",
  flags: FLAGS,
  help: {
    purpose:
      "Bring a hub up to the current model: block markers and heading, the hub block only in AGENTS.md, the reserved hub alias of open plans and runs, closing sentinels and reserved numbers.",
    flags: {
      apply: {
        effect: "Write the migration under the hub lock; without it nothing is written.",
      },
      documents: {
        effect:
          "Bring a 30.x hub to the documents model of 31.0.0: preview each plan's state mapping, the open runs and the legacy records to delete; nothing is written without the answers.",
      },
      commit: {
        effect: "With --documents: make the single migration commit its --apply proposed.",
      },
      approval: {
        value: "<digest>",
        effect:
          "With --documents --apply: the preview's digest; with --commit: the commit's digest.",
      },
      keep: {
        value: "<AGENTS.md|CLAUDE.md>",
        effect: "Block that survives when CLAUDE.md and AGENTS.md declare different hub blocks.",
      },
    },
    output:
      "{action: preview, hub, markers[], aliases[], runs[], sentinels[], rows[], block_file, block_divergence, conflicts[], legacy[], next_correlative, pending, next, choices[]} — next is null while a divergent pair waits for --keep, and choices[] then lists the two commands | {action: apply, hub, markers_renamed[], duplicates_dropped[], aliases_rewritten[], runs_rewritten[], sentinels_seeded[], rows_seeded[], rows_without_date[], block_file, conflicts[], next_correlative}.",
    notes: [
      "Renames the block markers to <NS>-HUB-START/END (also from a PROJECT block or an older namespace) and its ## Proyecto heading to ## Hub, renames the reserved alias workspace to hub in open plans (closed ones stay byte for byte). A busy lock fails with LOCK_BUSY.",
      "Retires the legacy CLAUDE.md copy of the hub block: a CLAUDE.md holding only the block is deleted; one with other content keeps it, loses the block and gains an @AGENTS.md import at its top; one that only imports @AGENTS.md is left alone. The surviving block is rewritten in AGENTS.md with the current format. When the two copies differ, the preview lists the lines only one declares and nothing is written for them until --keep names the copy that wins. Lines the CLI cannot honour are reported in dropped_lines; a CLAUDE.md symlinked to AGENTS.md is left alone and a file with two blocks is reported, not written.",
    ],
  },

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<HubMigrateOutput>> {
    if (args.flags.has("--documents")) return sessionsMigrationVerb(args, ctx);
    const keep = args.values.get("keep");
    const keepGiven = keep !== undefined || args.flags.has("--keep");
    if (keepGiven && !KEEP_CHOICES.includes(keep as KeepChoice)) {
      return failSemantic<HubMigrateOutput>({
        code: "INVALID_INPUT",
        message: `--keep acepta ${KEEP_CHOICES.join(" o ")}, no '${keep ?? ""}'`,
        action: `usá ${KEEP_CHOICE_TEXT}`,
      });
    }
    const choice = keep as KeepChoice | undefined;
    if (!args.flags.has("--apply")) {
      const plan = await planHubMigration(ctx.fs, ctx.paths, undefined, choice);
      return {
        ok: true,
        data: {
          action: "preview",
          ...migrationPreview(plan, choice),
        },
        exitCode: 0,
      };
    }

    await ensureWorklineMaterialized(ctx.fs, ctx.paths);
    const applied = await applyHubMigration(ctx.fs, ctx.paths, choice);
    if ("error" in applied) {
      return failSemantic<HubMigrateOutput>({
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
    if (data.action.startsWith("sessions-")) return `${JSON.stringify(data, null, 2)}\n`;
    const legacy = data as MigratePreviewOutput | MigrateApplyOutput;
    const lines =
      legacy.action === "apply"
        ? [renderMigrationApplied(legacy)]
        : [renderMigrationPreview(legacy as MigratePreviewOutput)];
    if (context.detail && legacy.action === "preview") {
      lines.push("", `Serie legacy: ${legacy.legacy.join(", ") || "(ninguna)"}`);
    }
    // The writer emits this verbatim, so the trailing newline belongs here.
    return `${lines.join("\n").trimEnd()}\n`;
  },
};
