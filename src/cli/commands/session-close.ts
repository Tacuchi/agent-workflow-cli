import {
  type SessionCloseInput,
  runSessionClose,
} from "../../application/session-close-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const sessionCloseCommand: QtcCommand = {
  name: "session-close",
  describe:
    "Close a session: write the .closed marker and upsert its HISTORY.md row. " +
    "Usage: aw session-close [--code <session>] [--refs <csv>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCloseInput = {};
    const code = args.values.get("code");
    if (code !== undefined) input.code = code;
    const refs = args.values.get("refs");
    if (refs !== undefined) input.refs = refs;

    const data = await runSessionClose(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return fail("INVALID_INPUT", data.error, data);
    }
    return { ok: true, data: data.sessionClose, exitCode: 0 };
  },
};
