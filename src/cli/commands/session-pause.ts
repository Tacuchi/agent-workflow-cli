import { runSessionPause } from "../../application/session-pause-service.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const sessionPauseCommand: CliCommand = {
  name: "session-pause",
  flags: { known: ["code"], usage: "aw session-pause --code <sesión>" },
  describe:
    "Mark a session as paused at the user's request. Usage: aw session-pause --code <sesión>.",
  async execute(args, ctx) {
    const result = await runSessionPause(ctx.fs, ctx.paths, args.values.get("code"));
    if ("error" in result) return fail(result.code, result.error);
    return { ok: true, data: result, exitCode: 0 };
  },
};
