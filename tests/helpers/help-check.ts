import { contractFor } from "../../src/cli/commands/unknown-flags.js";
import type { CliCommand } from "../../src/cli/registry.js";

/** Accepted input values that are Spanish words; flag names are stripped separately. */
const ALLOWED_LITERALS = ["ninguno"];

const SPANISH_WORDS = [
  "de",
  "la",
  "el",
  "los",
  "las",
  "del",
  "que",
  "con",
  "sin",
  "para",
  "una",
  "un",
  "por",
  "se",
  "al",
  "es",
  "y",
  "su",
  "sus",
  "como",
  "cuando",
  "sesión",
  "fuente",
  "rama",
  "si",
];

/** The Spanish that survives once flag names and allowed literals are removed. */
export function spanishIn(text: string): string[] {
  let prose = text.replace(/--[\w-]+/g, " ");
  for (const literal of ALLOWED_LITERALS) prose = prose.replaceAll(literal, " ");
  const accents = prose.match(/[áéíóúñ¿¡]/gi) ?? [];
  const words = SPANISH_WORDS.filter((word) =>
    new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "iu").test(prose),
  );
  return [...new Set(accents), ...words];
}

/**
 * What the declaration of one scope gets wrong, read from the contracts rather
 * than from the text: a rendered row can look complete with an empty effect,
 * and a help entry for a flag the scope does not accept is never rendered.
 */
function declarationProblems(command: CliCommand, action: string | undefined, name: string) {
  const problems = scopeProblems(command.flags.known, command.help.flags ?? {}, name);
  if (action !== undefined) {
    const known = command.flags.actions?.[action]?.known ?? [];
    problems.push(...scopeProblems(known, command.help.actions?.[action]?.flags ?? {}, name));
    return problems;
  }
  for (const declared of Object.keys(command.help.actions ?? {})) {
    if (command.flags.actions?.[declared] === undefined) {
      problems.push(`${name}: help for action ${declared}, which it does not have`);
    }
  }
  return problems;
}

/** One scope: every accepted flag has an effect, and no help names a flag it refuses. */
function scopeProblems(
  known: readonly string[],
  help: Readonly<Record<string, { effect: string }>>,
  name: string,
): string[] {
  const missing = known
    .filter((flag) => (help[flag]?.effect ?? "").trim() === "")
    .map((flag) => `${name}: --${flag} has no effect`);
  const stray = Object.keys(help)
    .filter((flag) => !known.includes(flag))
    .map((flag) => `${name}: help for --${flag}, which it does not accept`);
  return [...missing, ...stray];
}

/**
 * What is wrong with the help text of one command or action, as printed: the
 * rules of plan 082 F2 (spec 061 AC-02, AC-04). Empty when it is complete.
 */
export function helpProblems(command: CliCommand, action: string | undefined, text: string) {
  const name = action === undefined ? command.name : `${command.name} ${action}`;
  const problems: string[] = [];
  const own = action === undefined ? command.help : command.help.actions?.[action];
  if (!text.startsWith(`aw ${name}\n\n`)) problems.push(`${name}: header`);
  if (own === undefined || own.purpose.trim() === "") problems.push(`${name}: no purpose`);
  if (action !== undefined && own?.purpose === command.help.purpose) {
    problems.push(`${name}: repeats its parent's help`);
  }
  const leaf = action !== undefined || command.flags.actions === undefined;
  if (leaf && own?.output === undefined) problems.push(`${name}: no output shape`);
  if (!/^(Human output|Output format): /m.test(text))
    problems.push(`${name}: no human-output line`);
  const accepted = [...contractFor(command.flags, action).known].sort();
  const usage = text.match(/^Usage: (.*)$/m)?.[1] ?? "";
  const inUsage = [...usage.matchAll(/--([\w-]+)/g)].map((match) => match[1] as string).sort();
  if (JSON.stringify(inUsage) !== JSON.stringify(accepted)) {
    problems.push(`${name}: usage names ${inUsage} but accepts ${accepted}`);
  }
  problems.push(...declarationProblems(command, action, name));
  const spanish = spanishIn(text);
  if (spanish.length > 0) problems.push(`${name}: Spanish ${spanish.join(",")}`);
  return problems;
}
