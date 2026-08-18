// Transformation of the bundled hooks template into the two JSON dialects that
// are NOT Claude's, plus the ownership surgery each one needs.
//
// Neither host is a copy of the Claude file, and neither is a copy of the other:
//
//  · Crush keeps `hooks` inside `crush.json` as `<Event> → HookConfig[]`, where a
//    HookConfig is FLAT — `{command, matcher?, timeout?}` — and only `PreToolUse`
//    exists (verified against the v0.89.0 binary: its embedded skill doc and its
//    own JSON schema, `config.HookConfig`).
//  · agy keeps ONE `hooks.json` whose top-level keys are hook NAMES, each mapping
//    to per-event config: `PreToolUse`/`PostToolUse` use Claude's `matcher`+`hooks`
//    grouping, `PreInvocation`/`PostInvocation`/`Stop` are flat handler lists, and
//    `enabled: false` disables a named hook (verified against agy 1.0.16's bundled
//    customization doc).
//
// What both share with the Kimi transform is the thing that matters: a matcher
// only travels when it means the same thing on the other side. Ours name Claude's
// tools (`Bash`, `Edit`); crush's are `bash`, `edit`, `write`, and agy's are its
// step types lowercased (`run_command`, `file_change`). Carrying ours verbatim
// would install a hook that never fires, and dropping the matcher would install
// one that fires on every tool — so an untranslatable matcher SKIPS its hook and
// says so.

import type { HookSkip } from "./hooks-dialect.js";
import { isOurCommand } from "./hooks-dialect.js";
import type { HookEntry, HooksTemplate } from "./install-hooks.js";

/** The only template event either host can carry. */
const CARRIED_EVENT = "PreToolUse";

type HookJsonHost = "crush" | "agy";

/** Why the other four template events have nowhere to go, per host. */
const NO_EVENT: Readonly<Record<HookJsonHost, string>> = {
  crush: "crush supports only PreToolUse, so this event has nowhere to go",
  agy: "agy has no equivalent event: its Stop fires at the end of every turn, not at session close, and it exposes no compaction event",
};

/** The named hook agy's `hooks.json` keeps ours under. */
export const AGY_HOOK_NAME = "agent-workflow";

/**
 * Our template's tool matchers in each host's own tool vocabulary.
 *
 * Keyed by the template's matcher verbatim so a matcher that changes in the
 * bundle stops being translated instead of being translated wrongly — the
 * transform then skips its hook and reports it, which is the loud failure.
 */
const TOOL_MATCHERS: Readonly<Record<string, { crush: string; agy: string }>> = {
  // crush: edit · write · multiedit (no notebook tool). agy: file_change · edit_notebook.
  "Edit|Write|MultiEdit|NotebookEdit": {
    crush: "^(edit|write|multiedit)$",
    agy: "^(file_change|edit_notebook)$",
  },
  // crush names MCP tools `mcp_<server>_<tool>`; agy's SQL step is `cloud_sql_execute_sql`.
  "mcp__.*__execute_sql": { crush: "^mcp_.*_execute_sql$", agy: "^.*execute_sql$" },
  Bash: { crush: "^bash$", agy: "^run_command$" },
};

export interface CrushHookConfig {
  command: string;
  matcher?: string;
  timeout?: number;
}

/** agy's handler object — `type` is optional in the host and always written here. */
export interface AgyHookHandler {
  type: "command";
  command: string;
  timeout?: number;
}

export interface AgyHookGroup {
  matcher?: string;
  hooks: AgyHookHandler[];
}

export interface AgyNamedHook {
  enabled?: boolean;
  PreToolUse?: AgyHookGroup[];
}

export interface JsonHookTransform<T> {
  /** The artifact's own shape — empty when nothing survived the dialect. */
  emitted: T;
  /**
   * What could not be expressed in this host's dialect. Never empty silently.
   *
   * There is no `degraded` counterpart here, unlike the TOML transform: in these
   * two dialects a hook either travels whole or is skipped, so a third outcome
   * would be a field no branch can ever fill.
   */
  skipped: HookSkip[];
}

/** Flattens the bundled template into crush's `hooks` map. */
export function hooksTemplateToCrush(
  template: HooksTemplate,
): JsonHookTransform<Record<string, CrushHookConfig[]>> {
  const entries: CrushHookConfig[] = [];
  const skipped = collect(template, "crush", (matcher, hook) => {
    entries.push({
      ...(matcher === undefined ? {} : { matcher }),
      command: hook.command as string,
      ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
    });
  });
  return { emitted: entries.length === 0 ? {} : { [CARRIED_EVENT]: entries }, skipped };
}

/** Flattens the bundled template into agy's single named hook. */
export function hooksTemplateToAgy(
  template: HooksTemplate,
): JsonHookTransform<AgyNamedHook | null> {
  const groups: AgyHookGroup[] = [];
  const skipped = collect(template, "agy", (matcher, hook) => {
    groups.push({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [
        {
          type: "command",
          command: hook.command as string,
          ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
        },
      ],
    });
  });
  return { emitted: groups.length === 0 ? null : { PreToolUse: groups }, skipped };
}

/**
 * The one walk both dialects share: everything that is not `PreToolUse` is
 * skipped with its reason, and every surviving hook is handed back with the
 * matcher this host understands.
 */
function collect(
  template: HooksTemplate,
  host: HookJsonHost,
  emit: (matcher: string | undefined, hook: HookEntry["hooks"][number]) => void,
): HookSkip[] {
  const skipped: HookSkip[] = [];
  for (const [event, groups] of Object.entries(template.hooks)) {
    if (event !== CARRIED_EVENT) {
      skipped.push({ event, reason: NO_EVENT[host] });
      continue;
    }
    for (const reason of carry(groups as HookEntry[], host, emit)) {
      skipped.push({ event, reason });
    }
  }
  return skipped;
}

/** The `PreToolUse` groups, emitted one by one; the refusals come back as reasons. */
function carry(
  groups: readonly HookEntry[],
  host: HookJsonHost,
  emit: (matcher: string | undefined, hook: HookEntry["hooks"][number]) => void,
): string[] {
  const refusals: string[] = [];
  for (const group of groups) {
    const matcher = translateMatcher(group.matcher, host);
    for (const hook of group.hooks ?? []) {
      const refusal = refuse(group, hook, matcher);
      if (refusal === null) emit(matcher ?? undefined, hook);
      else refusals.push(refusal);
    }
  }
  return refusals;
}

/** Why this hook cannot travel, or `null` when it can. */
function refuse(
  group: HookEntry,
  hook: HookEntry["hooks"][number],
  matcher: string | undefined | null,
): string | null {
  if (typeof hook.command !== "string" || hook.command.length === 0) {
    return `hook of type '${hook.type}' has no command — this host only runs command hooks`;
  }
  if (matcher === null) {
    return `matcher '${group.matcher}' has no equivalent in this host's tool names; carrying it would install a hook that never fires and dropping it would fire on every tool`;
  }
  return null;
}

/**
 * The matcher that travels: the host's own regex, `undefined` when the group had
 * none (which already means "every tool" on both sides), or `null` when one
 * existed and cannot be translated.
 */
function translateMatcher(
  matcher: string | undefined,
  host: "crush" | "agy",
): string | undefined | null {
  if (matcher === undefined || matcher.trim().length === 0) return undefined;
  const translation = TOOL_MATCHERS[matcher];
  return translation === undefined ? null : translation[host];
}

export interface JsonHookSweep<T> {
  value: T;
  /** How many of OUR entries were removed. */
  removed: number;
  /** How many entries were left because they are not ours. */
  preserved: number;
}

/**
 * Removes our entries from a parsed `crush.json`, per ENTRY and never per event:
 * a user with their own `PreToolUse` hook keeps it. An event left with nothing,
 * and a `hooks` key left with no event, are dropped so repeated cycles cannot
 * grow the file.
 */
export function stripOurCrushHooks(
  config: Record<string, unknown>,
): JsonHookSweep<Record<string, unknown>> {
  const hooks = asRecord(config.hooks);
  if (hooks === null) return { value: config, removed: 0, preserved: 0 };

  const next: Record<string, unknown> = {};
  let removed = 0;
  let preserved = 0;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      next[event] = value;
      continue;
    }
    const kept = value.filter((entry) => !isOurHookEntry(entry));
    removed += value.length - kept.length;
    preserved += kept.length;
    if (kept.length > 0) next[event] = kept;
  }
  if (removed === 0) return { value: config, removed: 0, preserved };

  const { hooks: _dropped, ...rest } = config;
  const value =
    Object.keys(next).length > 0 ? ({ ...rest, hooks: next } as Record<string, unknown>) : rest;
  return { value, removed, preserved };
}

/**
 * Removes our named hook from a parsed `hooks.json`, and only when EVERY command
 * under it is ours. A named hook someone else wrote under the same name is left
 * alone: the name is where we put ours, never proof that ours is what is there.
 */
export function stripOurAgyHooks(
  doc: Record<string, unknown>,
): JsonHookSweep<Record<string, unknown>> {
  const named = asRecord(doc[AGY_HOOK_NAME]);
  const preserved = Object.keys(doc).length - (named === null ? 0 : 1);
  if (named === null) return { value: doc, removed: 0, preserved };

  const commands = agyCommands(named);
  if (commands.length === 0 || !commands.every(isOurCommand)) {
    return { value: doc, removed: 0, preserved: preserved + 1 };
  }
  const { [AGY_HOOK_NAME]: _ours, ...rest } = doc;
  return { value: rest, removed: commands.length, preserved };
}

/** How many of our hook entries a parsed `crush.json` declares. */
export function countOurCrushHooks(config: Record<string, unknown>): number {
  const hooks = asRecord(config.hooks);
  if (hooks === null) return 0;
  let count = 0;
  for (const value of Object.values(hooks)) {
    if (Array.isArray(value)) count += value.filter(isOurHookEntry).length;
  }
  return count;
}

/** How many of our hook handlers a parsed `hooks.json` declares under our name. */
export function countOurAgyHooks(doc: Record<string, unknown>): number {
  const named = asRecord(doc[AGY_HOOK_NAME]);
  if (named === null) return 0;
  return agyCommands(named).filter(isOurCommand).length;
}

function agyCommands(named: Record<string, unknown>): string[] {
  const groups = named[CARRIED_EVENT];
  if (!Array.isArray(groups)) return [];
  const out: string[] = [];
  for (const group of groups) {
    const hooks = asRecord(group)?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const command = asRecord(hook)?.command;
      if (typeof command === "string") out.push(command);
    }
  }
  return out;
}

/** True when this flat `{command, …}` entry is one WE installed. */
export function isOurHookEntry(entry: unknown): boolean {
  const command = asRecord(entry)?.command;
  return typeof command === "string" && isOurCommand(command);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
