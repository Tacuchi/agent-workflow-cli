import { runUpgradeHubMode } from "../../application/upgrade-hub-mode-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const upgradeHubModeCommand: QtcCommand = {
  name: "upgrade-hub-mode",
  describe: "Detect and apply Mode: hub upgrade when ≥2 sources declared.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const dryRun = args.flags.has("--dry-run");
    const data = await runUpgradeHubMode(
      ctx.fs,
      ctx.env,
      ctx.paths,
      dryRun ? { dryRun: true } : {},
      ctx.runtime,
    );
    return { ok: true, data, exitCode: 0 };
  },
};
