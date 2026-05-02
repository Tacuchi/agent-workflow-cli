import { runHistoryUpdate } from "../../application/history-update-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const historyUpdateCommand: QtcCommand = {
  name: "history-update",
  describe: "Upsert a row in .qtc/HISTORY.md.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const state = args.values.get("state");
    const sesion = args.values.get("sesion");
    const date = args.values.get("date");
    const summary = args.values.get("summary");
    const refs = args.values.get("refs");

    const input: Parameters<typeof runHistoryUpdate>[2] = {};
    if (code !== undefined) input.code = code;
    if (state !== undefined) input.state = state;
    if (sesion !== undefined) input.sesionName = sesion;
    if (date !== undefined) input.date = date;
    if (summary !== undefined) input.summary = summary;
    if (refs !== undefined) input.refs = refs;

    const data = await runHistoryUpdate(ctx.fs, ctx.env, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data, exitCode: 0 };
  },
};
