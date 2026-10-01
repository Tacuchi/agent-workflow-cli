import { resolve } from "node:path";
import {
  type WorkspaceMoveResult,
  moveWorkspace,
} from "../../application/workspace-move-service.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const workspaceMoveCommand: CliCommand<WorkspaceMoveResult> = {
  name: "hub-move",
  flags: { known: ["repair", "from", "dry-run"] },
  help: {
    purpose: "Move a hub and repair its references, or repair one that was moved by hand.",
    args: "[<destination>]",
    flags: {
      repair: { effect: "Repair a hub already moved by hand; takes no destination." },
      from: {
        value: "<old-path>",
        effect: "With --repair, the path the hub was moved from.",
      },
      "dry-run": { effect: "Report the changes without applying them." },
    },
    output: "{from, to, moved, dry_run, changes[], warnings[]}.",
    notes: ["Pass exactly one of <destination> or --repair."],
  },
  async execute(args, ctx) {
    const repair = args.flags.has("--repair");
    const from = args.values.get("from");
    if (repair === (args.rest[0] !== undefined) || args.rest.length > 1) {
      return fail(
        "ARGS_INVALID",
        "Usa hub-move <destino> o hub-move --repair [--from <ruta vieja>].",
      );
    }
    try {
      const result = await moveWorkspace(ctx.rawFs ?? ctx.fs, ctx.paths, {
        repair,
        ...(args.rest[0] ? { destination: resolve(ctx.env.cwd(), args.rest[0]) } : {}),
        ...(from ? { from: resolve(ctx.env.cwd(), from) } : {}),
        dryRun: args.flags.has("--dry-run"),
      });
      return { ok: true, data: result, exitCode: 0 };
    } catch (error) {
      return fail("HUB_MOVE_FAILED", error instanceof Error ? error.message : String(error));
    }
  },
  renderHuman(result) {
    if (!result.ok || !result.data) return "";
    const data = result.data;
    return [
      `hub-move ${data.dry_run ? "· simulación" : "· realizado"}: ${data.from} → ${data.to}`,
      ...data.changes.map((change) => `  ${change}`),
      ...data.warnings.map((warning) => `  Aviso: ${warning}`),
      "",
    ].join("\n");
  },
};
