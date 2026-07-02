import { runCheckBranch } from "../../application/check-branch-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const checkBranchCommand: QtcCommand = {
  name: "check-branch",
  describe: "Verify a source branch vs expected work branch.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const alias = flagValue(args, "source");
    // `path` es multi-value en el parser (multiroot) → leerlo vía flagValue.
    const pathArg = flagValue(args, "path");
    const fileArg = args.values.get("file");
    const session = args.values.get("session");
    const strict = args.flags.has("--strict");

    const input: Parameters<typeof runCheckBranch>[4] = {};
    if (alias !== undefined) input.alias = alias;
    if (pathArg !== undefined) input.pathArg = pathArg;
    if (fileArg !== undefined) input.fileArg = fileArg;
    if (session !== undefined) input.sessionCode = session;
    if (strict) input.strict = true;

    const data = await runCheckBranch(ctx.fs, ctx.env, ctx.git, ctx.paths, input);
    const exit: 0 | 1 | 2 = strict && data.match === false ? 2 : 0;
    return { ok: true, data, exitCode: exit };
  },
};
