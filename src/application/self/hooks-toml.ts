// Transformation of the bundled hooks template into Kimi Code's TOML dialect,
// plus the managed-block surgery that keeps the user's own `config.toml`
// untouched around it.
//
// The two formats are NOT interchangeable. Claude nests
// `hooks.<Event>[].hooks[]` with `{type, command, timeout}`; Kimi takes a flat
// array of `[[hooks]]` tables with a STRICT schema — `event` (enum), `matcher`
// (optional), `command` (required), `timeout` (optional int, 1..600 seconds).
// Verified against the shipped v0.29.2 binary (HookDefSchema, .strict()).
//
// Two consequences the transformation has to be honest about, both surfaced in
// the install result instead of being silently dropped:
//
//  1. A `type: "prompt"` hook has no command, so Kimi cannot express it. It is
//     skipped and REPORTED — the capability degrades visibly.
//  2. A matcher only transfers where the two hosts match on the same value.
//     Kimi tests `new RegExp(matcher)` against a per-event value: the TOOL NAME
//     for PreToolUse/PostToolUse (same vocabulary — its built-ins are Edit,
//     Write, Bash, Read, Grep), but the session `source`/`reason` for the
//     lifecycle events, whose vocabulary is NOT ours. Carrying Claude's
//     `"startup|resume|clear"` there would produce a regex that never matches
//     and a hook that silently never fires, so the matcher is dropped for those
//     events — and an absent matcher means "always", which is exactly what that
//     Claude matcher expresses.

import type { HookEntry, HooksTemplate } from "./install-hooks.js";

export const MANAGED_BLOCK_BEGIN =
  "# >>> agent-workflow (Workline) managed hooks — do not edit inside this block >>>";
export const MANAGED_BLOCK_END = "# <<< agent-workflow (Workline) managed hooks <<<";

/** Events whose matcher value is the tool name, so a tool-name regex transfers as-is. */
const TOOL_NAME_MATCH_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse"]);

/**
 * The events Kimi Code accepts, from `HOOK_EVENT_TYPES` in the shipped v0.29.2
 * binary. Its schema is `.strict()` and its config loader drops the WHOLE
 * `hooks` section when one entry fails validation — including the user's own
 * hooks — so an event this host does not know must be skipped here rather than
 * written and left to break their config.
 */
const KIMI_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionResult",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Interrupt",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
]);

/** Kimi's `timeout` bounds (seconds), from its strict schema. */
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 600;

export interface TomlHookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface HookSkip {
  event: string;
  reason: string;
}

export interface HookTransformResult {
  entries: TomlHookEntry[];
  /** What could not be expressed in this host's dialect. Never empty silently. */
  skipped: HookSkip[];
}

/** Flattens the bundled template into Kimi's `[[hooks]]` entries. */
export function hooksTemplateToToml(template: HooksTemplate): HookTransformResult {
  const entries: TomlHookEntry[] = [];
  const skipped: HookSkip[] = [];

  for (const [event, groups] of Object.entries(template.hooks)) {
    if (!KIMI_HOOK_EVENTS.has(event)) {
      skipped.push({
        event,
        reason:
          "Kimi Code does not define this event; writing it would invalidate its whole hooks section",
      });
      continue;
    }
    for (const group of groups as HookEntry[]) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook.command !== "string" || hook.command.length === 0) {
          skipped.push({
            event,
            reason: `hook of type '${hook.type}' has no command — Kimi Code only runs command hooks`,
          });
          continue;
        }
        const matcher = carriedMatcher(event, group.matcher);
        const timeout = clampTimeout(hook.timeout);
        entries.push({
          event,
          ...(matcher === undefined ? {} : { matcher }),
          command: hook.command,
          ...(timeout === undefined ? {} : { timeout }),
        });
      }
    }
  }
  return { entries, skipped };
}

function carriedMatcher(event: string, matcher: string | undefined): string | undefined {
  if (matcher === undefined || matcher.trim().length === 0) return undefined;
  return TOOL_NAME_MATCH_EVENTS.has(event) ? matcher : undefined;
}

function clampTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined || !Number.isFinite(timeout)) return undefined;
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(timeout)));
}

/** TOML basic string — same escaping rules as JSON for the characters we emit. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The managed block, markers included. Ends with a newline. */
export function renderManagedHooksBlock(entries: readonly TomlHookEntry[]): string {
  const lines: string[] = [MANAGED_BLOCK_BEGIN];
  for (const entry of entries) {
    lines.push("[[hooks]]");
    lines.push(`event = ${tomlString(entry.event)}`);
    if (entry.matcher !== undefined) lines.push(`matcher = ${tomlString(entry.matcher)}`);
    lines.push(`command = ${tomlString(entry.command)}`);
    if (entry.timeout !== undefined) lines.push(`timeout = ${entry.timeout}`);
    lines.push("");
  }
  lines.push(MANAGED_BLOCK_END);
  return `${lines.join("\n")}\n`;
}

/**
 * OWNERSHIP IS BY DATA, NOT BY COMMENT.
 *
 * The marked block is for humans reading the file. It cannot be the identity of
 * our entries, because Kimi Code rewrites its own `config.toml` whenever it
 * touches a setting (`kimi provider remove`, an OAuth refresh, …): it
 * re-serializes the parsed config, which keeps the `hooks` array and drops
 * EVERY comment — our markers included. Identity therefore rests on the same
 * signal the Claude side uses: every command we install invokes this CLI.
 *
 * Without this, one routine Kimi command left our hooks armed and unremovable,
 * and every reinstall appended a duplicate set.
 */
// The boundary is whitespace or the closing quote, NOT `\b`: `\b` also matches
// before a hyphen, so `agent-workflow-lookalike` would have counted as ours and
// been deleted from the user's file.
const OUR_COMMAND_RE = /^\s*command\s*=\s*["']agent-workflow(?=[\s"']|$)/;
const HOOK_TABLE_HEADER = "[[hooks]]";
const TOML_KEY_RE = /^\s*[A-Za-z_][\w-]*\s*=/;

/** True when this command line invokes THIS CLI (and not a lookalike binary). */
export function isOurCommand(command: string): boolean {
  const trimmed = command.trimStart();
  return trimmed === "agent-workflow" || trimmed.startsWith("agent-workflow ");
}

export interface HookSweepResult {
  text: string;
  /** How many of our `[[hooks]]` entries were removed. */
  removed: number;
}

/**
 * Removes every `[[hooks]]` entry that is OURS — wherever it sits and whether or
 * not our comment markers survived — plus the markers themselves. Anything else
 * in the file, including hooks the user wrote, is preserved verbatim.
 *
 * The one whitespace liberty it takes: a run of blank lines at end-of-file is
 * collapsed to a single newline, since our appended block always ends the file.
 */
export function stripOurHookEntries(text: string): HookSweepResult {
  const lines = text.split("\n");
  const out: string[] = [];
  let removed = 0;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === MANAGED_BLOCK_BEGIN || trimmed === MANAGED_BLOCK_END) {
      i += 1;
      continue;
    }

    if (trimmed !== HOOK_TABLE_HEADER) {
      out.push(line);
      i += 1;
      continue;
    }

    // A `[[hooks]]` table: its header plus the key lines that follow it.
    const block: string[] = [line];
    let j = i + 1;
    while (j < lines.length && TOML_KEY_RE.test(lines[j] ?? "")) {
      block.push(lines[j] ?? "");
      j += 1;
    }
    const ours = block.some((l) => OUR_COMMAND_RE.test(l));
    if (!ours) {
      out.push(...block);
      i = j;
      continue;
    }
    // Ours: drop it, and with it the blank lines that separated it from the next
    // entry, so repeated install→uninstall cycles cannot grow the file.
    while (j < lines.length && (lines[j] ?? "").trim() === "") j += 1;
    removed += 1;
    i = j;
  }

  let result = out.join("\n");
  if (removed > 0) result = result.replace(/\n+$/, text.endsWith("\n") ? "\n" : "");
  return { text: result, removed };
}

/**
 * How many of our hook entries the file declares, read through a real TOML
 * parse. Format-independent: it sees them whether they are written as
 * `[[hooks]]` tables or re-serialized by the host in any other valid shape.
 * Returns null when the file cannot be parsed.
 */
export function countOurHookEntries(
  text: string,
  parseToml: (t: string) => unknown,
): number | null {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return null;
  }
  const hooks = (parsed as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return 0;
  return hooks.filter((h) => {
    const command = (h as { command?: unknown })?.command;
    return typeof command === "string" && isOurCommand(command);
  }).length;
}

/**
 * Reconciles our hooks in the file: drops every entry of ours that is already
 * there (wherever it is) and appends the current set inside a fresh marked
 * block. Idempotent by construction, and correct even after the host has
 * rewritten the file and erased the markers.
 *
 * The only change to foreign content: a trailing newline added when the file
 * lacked one — without it the block would glue onto the user's last line.
 */
export function upsertManagedHooksBlock(
  text: string,
  entries: readonly TomlHookEntry[],
): { text: string } {
  const swept = stripOurHookEntries(text).text;
  const block = renderManagedHooksBlock(entries);
  if (swept.length === 0) return { text: block };
  return { text: swept.endsWith("\n") ? `${swept}${block}` : `${swept}\n${block}` };
}
