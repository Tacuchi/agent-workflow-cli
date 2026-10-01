import { type NextStep, commandIn, nextStepOf } from "../domain/next-step.js";
import { ALL_COMMANDS } from "./commands/index.js";
import { contractFor, isRuntimeFlag } from "./commands/unknown-flags.js";

/**
 * The typed next step an error carries, computed where the error is emitted so
 * early errors and command errors publish it the same way (spec 061 AC-05).
 */

/** Every spelling of the flag that names a session. */
export const SESSION_FLAGS = ["--code", "--session", "--sesion"] as const;

/** One argv token as a shell reads it back. */
function quoted(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

/** The same invocation with `flag` set to `value`, dropping every alias it had. */
export function retryWith(
  argv: readonly string[],
  flags: readonly string[],
  value: string,
): string {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (flags.includes(token)) {
      i += 1;
      continue;
    }
    if (flags.some((flag) => token.startsWith(`${flag}=`))) continue;
    kept.push(token);
  }
  return ["aw", ...kept.map(quoted), flags[0] as string, quoted(value)].join(" ");
}

/** The runtime flags that take a value, so their value is never read as a positional. */
const RUNTIME_VALUES: ReadonlySet<string> = new Set([
  "--hub",
  "--namespace",
  "--format",
  "--plugin-root",
  "--plugin-version",
  "--compat",
]);

/** The positionals of an invocation: the command first, then its action, if any. */
function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (RUNTIME_VALUES.has(token)) i += 1;
    else if (!token.startsWith("-")) out.push(token);
  }
  return out;
}

/**
 * An invocation that reads its answer from stdin: retrying it is only the same
 * command if the same input is piped again, which a command line cannot say.
 */
function readsStdin(argv: readonly string[]): boolean {
  const [command, action] = positionals(argv);
  if (command === "flow") return action === "submit";
  const staged = command === "persist" || command?.startsWith("export-") === true;
  return staged && (action === "validate" || action === "apply");
}

type Target = (typeof ALL_COMMANDS)[number];

/** The flags an invocation passes, by name. */
function flagsPassed(tokens: readonly string[]): Set<string> {
  return new Set(
    tokens
      .filter((token) => token.startsWith("--"))
      .map((token) => token.slice(2).split("=")[0] as string),
  );
}

/** Whether the positionals left once command, action and flag values are removed cover `args`. */
function argumentsCovered(target: Target, action: string | undefined, tokens: readonly string[]) {
  const args = action === undefined ? target.help.args : target.help.actions?.[action]?.args;
  if (args?.startsWith("<") !== true) return true;
  const takesValue = (flag: string) =>
    (target.help.flags?.[flag] ?? target.help.actions?.[action ?? ""]?.flags?.[flag])?.value !==
    undefined;
  let bare = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (!token.startsWith("--")) bare += 1;
    else if (!token.includes("=") && takesValue(token.slice(2))) i += 1;
  }
  return bare > (action === undefined ? 1 : 2);
}

/**
 * Whether `command` is runnable as written against the CLI's own contract: the
 * command and its action exist, every flag it passes is accepted, and nothing it
 * requires — a flag, one of an exclusive group, a positional — is missing.
 */
export function fitsContract(command: string): boolean {
  const tokens = command.split(/\s+/).slice(1);
  const [name, maybeAction] = tokens;
  const target = ALL_COMMANDS.find((candidate) => candidate.name === name);
  if (target === undefined) return false;
  const actions = target.flags.actions;
  const action =
    maybeAction !== undefined && actions?.[maybeAction] !== undefined ? maybeAction : undefined;
  // A command whose actions carry the output cannot run without one.
  if (actions !== undefined && action === undefined && target.help.output === undefined) {
    return false;
  }
  const own = action === undefined ? undefined : actions?.[action];
  const passed = flagsPassed(tokens);
  const known = contractFor(target.flags, action).known;
  const required = [...(target.flags.required ?? []), ...(own?.required ?? [])];
  const groups = [...(target.flags.exclusive ?? []), ...(own?.exclusive ?? [])];
  return (
    [...passed].every((flag) => known.includes(flag) || isRuntimeFlag(flag)) &&
    required.every((flag) => passed.has(flag)) &&
    groups.every((group) => group.some((flag) => passed.has(flag))) &&
    argumentsCovered(target, action, tokens)
  );
}

/**
 * The next step of a command error: for a real choice between sessions, the
 * same invocation retried with each candidate's `--code` (one is the command,
 * several are alternatives and none is chosen); otherwise the one command its
 * action names, when it fits the contract.
 */
export function nextStepOfError(
  data: unknown,
  argv: readonly string[],
): { action?: string; next_step: NextStep } | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as { action?: unknown; candidates?: unknown; choose?: unknown };
  if (record.choose === true && Array.isArray(record.candidates) && !readsStdin(argv)) {
    const retries = (record.candidates as { folder: string }[]).map((candidate) =>
      retryWith(argv, SESSION_FLAGS, candidate.folder),
    );
    const step = nextStepOf(retries);
    if (step === null) return null;
    return retries.length === 1
      ? { action: `reintentá con \`${retries[0]}\``, next_step: step }
      : { next_step: step };
  }
  if (typeof record.action !== "string") return null;
  const command = commandIn(record.action);
  return command !== null && fitsContract(command) ? { next_step: { command } } : null;
}

/** The next step of a hub that could not be resolved: the same invocation per known root. */
export function nextStepOfRoots(
  roots: readonly string[],
  argv: readonly string[],
): { action: string; next_step: NextStep } | null {
  if (readsStdin(argv)) return null;
  const retries = roots.map((root) => retryWith(argv, ["--hub"], root));
  const step = nextStepOf(retries);
  if (step === null) return null;
  const action =
    retries.length === 1
      ? `reintentá con \`${retries[0]}\``
      : `elegí la raíz: ${retries.map((retry) => `\`${retry}\``).join(" o ")}`;
  return { action, next_step: step };
}
