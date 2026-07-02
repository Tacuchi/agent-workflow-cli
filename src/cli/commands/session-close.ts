import {
  type SessionCloseInput,
  runSessionClose,
} from "../../application/session-close-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sessionCloseCommand: QtcCommand = {
  name: "session-close",
  describe:
    "Close a session: write the .closed marker in the session folder. " +
    "Usage: aw session-close [--code <session>] [--refs <csv>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: SessionCloseInput = {};
    const code = args.values.get("code");
    if (code !== undefined) input.code = code;
    const refs = args.values.get("refs");
    if (refs !== undefined) input.refs = refs;

    const data = await runSessionClose(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data: data.sessionClose, exitCode: 0 };
  },
};
