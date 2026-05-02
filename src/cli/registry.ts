import type { CommandResult } from "../domain/types.js";
import type { ParsedArgs } from "./parser.js";
import type { CliContext } from "./types.js";

export interface QtcCommand<O = unknown> {
  name: string;
  describe?: string;
  execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<O>>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, QtcCommand>();

  register(command: QtcCommand): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Command '${command.name}' is already registered`);
    }
    this.commands.set(command.name, command);
  }

  resolve(name: string): QtcCommand | undefined {
    return this.commands.get(name);
  }

  list(): string[] {
    return [...this.commands.keys()].sort();
  }
}
