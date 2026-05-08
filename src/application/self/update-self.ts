import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult, ExitCode } from "../../domain/types.js";

export interface SelfUpdateData {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  would_run?: boolean;
}

export async function selfUpdate(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfUpdateData>> {
  const npmArgs = ["install", "-g", `${ctx.runtime.packageName}@latest`];
  const cmdString = `npm ${npmArgs.join(" ")}`;

  if (args.flags.has("--dry-run")) {
    return {
      ok: true,
      data: { command: cmdString, exit_code: 0, stdout: "", stderr: "", would_run: true },
      exitCode: 0,
    };
  }

  // Optional TTY confirm
  if (process.stdout.isTTY === true) {
    const { confirm } = await import("@inquirer/prompts");
    const ok = await confirm({
      message: `Run \`npm install -g ${ctx.runtime.packageName}@latest\`?`,
      default: true,
    });
    if (!ok) {
      return {
        ok: true,
        data: { command: "(cancelled)", exit_code: 0, stdout: "", stderr: "" },
        exitCode: 0,
      };
    }
  }

  const result = await ctx.process.run("npm", npmArgs, {});
  const code = result.code as ExitCode;
  return {
    ok: result.code === 0,
    data: {
      command: cmdString,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    exitCode: code === 0 || code === 1 || code === 2 ? code : 1,
  };
}
