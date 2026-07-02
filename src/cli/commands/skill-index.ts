import { runSkillIndex } from "../../application/skill-index-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const skillIndexCommand: QtcCommand = {
  name: "skill-index",
  describe:
    "Lazy-load skill index (frontmatter only). " +
    "Usage: aw skill-index [--plugin-root <path>] [--exported-only].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const pluginRoot = args.plugin.pluginRoot ?? args.values.get("plugin-root");
    const exportedOnly = args.flags.has("--exported-only");
    const input: Parameters<typeof runSkillIndex>[2] = {};
    if (pluginRoot !== undefined) input.pluginRoot = pluginRoot;
    if (exportedOnly) input.exportedOnly = true;
    const data = await runSkillIndex(ctx.fs, ctx.env, input);
    return { ok: true, data, exitCode: 0 };
  },
};
