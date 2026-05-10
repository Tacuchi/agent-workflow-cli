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

export type ConfirmFn = (message: string) => Promise<boolean>;

const defaultConfirm: ConfirmFn = async (message) => {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: true });
};

function cancelled(): CommandResult<SelfUpdateData> {
  return {
    ok: true,
    data: { command: "(cancelled)", exit_code: 0, stdout: "", stderr: "" },
    exitCode: 0,
  };
}

export async function selfUpdate(
  args: ParsedArgs,
  ctx: CliContext,
  confirm: ConfirmFn = defaultConfirm,
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

  // Optional TTY confirm. Inquirer throws `ExitPromptError` when the user
  // force-closes the prompt (Ctrl-C / Esc); treat that as a plain cancel
  // instead of letting it bubble up as UNHANDLED.
  if (process.stdout.isTTY === true) {
    let ok: boolean;
    try {
      ok = await confirm(`Run \`npm install -g ${ctx.runtime.packageName}@latest\`?`);
    } catch {
      return cancelled();
    }
    if (!ok) return cancelled();
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
