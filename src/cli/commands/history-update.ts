import { runHistoryUpdate } from "../../application/history-update-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";
import { type FlagContract, reviewFlags, unknownFlagMessage } from "./unknown-flags.js";

// `--sesion` is the legacy spelling of `--session`; `--summary` died with the
// slim table (the Resumen column was the slug re-spaced) and is tolerated
// because this CLI documented it — but it is reported, never silently dropped.
const FLAGS: FlagContract = {
  known: ["code", "state", "session", "sesion", "date", "refs"],
  retired: ["summary"],
};

export const historyUpdateCommand: CliCommand = {
  name: "history-update",
  describe:
    "Upsert a row in the workspace history file. " +
    "Usage: aw history-update [--code <session>] [--session <n>] [--state <estado>] " +
    "[--refs <csv>] [--date <iso>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const review = reviewFlags(args, FLAGS);
    if (review.unknown.length > 0) {
      return fail("UNKNOWN_FLAG", unknownFlagMessage(review, FLAGS), {
        unknown_flags: review.unknown,
        action:
          "corregí el flag y reintentá: `aw history-update --code <sesión> --state <active|closed>`",
      });
    }

    const code = args.values.get("code");
    const state = args.values.get("state");
    // Canonical flag is --session (matches sources/check-branch); --sesion kept
    // as a legacy alias so any older caller keeps working.
    const sesion = args.values.get("session") ?? args.values.get("sesion");
    const date = args.values.get("date");
    const refs = args.values.get("refs");

    const input: Parameters<typeof runHistoryUpdate>[2] = {};
    if (code !== undefined) input.code = code;
    if (state !== undefined) input.state = state;
    if (sesion !== undefined) input.sesionName = sesion;
    if (date !== undefined) input.date = date;
    if (refs !== undefined) input.refs = refs;

    const data = await runHistoryUpdate(ctx.fs, ctx.paths, input);
    // The identity did not land on one session: the row it would have written is
    // somebody else's, so the refusal carries the candidates instead.
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    if ("error" in data) {
      return fail("INVALID_INPUT", data.error, data);
    }
    return {
      ok: true,
      data: review.retired.length > 0 ? { ...data, ignored_flags: review.retired } : data,
      exitCode: 0,
    };
  },
};
