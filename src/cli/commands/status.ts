import { runStatusCommand } from "../../application/status-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const statusCommand: QtcCommand = {
  name: "status",
  describe:
    "Read-only workspace dashboard: specs, plans, sessions y descartados con fechas relativas en español.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runStatusCommand(ctx.fs, ctx.env, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};
