import { type ListSessionsOutput, SessionsService } from "../../application/sessions-service.js";
import type { CommandResult, SessionState } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sessionsCommand: QtcCommand<ListSessionsOutput> = {
  name: "sessions",
  describe: "List sessions in .qtc/sessions/ with counts and next correlative.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ListSessionsOutput>> {
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
  if (v === "active" || v === "closed" || v === "all") return v;
  throw new Error(`--state must be active|closed|all (got '${value}')`);
}
