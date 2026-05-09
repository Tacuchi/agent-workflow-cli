import { runSources } from "../../application/sources-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sourcesCommand: QtcCommand = {
  name: "sources",
  describe: "List sources from <NS>-PROJECT block with git status enrichment.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const session = args.values.get("session");
    const scopeRaw = args.values.get("scope");
    const skipGit = args.flags.has("--no-git");
    const flow = args.values.get("flow");
    const verbose = args.flags.has("--verbose");
    const input: Parameters<typeof runSources>[4] = {};
    if (session !== undefined) input.sessionCode = session;
    if (scopeRaw !== undefined) {
      input.scope = scopeRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (skipGit) input.skipGit = true;
    if (flow !== undefined) input.flowOverride = flow;
    if (verbose) input.verbose = true;
    const data = await runSources(ctx.fs, ctx.env, ctx.git, ctx.paths, input);
    return { ok: true, data, exitCode: 0 };
  },
};
