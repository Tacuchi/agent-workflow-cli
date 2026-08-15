import type { CommandResult } from "../domain/types.js";
import type { ParsedArgs } from "./parser.js";
import type { CliContext } from "./types.js";

export interface HumanRenderContext {
  /** `--detail` was requested: widen the projection. Never changes the domain. */
  detail: boolean;
}

export interface CliCommand<O = unknown> {
  name: string;
  describe?: string;
  execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<O>>;
  /**
   * Optional human projection of the SAME result `execute` returned — the
   * runtime never re-derives anything, it only chooses a projection.
   *
   * A command without this stays JSON in every mode. That is what keeps the
   * migration incremental: the ~35 commands that never opt in behave exactly
   * as they do today, in a terminal and in a pipe alike.
   */
  renderHuman?(result: CommandResult<O>, context: HumanRenderContext): string;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CliCommand>();

  register(command: CliCommand): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Command '${command.name}' is already registered`);
    }
    this.commands.set(command.name, command);
  }

  resolve(name: string): CliCommand | undefined {
    return this.commands.get(name);
  }

  list(): string[] {
    return [...this.commands.keys()].sort();
  }
}
