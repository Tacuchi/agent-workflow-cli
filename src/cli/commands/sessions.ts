import { type ListSessionsOutput, SessionsService } from "../../application/sessions-service.js";
import {
  type SessionSweepOutput,
  runSessionsSweep,
} from "../../application/sessions-sweep-service.js";
import type { CommandResult, SessionState } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sessionsCommand: CliCommand<ListSessionsOutput | SessionSweepOutput> = {
  name: "sessions",
  flags: { known: ["all", "state", "include-legacy", "verbose", "sweep", "apply"] },
  describe:
    "List sessions with counts and next correlative. " +
    "Usage: aw sessions [--state <estado>] [--all] [--include-legacy] [--verbose].",
  async execute(
    args: ParsedArgs,
    ctx: CliContext,
  ): Promise<CommandResult<ListSessionsOutput | SessionSweepOutput>> {
    if (args.flags.has("--sweep")) {
      const result = await runSessionsSweep(ctx.fs, ctx.paths, args.flags.has("--apply"));
      if ("error" in result)
        return { ok: false, error: { code: "SWEEP_BLOCKED", message: result.error }, exitCode: 1 };
      return { ok: true, data: result, exitCode: 0 };
    }
    if (args.flags.has("--apply"))
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "--apply requiere --sweep" },
        exitCode: 1,
      };
    const includeLegacy = args.flags.has("--include-legacy");
    const verbose = args.flags.has("--verbose");
    const showAll = args.flags.has("--all");
    const stateRaw = args.values.get("state");
    const state: SessionState | "all" | undefined = stateRaw
      ? normalizeState(stateRaw)
      : showAll
        ? "all"
        : undefined;

    const service = new SessionsService(ctx.fs, ctx.env, ctx.paths);
    const data = await service.list({ includeLegacy, verbose, ...(state ? { state } : {}) });

    return { ok: true, data, exitCode: 0 };
  },
};

function normalizeState(value: string): SessionState | "all" {
  const v = value.trim().toLowerCase();
  if (v === "active" || v === "closed" || v === "paused" || v === "abandoned" || v === "all")
    return v;
  throw new Error(`--state must be active|closed|paused|abandoned|all (got '${value}')`);
}
