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

// Flag names (without leading `--`) that accept repetition. Each occurrence
// pushes onto `valuesMulti`; non-multi flags continue to use `values` (last
// occurrence wins) for back-compat.
const MULTI_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "source",
  "fuente",
  "working-branch",
  "qa-branch",
]);

interface PluginFlagSpec {
  flag: string;
  apply(plugin: PluginArgs, value: string): void;
  validate?(value: string): void;
}

const PLUGIN_FLAG_SPECS: readonly PluginFlagSpec[] = [
  {
    flag: "--plugin-root",
    apply: (p, v) => {
      p.pluginRoot = v;
    },
  },
  {
    flag: "--plugin-version",
    apply: (p, v) => {
      p.pluginVersion = v;
    },
  },
  {
    flag: "--compat",
    apply: (p, v) => {
      p.compat = v;
    },
  },
];

const PLUGIN_FLAGS: ReadonlySet<string> = new Set(PLUGIN_FLAG_SPECS.map((s) => s.flag));

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
  const spec = PLUGIN_FLAG_SPECS.find((s) => s.flag === token);
  if (!spec) return false;
  const value = state.argv[state.index + 1];
  if (value === undefined) {
    throw new Error(`${spec.flag} requires a value`);
  }
  spec.validate?.(value);
  spec.apply(state.plugin, value);
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
  const next = state.argv[state.index + 1];
  if (next !== undefined && !next.startsWith("-") && !PLUGIN_FLAGS.has(token)) {
    setValue(state, token.slice(2), next);
    state.index += 2;
    return true;
  }
  state.flags.add(token);
  state.index += 1;
  return true;
}
