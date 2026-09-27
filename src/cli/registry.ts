import type { CommandResult } from "../domain/types.js";
import type { FlagContract } from "./commands/unknown-flags.js";
import type { ParsedArgs } from "./parser.js";
import type { CliContext } from "./types.js";

/**
 * What an unknown flag costs: `reject` refuses the invocation before it runs;
 * `warn` is for the commands a host runs as a hook, where a non-zero exit stops
 * the host itself (it holds a compaction, blocks a tool call), so the flag is
 * reported on stderr and the command runs as if it were not there.
 */
export type FlagMode = "reject" | "warn";

/** The flags one action (the command's first positional) adds to the common ones. */
export interface ActionFlags extends FlagContract {
  mode?: FlagMode;
}

export interface CommandFlags extends FlagContract {
  mode?: FlagMode;
  /**
   * Per-action contracts. A command whose actions read different flags declares
   * them here, because one contract for the whole command would let an action
   * accept a flag only another action reads.
   */
  actions?: Readonly<Record<string, ActionFlags>>;
  /** The invocation the refusal suggests retrying with. */
  usage?: string;
  /**
   * The refusal for a command whose public contract is not the CLI-wide
   * `{ ok, error }` envelope, so it keeps its own protocol and exit code.
   */
  refuse?(message: string): CommandResult;
}

export interface HumanRenderContext {
  /** `--detail` was requested: widen the projection. Never changes the domain. */
  detail: boolean;
}

export interface CliCommand<O = unknown> {
  name: string;
  describe?: string;
  /** Every flag the command reads, checked once by the dispatcher before `execute`. */
  flags: CommandFlags;
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
  /**
   * Optional machine projection for a command whose public contract is not the
   * CLI-wide `{ ok, error }` envelope. It receives both success and failure so
   * a transport-neutral encoder can remain byte-identical to an MCP response.
   */
  renderRawJson?(result: CommandResult<O>): string;
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
