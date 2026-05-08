import { runWorkspaceMode } from "../../application/workspace-mode-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const workspaceModeCommand: QtcCommand = {
  name: "workspace-mode",
  describe: "Read workspace mode (project|hub) + sources + working branches.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verbose = args.flags.has("--verbose");
    const data = await runWorkspaceMode(ctx.fs, ctx.env, ctx.paths, { verbose });
    return { ok: true, data, exitCode: 0 };
  },
};
