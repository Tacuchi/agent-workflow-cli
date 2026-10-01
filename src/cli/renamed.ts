import type { ParsedArgs } from "./parser.js";
import type { ErrorEnvelope } from "./render.js";

/**
 * Names 29.0.0 retired without an alias, each with its replacement.
 *
 * The cut is clean on purpose: answering the old spelling would keep a second
 * name for the hub alive. Refusing it with the replacement is what keeps a
 * script or a host written for 28.x from failing in silence.
 */
const RENAMED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["workspace-init", "hub-init"],
  ["workspace-move", "hub-move"],
  ["workspace-commit", "hub-commit"],
  ["workspace-migrate", "hub-migrate"],
  ["project-md-upsert", "hub-block"],
]);

const RENAMED_FLAGS: ReadonlyMap<string, string> = new Map([
  ["workspace", "hub"],
  ["proyecto", "nombre"],
]);

/** Every flag name the invocation carried, whichever map the parser routed it to. */
function passedFlagNames(parsed: ParsedArgs): Set<string> {
  const names = new Set([...parsed.values.keys(), ...parsed.valuesMulti.keys()]);
  for (const token of parsed.flags) names.add(token.replace(/^--?/, ""));
  return names;
}

function renamed(kind: "command" | "flag", name: string, replacement: string): ErrorEnvelope {
  const [old, now] = kind === "command" ? [name, replacement] : [`--${name}`, `--${replacement}`];
  return {
    code: "RENAMED",
    message: `${old} se renombró a ${now} en 29.0.0; usá ${now}`,
    details: { [kind]: old, replacement: now },
  };
}

/**
 * The refusal an invocation that spells a retired name earns, or `null`.
 *
 * Read from the parsed argv alone, before the hub is resolved: past that point
 * the answer depends on the directory and `hubs.json` has already been written.
 */
export function renamedInvocation(parsed: ParsedArgs): ErrorEnvelope | null {
  const command = parsed.command === undefined ? undefined : RENAMED_COMMANDS.get(parsed.command);
  if (parsed.command !== undefined && command !== undefined)
    return renamed("command", parsed.command, command);
  const flags = passedFlagNames(parsed);
  for (const [name, replacement] of RENAMED_FLAGS)
    if (flags.has(name)) return renamed("flag", name, replacement);
  return null;
}
