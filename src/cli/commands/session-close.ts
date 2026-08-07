import {
  type SessionCloseInput,
  runSessionClose,
} from "../../application/session-close-service.js";
import { runWorktree } from "../../application/worktree-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";

export const sessionCloseCommand: QtcCommand = {
  name: "session-close",
  describe:
    "Close a session: write the .closed marker, release the conversation bindings pointing at it and upsert its HISTORY.md row. " +
    "Usage: aw session-close --code <session> [--refs <csv>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCloseInput = {};
    const code = args.values.get("code");
    if (code !== undefined) input.code = code;
    const refs = args.values.get("refs");
    if (refs !== undefined) input.refs = refs;

    // A close that stayed silent about the units the session still holds would
    // be the one way a flow's uncommitted-upstream work disappears from view.
    const data = await runSessionClose(ctx.fs, ctx.paths, input, async () => {
      const listed = await runWorktree(
        { fs: ctx.fs, env: ctx.env, git: ctx.git, paths: ctx.paths },
        { action: "list" },
      );
      return "units" in listed ? listed.units : [];
    });
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    if ("error" in data) return fail(data.code ?? "INVALID_INPUT", data.error, data);
    return { ok: true, data: data.sessionClose, exitCode: 0 };
  },
};
