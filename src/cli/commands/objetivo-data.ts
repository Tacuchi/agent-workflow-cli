import { runObjetivoCommand } from "../../application/objetivo-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const objetivoDataCommand: QtcCommand = {
  name: "objetivo-data",
  describe: "Parse OBJETIVO.md of a session into structured JSON.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const data = await runObjetivoCommand(
      ctx.fs,
      ctx.env,
      ctx.paths,
      code !== undefined ? { code } : {},
      ctx.runtime,
    );
    return { ok: true, data, exitCode: 0 };
  },
};
