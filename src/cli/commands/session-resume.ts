import {
  type SessionResumeInput,
  runSessionResume,
} from "../../application/session-resume-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

export const sessionResumeCommand: CliCommand = {
  name: "session-resume",
  describe:
    "Load resume payload for a session (objetivo + checkpoint). With --reopen, reactivate it if closed (inter-turn continuity). " +
    "Usage: aw session-resume [--code <session>] [--reopen].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionResumeInput = {};
    const code = args.values.get("code");
    if (code !== undefined) input.code = code;
    if (args.flags.has("--reopen")) input.reopen = true;
    const contextId = readContextId(ctx.env);
    if (contextId !== undefined) input.contextId = contextId;

    const data = await runSessionResume(ctx.fs, ctx.env, ctx.paths, input);
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    if ("error" in data) return fail(data.code ?? "INVALID_INPUT", data.error, data);
    return { ok: true, data, exitCode: 0 };
  },
};
