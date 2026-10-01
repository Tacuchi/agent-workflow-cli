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
  /**
   * The refusal for a command whose public contract is not the CLI-wide
   * `{ ok, error }` envelope, so it keeps its own protocol and exit code.
   */
  refuse?(message: string): CommandResult;
}

/** What `--help` says about one flag. */
export interface FlagHelp {
  /** Placeholder of its value, e.g. `<code>` or `human|json`; absent for a switch. */
  value?: string;
  /** What passing it does. */
  effect: string;
}

/**
 * The help of a command or of one of its actions: everything an agent needs to
 * invoke it and read its output, in English. The usage line is generated from
 * it and from the flag contract, so it can never name a flag the command
 * refuses.
 */
export interface HelpContract {
  /** One sentence: what it is for. A command's purpose is also its line in `aw --help`. */
  purpose: string;
  /** Positional arguments as the usage line shows them, e.g. `<plan>`. */
  args?: string;
  /** One entry per flag this scope declares in its contract. */
  flags?: Readonly<Record<string, FlagHelp>>;
  /** Shape of the JSON `data` on success. A command whose actions carry it may omit it. */
  output?: string;
  /** Exit codes that differ from the common contract, keyed by code. */
  exit_codes?: Readonly<Record<string, string>>;
  /** Protocol details the flags alone do not say, one paragraph each. */
  notes?: readonly string[];
}

export interface CommandHelp extends HelpContract {
  /** One contract per action (the command's first positional). */
  actions?: Readonly<Record<string, HelpContract>>;
}

export interface HumanRenderContext {
  /** `--detail` was requested: widen the projection. Never changes the domain. */
  detail: boolean;
}

export interface CliCommand<O = unknown> {
  name: string;
  help: CommandHelp;
  /**
   * The host runs it as a hook. `aw --help` lists hook targets apart from the
   * commands an agent calls; `mode: "warn"` alone does not say it, since stdio
   * servers warn too.
   */
  hook?: true;
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
   * Optional JSON projection of a successful result's `data`. A command that
   * omits it emits the same model with or without `--detail`; one that narrows
   * its default JSON keeps the whole model for `--detail`.
   */
  projectJson?(data: O, context: HumanRenderContext): unknown;
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
