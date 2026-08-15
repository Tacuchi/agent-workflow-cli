import { runSources } from "../../application/sources-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, sessionCodeFlag } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const sourcesCommand: CliCommand = {
  name: "sources",
  describe:
    "List sources from <NS>-PROJECT block with git status enrichment. " +
    "Usage: aw sources [--scope <scope>] [--code <NNN>] [--no-git] [--verbose].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const session = sessionCodeFlag(args);
    if (!session.ok) return fail("INVALID_INPUT", session.message, { error: session.message });
    const scopeRaw = args.values.get("scope");
    const skipGit = args.flags.has("--no-git");
    const verbose = args.flags.has("--verbose");
    const input: Parameters<typeof runSources>[4] = {};
    if (session.code !== undefined) input.sessionCode = session.code;
    if (scopeRaw !== undefined) {
      input.scope = scopeRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (skipGit) input.skipGit = true;
    if (verbose) input.verbose = true;
    const data = await runSources(ctx.fs, ctx.env, ctx.git, ctx.paths, input);
    return { ok: true, data, exitCode: 0 };
  },
};
