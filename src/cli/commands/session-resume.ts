import { runSessionResume } from "../../application/session-resume-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sessionResumeCommand: QtcCommand = {
  name: "session-resume",
  describe:
    "Load resume payload for a session (objetivo + checkpoint). With --reopen, reactivate it if closed (inter-turn continuity).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const reopen = args.flags.has("--reopen");
    const data = await runSessionResume(ctx.fs, ctx.env, ctx.paths, {
      ...(code !== undefined ? { code } : {}),
      ...(reopen ? { reopen: true } : {}),
    });
    return { ok: true, data, exitCode: 0 };
  },
};
