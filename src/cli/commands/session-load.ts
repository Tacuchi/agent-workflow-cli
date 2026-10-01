import { type SessionLoadInput, runSessionLoad } from "../../application/session-load-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

export const sessionLoadCommand: CliCommand = {
  name: "session-load",
  flags: { known: ["code", "reopen"] },
  help: {
    purpose: "Load what a session needs to resume: its objective and its last checkpoint.",
    flags: {
      code: {
        value: "<code>",
        effect: "Session to resume; defaults to the one associated with this conversation.",
      },
      reopen: { effect: "Reactivate the session if it is closed, so new work lands in it." },
    },
    output: "{code, folder, path, state, objetivo, objetivo_text, checkpoint, run? {resumes_at}}.",
    notes: ["Without --reopen the command is read-only."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionLoadInput = {};
    const code = args.values.get("code");
    if (code !== undefined) input.code = code;
    if (args.flags.has("--reopen")) input.reopen = true;
    const contextId = readContextId(ctx.env);
    if (contextId !== undefined) input.contextId = contextId;

    const data = await runSessionLoad(ctx.fs, ctx.env, ctx.paths, input);
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    if ("error" in data) return fail(data.code ?? "INVALID_INPUT", data.error, data);
    return { ok: true, data, exitCode: 0 };
  },
};
