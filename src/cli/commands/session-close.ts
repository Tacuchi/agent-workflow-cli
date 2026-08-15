import {
  type SessionCloseInput,
  runSessionClose,
} from "../../application/session-close-service.js";
import { runWorktree } from "../../application/worktree-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, failSessionResolution } from "../render.js";
import type { CliContext } from "../types.js";
import { type FlagContract, reviewFlags, unknownFlagMessage } from "./unknown-flags.js";

// `--name` belongs to `session-create`, where it is mandatory; here it names
// nothing, and being ignored is how an invocation that meant something else
// came back as a clean close.
const FLAGS: FlagContract = { known: ["code", "refs"] };

export const sessionCloseCommand: CliCommand = {
  name: "session-close",
  describe:
    "Close a session: write the .closed marker, release the conversation bindings pointing at it and upsert its HISTORY.md row. " +
    "Usage: aw session-close --code <session> [--refs <csv>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const review = reviewFlags(args, FLAGS);
    if (review.unknown.length > 0) {
      return fail("UNKNOWN_FLAG", unknownFlagMessage(review, FLAGS), {
        unknown_flags: review.unknown,
        action: "corregí el flag y reintentá: `aw session-close --code <sesión> [--refs <csv>]`",
      });
    }

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
      // Never the reassuring half: an unreadable list comes back as the error the
      // receipt reports, not as "this session held nothing".
      if (!("units" in listed)) throw new Error(JSON.stringify(listed));
      return listed.units;
    });
    if ("sessionError" in data) return failSessionResolution(data.sessionError);
    if ("error" in data) return fail(data.code ?? "INVALID_INPUT", data.error, data);
    // Unreachable from here on purpose: this surface never asks for the refusal
    // (see `requireIntegrated`). It is handled rather than cast away so the day
    // somebody wires the flag through, the command answers with the remedy
    // instead of crashing on a shape it never expected.
    if ("sessionHeld" in data) {
      return fail("SESSION_UNITS_PENDING", data.sessionHeld.reason, data.sessionHeld);
    }
    return { ok: true, data: data.sessionClose, exitCode: 0 };
  },
};
