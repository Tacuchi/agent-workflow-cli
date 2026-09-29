import { runCheckBranch } from "../../application/check-branch-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import { type ParsedArgs, flagValue, sessionCodeFlag } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const checkBranchCommand: CliCommand = {
  name: "check-branch",
  flags: { known: ["code", "session", "source", "path", "file", "strict"] },
  help: {
    purpose:
      "Check that a source is on its expected working branch, or that a file falls in this flow's isolation unit.",
    flags: {
      code: { value: "<code>", effect: "Session whose expected branch applies." },
      session: { value: "<code>", effect: "Alias of --code." },
      source: { value: "<alias>", effect: "Source to check." },
      path: { value: "<path>", effect: "Source path, or a path inside it, to check." },
      file: { value: "<path>", effect: "File about to be edited; resolves its source and unit." },
      strict: { effect: "Exit 2 when the branch or unit does not match." },
    },
    output:
      "{match, reason?, alias?, path?, current_branch?, expected_work_branch?, expected_origin?, main_branch?, session_code?, work_branch?, document?, dirty?, changed_files[]?, is_repo?, error?, actual_unit?, expected_unit?, remedy?}.",
    exit_codes: { "2": "With --strict, match is false." },
    notes: ["Read-only."],
  },
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
