import type { Flow } from "../domain/types.js";

export interface PluginArgs {
  flow?: Flow;
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
}

const KNOWN_FLOWS: ReadonlySet<string> = new Set(["core", "dev", "design", "analyze"]);

interface PluginFlagSpec {
  flag: string;
  apply(plugin: PluginArgs, value: string): void;
  validate?(value: string): void;
}

const PLUGIN_FLAG_SPECS: readonly PluginFlagSpec[] = [
  {
    flag: "--flow",
    apply: (p, v) => {
      p.flow = v as Flow;
    },
    validate: (v) => {
      if (!KNOWN_FLOWS.has(v)) {
        throw new Error(`--flow requires one of core|dev|design|analyze (got '${v}')`);
      }
    },
  },
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
    ...(state.command !== undefined ? { command: state.command } : {}),
  };
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
    state.values.set(token.slice(2, eq), token.slice(eq + 1));
    state.index += 1;
    return true;
  }
  const next = state.argv[state.index + 1];
  if (next !== undefined && !next.startsWith("-") && !PLUGIN_FLAGS.has(token)) {
    state.values.set(token.slice(2), next);
    state.index += 2;
    return true;
  }
  state.flags.add(token);
  state.index += 1;
  return true;
}
