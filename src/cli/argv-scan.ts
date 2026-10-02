/**
 * Reads argv without the CLI's parser, for the paths that run before it or
 * after it failed: the thin entry and the parse-error exits. Dependency-free on
 * purpose, so the SQL guard is still recognized when nothing else can load.
 */

/** The first positional of `argv`, skipping global options and their values. */
export function firstCommandToken(argv: readonly string[]): string | undefined {
  const index = firstCommandIndex(argv);
  return index === undefined ? undefined : argv[index];
}

/** Where that first positional sits, so a caller can read what follows it. */
function firstCommandIndex(argv: readonly string[]): number | undefined {
  const globalOptionsWithValue = new Set([
    "--namespace",
    "--plugin-root",
    "--plugin-version",
    "--compat",
    // `tool` always renders its own raw JSON, but this global projection flag
    // can precede it. Skip its value while detecting a parse-time tool error so
    // the CLI never falls back to the generic `{ ok, error }` envelope.
    "--format",
    "--hub",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) return undefined;
    if (globalOptionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--namespace=") ||
      token.startsWith("--hub=") ||
      token.startsWith("--plugin-")
    )
      continue;
    if (token.startsWith("-")) continue;
    return index;
  }
  return undefined;
}

/**
 * The target of `aw hook …`: its first positional, flags before it included,
 * or `undefined` when the command is not `hook`.
 */
export function hookTarget(argv: readonly string[]): string | undefined {
  // Sliced where the command was found: `hook` may also be an earlier flag's value.
  const index = firstCommandIndex(argv);
  if (index === undefined || argv[index] !== "hook") return undefined;
  return firstCommandToken(argv.slice(index + 1));
}
