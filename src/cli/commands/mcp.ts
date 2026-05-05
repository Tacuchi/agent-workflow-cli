import { DbhubLauncherError, runDbhubLauncher } from "../../application/mcp-dbhub-launcher.js";
import type { CommandResult, ExitCode } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { writeStderr } from "../render.js";
import type { CliContext } from "../types.js";

export const mcpCommand: QtcCommand = {
  name: "mcp",
  describe: "MCP server launchers. Subcommands: dbhub <instance>.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (subcommand !== "dbhub") {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "mcp requires subcommand: dbhub <instance>",
        },
        exitCode: 1,
      };
    }
    const instance = args.rest[1];
    if (!instance) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "mcp dbhub requires instance: cert | prod",
        },
        exitCode: 1,
      };
    }

    try {
      const result = await runDbhubLauncher({
        instance,
        deps: {
          env: { ...process.env },
          paths: ctx.paths,
          platform: process.platform,
        },
      });
      return { ok: true, data: undefined, exitCode: clampExit(result.exitCode) };
    } catch (err) {
      if (err instanceof DbhubLauncherError) {
        writeStderr(`${err.message}\n`);
        return { ok: true, data: undefined, exitCode: 1 };
      }
      throw err;
    }
  },
};

function clampExit(code: number): ExitCode {
  if (code === 0) return 0;
  if (code === 2) return 2;
  return 1;
}
