import { resolveSkills } from "../../application/skills-resolver-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const skillsCommand: QtcCommand = {
  name: "skills",
  describe: "Show resolved capability→skill bindings (skills.toml cascade).",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await resolveSkills(ctx.fs, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};
