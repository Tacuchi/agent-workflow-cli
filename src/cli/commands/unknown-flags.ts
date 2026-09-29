import type { CommandResult } from "../../domain/types.js";
import { usageLine } from "../help-groups.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, CommandFlags, FlagMode } from "../registry.js";
import { fail } from "../render.js";

/**
 * Refusing a flag a command does not know — once, in the dispatcher.
 *
 * The parser accepts any `--anything` and drops it in a map nobody reads, so a
 * mistyped flag runs the command as if it had never been passed and exits 0.
 * Worse when the command reads stdin: `aw flow submit --file x.json` ignored
 * `--file` and waited on stdin forever. The parser cannot refuse it (it does not
 * know which command runs), so every command declares its flags and the
 * dispatcher checks them before `execute`, which is before any stdin read.
 *
 * A retired flag is NOT unknown: it is accepted, because failing on something
 * this CLI itself told callers to pass would break them for spelling a name we
 * used to require. Reporting it is the command's call: history-update returns it
 * in `ignored_flags`, a hook target stays quiet.
 */
export interface FlagContract {
  /** Flag names (no leading `--`) the command reads. */
  known: readonly string[];
  /** Names once accepted and now inert: tolerated, never refused. */
  retired?: readonly string[];
  /** Help metadata for a flag required by this invocation. */
  required?: readonly string[];
  /** Help metadata for flags of which precisely one must be supplied. */
  exclusive?: readonly (readonly string[])[];
  /** Help metadata for flags the parser collects more than once. */
  repeatable?: readonly string[];
}

/**
 * Flags every command tolerates because the RUNTIME reads them, not the
 * command: namespace resolution, output projection and help. The plugin
 * coordinates (`--plugin-root`, …) are not here: with a space the parser keeps
 * them apart, and the `=` form is not a plugin flag, so it is refused.
 * `--doctor` is not here either: it is an alias only with no command in front,
 * so the `doctor` command declares it and every other command refuses it.
 * `-h` never gets this far (main.ts prints help before dispatching) and is
 * listed anyway, so the set answers for itself instead of relying on the
 * caller's order.
 */
const RUNTIME_FLAGS: ReadonlySet<string> = new Set([
  "namespace",
  "workspace",
  "format",
  "json",
  "detail",
  "ascii",
  "help",
  "version",
  "h",
]);

/** `true` for a flag the runtime reads on every command. */
export function isRuntimeFlag(name: string): boolean {
  return RUNTIME_FLAGS.has(name);
}

export interface FlagReview {
  /** Passed, and nothing reads them. Spelled as the caller typed them, ready to print. */
  unknown: string[];
  /** Passed, accepted for compatibility, and doing nothing. */
  retired: string[];
}

/**
 * Every flag the invocation carried, name → spelling, whichever map the parser
 * routed it to.
 *
 * A flag with a value lands in `values` (or `valuesMulti`), a bare one in
 * `flags` as typed; reading only one of the three is how an unknown flag stays
 * invisible depending on whether the caller gave it a value. A bare `--` is the
 * end-of-options marker, not a flag.
 */
function passedFlags(args: ParsedArgs): Map<string, string> {
  const names = new Map<string, string>();
  for (const name of args.values.keys()) names.set(name, `--${name}`);
  for (const name of args.valuesMulti.keys()) names.set(name, `--${name}`);
  for (const token of args.flags) {
    const name = token.replace(/^--?/, "");
    if (name.length > 0) names.set(name, token);
  }
  return names;
}

export function reviewFlags(args: ParsedArgs, contract: FlagContract): FlagReview {
  const known = new Set(contract.known);
  const retired = new Set(contract.retired ?? []);
  const review: FlagReview = { unknown: [], retired: [] };
  for (const [name, spelling] of passedFlags(args)) {
    if (known.has(name) || isRuntimeFlag(name)) continue;
    (retired.has(name) ? review.retired : review.unknown).push(spelling);
  }
  review.unknown.sort();
  review.retired.sort();
  return review;
}

/** The refusal message, naming what the command does accept. */
export function unknownFlagMessage(review: FlagReview, contract: FlagContract): string {
  const accepted = [...contract.known].sort().map((name) => `--${name}`);
  const subject = `${review.unknown.join(", ")} no ${review.unknown.length === 1 ? "es un flag" : "son flags"} de este comando`;
  return accepted.length > 0
    ? `${subject}; acepta ${accepted.join(", ")}`
    : `${subject}; no acepta flags propios`;
}

/** The contract that applies to this invocation: the common flags plus its action's. */
export function contractFor(
  flags: CommandFlags,
  action: string | undefined,
): FlagContract & { mode: FlagMode } {
  const own = action !== undefined ? flags.actions?.[action] : undefined;
  const retired = [...(flags.retired ?? []), ...(own?.retired ?? [])];
  return {
    known: [...flags.known, ...(own?.known ?? [])],
    ...(retired.length > 0 ? { retired } : {}),
    mode: own?.mode ?? flags.mode ?? "reject",
  };
}

export type FlagGate =
  /** Run the command; `notice` is the stderr line a hook-run command owes. */
  { kind: "run"; notice?: string } | { kind: "refuse"; result: CommandResult };

/** What the dispatcher does with the invocation's flags, before `execute`. */
export function gateFlags(command: CliCommand, args: ParsedArgs): FlagGate {
  const contract = contractFor(command.flags, args.rest[0]);
  const review = reviewFlags(args, contract);
  if (review.unknown.length === 0) return { kind: "run" };
  const message = unknownFlagMessage(review, contract);
  if (contract.mode === "warn") {
    return { kind: "run", notice: `aw ${command.name}: ${message}; se ignora y sigue\n` };
  }
  if (command.flags.refuse !== undefined) {
    return { kind: "refuse", result: command.flags.refuse(message) };
  }
  const usage = usageLine(
    command,
    command.flags.actions?.[args.rest[0] ?? ""] ? args.rest[0] : undefined,
  );
  return {
    kind: "refuse",
    result: fail("UNKNOWN_FLAG", message, {
      unknown_flags: review.unknown,
      action: `corregí el flag y reintentá: \`${usage}\``,
    }),
  };
}
