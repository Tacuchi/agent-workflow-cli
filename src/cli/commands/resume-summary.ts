import {
  type ResumeSummaryOptions,
  runResumeSummary,
} from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin, resolveContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const resumeSummaryCommand: CliCommand = {
  name: "resume-summary",
  flags: {
    known: ["code", "include-recent-closed", "recent-days"],
    retired: ["can-pause"],
    mode: "warn",
  },
  hook: true,
  help: {
    purpose:
      "PostCompact hook target: return the compact resume payload of the named or conversation-bound session.",
    flags: {
      code: {
        value: "<code>",
        effect: "Session to summarize; defaults to the one bound to this conversation.",
      },
      "include-recent-closed": {
        effect: "Also list recently closed sessions that produced artifacts.",
      },
      "recent-days": {
        value: "<n>",
        effect: "Window in days for --include-recent-closed; a positive integer, default 7.",
      },
    },
    output:
      "{active_sessions[], primary_session, primary_session_code?, checkpoint_present, checkpoint_path?, checkpoint_status, checkpoint_age_seconds?, unfilled_placeholders[], needs_ai_action, continuity (ok|degraded), instruction, candidates?, action?, refuge?, checkpoint?, recent_closed_with_artifacts?}.",
    notes: [
      "Read-only; it never binds the session it presents. With no resolvable session continuity is degraded and the payload lists the active sessions as candidates (even when only one is active) plus this conversation's refuge, if one was parked.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const options: ResumeSummaryOptions = {};
    if (args.flags.has("--include-recent-closed")) {
      options.includeRecentClosed = true;
    }
    const recentDaysRaw = args.values.get("recent-days");
    if (recentDaysRaw !== undefined) {
      const n = Number.parseInt(recentDaysRaw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return fail(
          "INVALID_INPUT",
          `--recent-days debe ser entero positivo (got '${recentDaysRaw}')`,
        );
      }
      options.recentDays = n;
    }
    const code = args.values.get("code");
    if (code !== undefined) options.code = code;

    // PostCompact delivers the conversation id on stdin; the same command run by
    // hand from a terminal simply has none.
    const context = resolveContextId(ctx.env, await readHookStdin());
    if (!context.ok) return fail(context.code, context.message);
    if (context.contextId !== undefined) options.contextId = context.contextId;

    const data = await runResumeSummary(ctx.fs, ctx.paths, options);
    return { ok: true, data, exitCode: 0 };
  },
};
