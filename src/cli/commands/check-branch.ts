import { runCheckBranch } from "../../application/check-branch-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import { type ParsedArgs, flagValue, sessionCodeFlag } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const checkBranchCommand: QtcCommand = {
  name: "check-branch",
  describe:
    "Verify a source branch vs expected work branch — or, when the source has isolation units, whether the file falls in THIS flow's unit. " +
    "Usage: aw check-branch [--source <alias>|--file <path>] [--code <NNN>] [--strict].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const alias = flagValue(args, "source");
    // `path` is multi-value in the parser (multiroot) → read it via flagValue.
    const pathArg = flagValue(args, "path");
    const fileArg = args.values.get("file");
    const session = sessionCodeFlag(args);
    if (!session.ok) return fail("INVALID_INPUT", session.message, { error: session.message });
    const strict = args.flags.has("--strict");

    const input: Parameters<typeof runCheckBranch>[4] = {};
    if (alias !== undefined) input.alias = alias;
    if (pathArg !== undefined) input.pathArg = pathArg;
    if (fileArg !== undefined) input.fileArg = fileArg;
    if (session.code !== undefined) input.sessionCode = session.code;
    const contextId = readContextId(ctx.env);
    if (contextId !== undefined) input.contextId = contextId;

    const data = await runCheckBranch(ctx.fs, ctx.env, ctx.git, ctx.paths, input);
    const exit: 0 | 1 | 2 = strict && data.match === false ? 2 : 0;
    return { ok: true, data, exitCode: exit };
  },
};
