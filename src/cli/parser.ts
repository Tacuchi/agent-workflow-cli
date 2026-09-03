export interface PluginArgs {
  pluginRoot?: string;
  pluginVersion?: string;
  compat?: string;
}

export interface ParsedArgs {
  command?: string;
  rest: string[];
  plugin: PluginArgs;
  flags: Set<string>;
  values: Map<string, string>;
  valuesMulti: Map<string, string[]>;
}

/**
 * Value of `--<name>` regardless of routing: MULTI_VALUE_FLAGS land in
 * `valuesMulti` (last occurrence wins), the rest in `values`. Commands that
 * read only `values` silently lose multi-routed flags like `--source`.
 */
export function flagValue(args: ParsedArgs, name: string): string | undefined {
  const multi = args.valuesMulti.get(name);
  if (multi !== undefined && multi.length > 0) return multi[multi.length - 1];
  return args.values.get(name);
}

/**
 * The session a command is being pointed at: `--code`, with `--session` as its
 * surviving alias.
 *
 * One reader for every surface that names a session, because the two spellings
 * were a real divergence and not a cosmetic one: `aw worktree` took `--code`
 * while `aw check-branch` took `--session`, so the same conversation asking "is
 * this my tree?" and "give me my tree" had to spell its own identity two ways —
 * and a flag that lands nowhere is silently no identity at all, which is the
 * failure mode the isolation check must not have.
 *
 * Two spellings that DISAGREE are refused rather than arbitrated: picking either
 * would mean writing in, or verifying, the wrong flow's tree.
 */
export function sessionCodeFlag(
  args: ParsedArgs,
): { ok: true; code?: string } | { ok: false; message: string } {
  const code = args.values.get("code");
  const alias = args.values.get("session");
  if (code !== undefined && alias !== undefined && code !== alias) {
    return {
      ok: false,
      message: `--code dice '${code}' y --session dice '${alias}': nombran sesiones distintas, resolvé cuál corresponde`,
    };
  }
  const chosen = code ?? alias;
  return chosen === undefined ? { ok: true } : { ok: true, code: chosen };
}

// Flag names (without leading `--`) that accept repetition. Each occurrence
// pushes onto `valuesMulti`; non-multi flags continue to use `values` (last
// occurrence wins) for back-compat.
//
// A flag listed here routes to `valuesMulti`, NOT `values` — so a command that
// only wants the single (last) value MUST read it via `flagValue()`, never
// `values.get()`, or it silently sees `undefined`.
const MULTI_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "source",
  "fuente",
  "working-branch",
  "qa-branch",
  // Repeated `--path` (attach/detach-multiroot) and `--pattern` (code-scan).
  "path",
  "pattern",
  // Repeated `--signal` and `--capability` (context-plan): a journey carries as
  // many signals as it carries, and a host declares as many capabilities as it has.
  "signal",
  "capability",
  // Repeated `--input` (capability): an operation takes as many inputs as its
  // descriptor declares, and a single-value routing would keep only the last.
  "input",
  // Repeated `--only` (doctor): the flag names the SET of hosts a run is
  // restricted to. Without this, `aw doctor --only claude-code --only codex`
  // kept the last one and produced a report over ONE host that looks exactly
  // like a complete one — the silent-drop family of `--source`/`--path`.
  "only",
  // Repeated `--select` (doctor prepare/apply): la selección ES un conjunto de
  // hallazgos, y quedarse con el último sellaría un lote de UNA acción
  // indistinguible del que la persona creía estar aprobando.
  "select",
]);

// Flag names (without leading `--`) that are booleans: their presence is the
// value, so they must NEVER consume the following token. Without this the parser
// greedily swallows the next positional — `merge-state --all /repo` loses the
// path and `git-flow --dry-run sync` loses the action. Inventory mirrors every
// `flags.has("--…")` in the repo; keep it in sync when a boolean flag is added.
// (No flag here is ever read via `values.get()`, so routing them to `flags`
// changes no value semantics.)
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "all",
  // The global alias `aw --doctor`. Without it `consumeOptionFlag` eats the next
  // token WITHOUT a leading dash as its value: `aw --doctor extra` would swallow
  // `extra` — the command the person typed — and run the diagnosis instead of
  // reporting an unknown command. A following `--json` was never at risk:
  // `consumeOptionFlag` already refuses a dash-prefixed token as a value.
  "doctor",
  "skip-native",
  "verbose",
  "dry-run",
  "deep",
  "force",
  "strict",
  "init",
  "global",
  "legacy",
  "reopen",
  "read",
  "clear",
  "yes",
  "version",
  "help",
  "with-hooks",
  "skill-only",
  "no-commands",
  "no-open",
  "no-hooks",
  "no-git",
  "no-closed",
  "keep-legacy",
  "keep-cache",
  "include-graduated",
  "include-legacy",
  "include-recent-closed",
  "can-pause",
  // Presence-only: the operator STATING that no producer is left for a legacy
  // placeholder. Without this the path that follows it would be eaten as its value.
  "confirm-no-producer",
  // `aw flow advance --adopt` is presence-only; without this the verb or the
  // session code that follows it would be swallowed as its value.
  "adopt",
  // `aw workspace-migrate --apply` is presence-only, and the swallow is worse
  // here than a lost positional: the flag would land in `values`, the command
  // would see no `--apply` and print a preview while its author asked for the
  // migration.
  "apply",
  // Output projection (see output-mode.ts). `--format` takes a value and stays
  // out; these two are presence-only and MUST be here or `aw status --json` and
  // `aw resume --detail 009` would swallow the following positional.
  "json",
  "detail",
  "include-docs",
  "from-sources",
  "exported-only",
  "confirm-all",
  "require-approval",
  "skip-claude",
  "skip-codex",
  "skip-warp",
  "skip-oz",
  "standalone-sql",
  "all-connections",
]);

// Plugin flags always consume the next token as their value and land on
// `plugin.<key>` instead of the generic `values` map. A Map (not a plain
// object) so a token like `hasOwnProperty` never resolves via the prototype.
const PLUGIN_FLAG_KEYS = new Map<string, keyof PluginArgs>([
  ["--plugin-root", "pluginRoot"],
  ["--plugin-version", "pluginVersion"],
  ["--compat", "compat"],
]);

interface ParseState {
  argv: string[];
  index: number;
  plugin: PluginArgs;
  flags: Set<string>;
  values: Map<string, string>;
  valuesMulti: Map<string, string[]>;
  rest: string[];
  command?: string;
}

export function parseArgv(argv: string[]): ParsedArgs {
  const state: ParseState = {
    argv,
    index: 0,
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
    rest: [],
  };

  while (state.index < argv.length) {
    consumeToken(state);
  }

  return {
    rest: state.rest,
    plugin: state.plugin,
    flags: state.flags,
    values: state.values,
    valuesMulti: state.valuesMulti,
    ...(state.command !== undefined ? { command: state.command } : {}),
  };
}

function setValue(state: ParseState, key: string, value: string): void {
  if (MULTI_VALUE_FLAGS.has(key)) {
    const existing = state.valuesMulti.get(key);
    if (existing) existing.push(value);
    else state.valuesMulti.set(key, [value]);
    return;
  }
  state.values.set(key, value);
}

function consumeToken(state: ParseState): void {
  const token = state.argv[state.index];
  if (token === undefined) {
    state.index += 1;
    return;
  }

  if (consumePluginFlag(state, token)) return;
  if (consumeCommandIfFirst(state, token)) return;
  if (consumeOptionFlag(state, token)) return;

  // Single-dash help: only `--` tokens become flags, so alias `-h` here or it
  // would fall into `rest` and the command would run instead of showing help.
  if (token === "-h") {
    state.flags.add("-h");
    state.index += 1;
    return;
  }

  state.rest.push(token);
  state.index += 1;
}

function consumePluginFlag(state: ParseState, token: string): boolean {
  const key = PLUGIN_FLAG_KEYS.get(token);
  if (!key) return false;
  const value = state.argv[state.index + 1];
  if (value === undefined) {
    throw new Error(`${token} requires a value`);
  }
  state.plugin[key] = value;
  state.index += 2;
  return true;
}

function consumeCommandIfFirst(state: ParseState, token: string): boolean {
  if (state.command !== undefined || token.startsWith("-")) return false;
  state.command = token;
  state.index += 1;
  return true;
}

function consumeOptionFlag(state: ParseState, token: string): boolean {
  if (!token.startsWith("--")) return false;
  const eq = token.indexOf("=");
  if (eq > 0) {
    setValue(state, token.slice(2, eq), token.slice(eq + 1));
    state.index += 1;
    return true;
  }
  const name = token.slice(2);
  const next = state.argv[state.index + 1];
  // `tool call --input-json -` is an explicit stdin marker, not another flag.
  // Keep this exception narrow: accepting arbitrary dash-prefixed values would
  // make a missing flag value silently consume the next option.
  const acceptsStdinMarker = name === "input-json" && next === "-";
  if (
    next !== undefined &&
    (!next.startsWith("-") || acceptsStdinMarker) &&
    !PLUGIN_FLAG_KEYS.has(token) &&
    !BOOLEAN_FLAGS.has(name)
  ) {
    setValue(state, name, next);
    state.index += 2;
    return true;
  }
  state.flags.add(token);
  state.index += 1;
  return true;
}
