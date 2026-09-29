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
  required: ["code", "state"],
};

export const historyUpdateCommand: CliCommand = {
  name: "history-update",
  flags: FLAGS,
  help: {
    purpose: "Insert or update one session's row in the workspace history file.",
    flags: {
      code: { value: "<code>", effect: "Session whose row is written." },
      state: {
        value: "<active|closed|paused|abandoned>",
        effect: "State recorded in the row; legacy localized aliases are also accepted.",
      },
      session: { value: "<name>", effect: "Session name recorded in the row." },
      sesion: { value: "<name>", effect: "Legacy alias of --session." },
      date: { value: "<iso>", effect: "Date recorded in the row instead of today." },
      refs: { value: "<csv>", effect: "Comma-separated references recorded in the row." },
    },
    output: "{code, flow, action, state, ignored_flags[]?}.",
    notes: [
      "--summary is retired: it is accepted, does nothing and is reported in ignored_flags. A code that resolves to no single session is refused with the candidates.",
    ],
  },
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
