// opencode's hook artifact is CODE, not config: a module in its plugin dir that
// returns a hook map. Two consequences shape everything below.
//
// First, the module has to bridge two vocabularies. opencode calls its tools
// `edit`, `write`, `bash`; our hooks read a Claude-shaped payload
// (`tool_name`/`tool_input`) and act only on names they know, so a plugin that
// forwarded opencode's own names would call the CLI and be told "not my tool" —
// a guard that runs and never guards. The bridge below is what makes the call
// mean the same thing on both sides, and a tool with no bridge is DECLARED, not
// forwarded and hoped for.
//
// Second, only `tool.execute.before` exists here: no session start or end, no
// compaction. The enforcement travels and the resumability does not, and the
// generated file says so in its own header rather than leaving a reader to
// assume parity.
//
// Verified against opencode 1.18.15: its embedded plugin doc (`Plugin = (input,
// options?) => Promise<Hooks>`, loaded from `.opencode/plugin/`), its hook
// surface, and its tool ids.

import type { HookSkip } from "./hooks-dialect.js";
import type { HookEntry, HooksTemplate } from "./install-hooks.js";

/** The file we write, and the only one we ever remove. */
export const OPENCODE_PLUGIN_FILE = "agent-workflow.js";

/** First line of the generated module — what says a file on disk is ours. */
export const OPENCODE_PLUGIN_MARKER = "// agent-workflow (Workline) — generated plugin";

/**
 * opencode tool id → the Claude tool name our hooks recognise, plus the arg key
 * that carries the subject and the payload key it has to arrive under.
 */
const TOOL_BRIDGE: Readonly<Record<string, { as: string; from: string; into: string }>> = {
  edit: { as: "Edit", from: "filePath", into: "file_path" },
  write: { as: "Write", from: "filePath", into: "file_path" },
  apply_patch: { as: "Edit", from: "filePath", into: "file_path" },
  bash: { as: "Bash", from: "command", into: "command" },
};

/** Our template matchers, as the opencode tool ids they really mean. */
const MATCHER_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "Edit|Write|MultiEdit|NotebookEdit": ["edit", "write", "apply_patch"],
  Bash: ["bash"],
};

interface Guard {
  tools: readonly string[];
  command: string;
  timeout: number;
}

export interface OpencodePlugin {
  /** The module's exact bytes. */
  source: string;
  /** The commands that made it in, in template order. */
  carried: string[];
  /** What did not, and why. Never empty silently. */
  skipped: HookSkip[];
}

/** Builds the plugin module from the same template every other host adapts. */
export function buildOpencodePlugin(template: HooksTemplate): OpencodePlugin {
  const guards: Guard[] = [];
  const skipped: HookSkip[] = [];

  for (const [event, groups] of Object.entries(template.hooks)) {
    if (event !== "PreToolUse") {
      skipped.push({
        event,
        reason:
          "the opencode plugin API fires no session or compaction event, so this hook has nowhere to run",
      });
      continue;
    }
    for (const group of groups as HookEntry[]) {
      for (const hook of group.hooks ?? []) {
        const outcome = bridgeHook(group, hook);
        if (typeof outcome === "string") skipped.push({ event, reason: outcome });
        else guards.push(outcome);
      }
    }
  }

  return {
    source: render(guards, skipped),
    carried: guards.map((g) => g.command),
    skipped,
  };
}

/** The guard this hook becomes here, or the reason it cannot become one. */
function bridgeHook(group: HookEntry, hook: HookEntry["hooks"][number]): Guard | string {
  if (typeof hook.command !== "string" || hook.command.length === 0) {
    return `hook of type '${hook.type}' has no command to run`;
  }
  // No matcher already means "every tool" on both sides, so it becomes every
  // tool this plugin can bridge — never a skip.
  const matcher = group.matcher ?? "";
  const tools = matcher.trim().length === 0 ? Object.keys(TOOL_BRIDGE) : MATCHER_TOOLS[matcher];
  if (tools === undefined) {
    return `matcher '${matcher}' names no opencode tool this plugin can bridge to a Claude-shaped payload, so the guard would run and never guard`;
  }
  return { tools, command: hook.command, timeout: hook.timeout ?? 15 };
}

/** True when the module at this path is the one WE generated. */
export function isOurOpencodePlugin(source: string): boolean {
  return source.startsWith(OPENCODE_PLUGIN_MARKER);
}

/**
 * The config entry that declares the plugin, added without touching anything
 * else in `opencode.json` — and never twice.
 *
 * Returns the SAME object when it was already declared, so a caller can tell
 * "nothing to write" by identity instead of re-deriving the check.
 */
export function declareOpencodePlugin(
  config: Record<string, unknown>,
  pluginPath: string,
): Record<string, unknown> {
  const declared = Array.isArray(config.plugin) ? config.plugin : [];
  if (declared.includes(pluginPath)) return config;
  return { ...config, plugin: [...declared, pluginPath] };
}

/** Drops our entry from `plugin[]`, leaving every other one where it is. */
export function undeclareOpencodePlugin(
  config: Record<string, unknown>,
  pluginPath: string,
): { value: Record<string, unknown>; removed: boolean } {
  const declared = Array.isArray(config.plugin) ? config.plugin : null;
  if (declared === null || !declared.includes(pluginPath)) return { value: config, removed: false };
  const kept = declared.filter((entry) => entry !== pluginPath);
  if (kept.length > 0) return { value: { ...config, plugin: kept }, removed: true };
  const { plugin: _dropped, ...rest } = config;
  return { value: rest, removed: true };
}

function render(guards: readonly Guard[], skipped: readonly HookSkip[]): string {
  const omissions = skipped.map((s) => ` *   · ${s.event}: ${s.reason}`).join("\n");
  return `${OPENCODE_PLUGIN_MARKER}
// Rewritten by \`agent-workflow self install-hooks --target opencode\`. Do not edit.
/*
 * Carried: PreToolUse → tool.execute.before (${guards.length} guard${guards.length === 1 ? "" : "s"}).
 * Omitted, with its reason:
${omissions.length > 0 ? omissions : " *   · nothing"}
 */
import { spawn } from "node:child_process";

const GUARDS = ${JSON.stringify(guards, null, 2)};

const BRIDGE = ${JSON.stringify(TOOL_BRIDGE, null, 2)};

// The CLI answers in Claude's hook protocol: exit 2 means "blocked", and its
// stderr is the message the person needs. Anything else is a pass — a guard that
// could not run must never look like a refusal.
function ask(guard, payload) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", guard.command], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), guard.timeout * 1000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 2 ? stderr.trim() : null);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export default async () => ({
  "tool.execute.before": async (input, output) => {
    const bridge = BRIDGE[input.tool];
    if (bridge === undefined) return;
    const subject = (output?.args ?? {})[bridge.from];
    if (typeof subject !== "string") return;
    const payload = {
      tool_name: bridge.as,
      tool_input: { [bridge.into]: subject },
      session_id: input.sessionID,
    };
    for (const guard of GUARDS) {
      if (!guard.tools.includes(input.tool)) continue;
      const blocked = await ask(guard, payload);
      if (blocked !== null) throw new Error(blocked);
    }
  },
});
`;
}
