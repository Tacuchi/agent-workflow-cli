import { runArtifactsCommand } from "../../application/artifacts-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const sessionArtifactsCommand: QtcCommand = {
  name: "session-artifacts",
  describe: "Consolidated dump of a session's artifacts (objetivo + tasks + flags).",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const code = args.values.get("code");
    const verbose = args.flags.has("--verbose");
    const input: { code?: string; verbose?: boolean } = {};
    if (code !== undefined) input.code = code;
    if (verbose) input.verbose = true;
    const data = await runArtifactsCommand(ctx.fs, ctx.env, ctx.paths, input);
    if ("error" in data) {
      return {
        ok: false,
        error: { code: "SESSION_NOT_FOUND", message: data.error },
        data,
        exitCode: 1,
      };
    }
    return { ok: true, data, exitCode: 0 };
  },
};
