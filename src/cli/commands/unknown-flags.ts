import type { ParsedArgs } from "../parser.js";

/**
 * Refusing a flag a command does not know — deliberately, ONE command at a time.
 *
 * The parser accepts any `--anything` and drops it in a map nobody reads, so a
 * mistyped flag runs the command as if it had never been passed and exits 0:
 * `aw session-close --name x --code 001` closes the session and silently
 * ignores the half of the invocation its author cared about. Rejecting unknown
 * flags in the PARSER would be the complete fix, and it is also the one that can
 * break any live invocation in the bundle that passes a flag of more — so the
 * scope here is the two surfaces that write the durable record, whose callers
 * were inventoried first (`--code`/`--refs` for the close, plus
 * `--state`/`--session`/`--date` and the retired `--summary` for the update).
 *
 * A retired flag is NOT unknown: it is accepted and reported, because failing on
 * something this CLI itself told callers to pass would break them for spelling
 * a name we used to require.
 */
export interface FlagContract {
  /** Flag names (no leading `--`) the command reads. */
  known: readonly string[];
  /** Names once accepted and now inert: tolerated, and never silently. */
  retired?: readonly string[];
}

/**
 * Flags every command tolerates because the RUNTIME reads them, not the
 * command: namespace resolution, output projection and help. `-h` never gets
 * this far (main.ts prints help before dispatching) and is listed anyway, so
 * the set answers for itself instead of relying on the caller's order.
 */
const RUNTIME_FLAGS: ReadonlySet<string> = new Set([
  "namespace",
  "format",
  "json",
  "detail",
  "help",
  "version",
  "h",
]);

export interface FlagReview {
  /** Passed, and nothing reads them. Spelled with their `--`, ready to print. */
  unknown: string[];
  /** Passed, accepted for compatibility, and doing nothing. */
  retired: string[];
}

/**
 * Every flag the invocation carried, whichever map the parser routed it to.
 *
 * A flag with a value lands in `values` (or `valuesMulti`), a bare one in
 * `flags` as `--name`; reading only one of the three is how an unknown flag
 * stays invisible depending on whether the caller gave it a value.
 */
function passedFlags(args: ParsedArgs): string[] {
  const names = new Set<string>();
  for (const name of args.values.keys()) names.add(name);
  for (const name of args.valuesMulti.keys()) names.add(name);
  for (const token of args.flags) names.add(token.replace(/^--?/, ""));
  return [...names];
}

export function reviewFlags(args: ParsedArgs, contract: FlagContract): FlagReview {
  const known = new Set(contract.known);
  const retired = new Set(contract.retired ?? []);
  const review: FlagReview = { unknown: [], retired: [] };
  for (const name of passedFlags(args)) {
    if (known.has(name) || RUNTIME_FLAGS.has(name)) continue;
    (retired.has(name) ? review.retired : review.unknown).push(`--${name}`);
  }
  review.unknown.sort();
  review.retired.sort();
  return review;
}

/** The refusal message, naming what the command does accept. */
export function unknownFlagMessage(review: FlagReview, contract: FlagContract): string {
  const accepted = [...contract.known].sort().map((name) => `--${name}`);
  return `${review.unknown.join(", ")} no ${review.unknown.length === 1 ? "es un flag" : "son flags"} de este comando; acepta ${accepted.join(", ")}`;
}
