import { resolve } from "node:path";
import {
  type WorkspaceMoveResult,
  moveWorkspace,
} from "../../application/workspace-move-service.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const workspaceMoveCommand: CliCommand<WorkspaceMoveResult> = {
  name: "workspace-move",
  flags: {
    known: ["repair", "from", "dry-run"],
    usage:
      "aw workspace-move <destino> [--dry-run] | aw workspace-move --repair [--from <ruta vieja>] [--dry-run]",
  },
  describe:
    "Mueve un workspace y repara sus referencias, o repara uno movido a mano. Acepta --dry-run y --repair [--from <ruta vieja>].",
  async execute(args, ctx) {
    const repair = args.flags.has("--repair");
    const from = args.values.get("from");
    if (repair === (args.rest[0] !== undefined) || args.rest.length > 1) {
      return fail(
        "ARGS_INVALID",
        "Usa workspace-move <destino> o workspace-move --repair [--from <ruta vieja>].",
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
      return fail("WORKSPACE_MOVE_FAILED", error instanceof Error ? error.message : String(error));
    }
  },
  renderHuman(result) {
    if (!result.ok || !result.data) return "";
    const data = result.data;
    return [
      `workspace-move ${data.dry_run ? "· simulación" : "· realizado"}: ${data.from} → ${data.to}`,
      ...data.changes.map((change) => `  ${change}`),
      ...data.warnings.map((warning) => `  Aviso: ${warning}`),
      "",
    ].join("\n");
  },
};
