import { runHistoryUpdate } from "../../application/history-update-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, CommandFlags } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";
import { reviewFlags } from "./unknown-flags.js";

// `--sesion` is the legacy spelling of `--session`; `--summary` died with the
// slim table (the Resumen column was the slug re-spaced) and is tolerated
// because this CLI documented it — but it is reported, never silently dropped.
const FLAGS: CommandFlags = {
  known: ["code", "state", "session", "sesion", "date", "refs"],
  retired: ["summary"],
  usage:
    "aw history-update --code <sesión> --state <active|closed|abierta|activa|cerrada|pausada|abandonada>",
};

export const historyUpdateCommand: CliCommand = {
  name: "history-update",
  flags: FLAGS,
  describe:
    "Upsert a row in the workspace history file. " +
    "Usage: aw history-update [--code <session>] [--session <n>] [--state <estado>] " +
    "[--refs <csv>] [--date <iso>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    // The dispatcher already refused an unknown flag; a retired one reaches
    // here and is reported back instead of dropped.
    const { retired } = reviewFlags(args, FLAGS);

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
      data: retired.length > 0 ? { ...data, ignored_flags: retired } : data,
      exitCode: 0,
    };
  },
};
