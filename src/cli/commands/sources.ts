import { runSources } from "../../application/sources-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sourcesCommand: CliCommand = {
  name: "sources",
  flags: { known: ["scope", "no-git", "verbose"] },
  help: {
    purpose: "List the hub's declared sources with their Git state and expected branches.",
    flags: {
      scope: { value: "<alias,...>", effect: "Only these sources, comma separated." },
      "no-git": { effect: "Skip the Git enrichment." },
      verbose: { effect: "Include every field of each source." },
    },
    output:
      "{sources[] {alias, path, expected_work_branch, current_branch, match, dirty, changed_files[], is_repo, error, ...}, working_branches_from_status, cross_source_consistent, divergent_sources[] {alias, current, expected}, doc_branch_unreadable?, session_code?, scope?}.",
    notes: ["Read-only."],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const scopeRaw = args.values.get("scope");
    const skipGit = args.flags.has("--no-git");
    const verbose = args.flags.has("--verbose");
    const input: Parameters<typeof runSources>[4] = {};
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
