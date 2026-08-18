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

import type { HookDegradation, HookSkip } from "./hooks-dialect.js";
import { isOurCommand } from "./hooks-dialect.js";
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

export interface HookTransformResult {
  entries: TomlHookEntry[];
  /** What could not be expressed in this host's dialect. Never empty silently. */
  skipped: HookSkip[];
  /** What installed with something dropped. Also never silent. */
  degraded: HookDegradation[];
}

/** Flattens the bundled template into Kimi's `[[hooks]]` entries. */
export function hooksTemplateToToml(template: HooksTemplate): HookTransformResult {
  const entries: TomlHookEntry[] = [];
  const skipped: HookSkip[] = [];
  const degraded: HookDegradation[] = [];

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
        const outcome = convertHook(event, group, hook);
        if (outcome.skip !== undefined) skipped.push(outcome.skip);
        if (outcome.degradation !== undefined) degraded.push(outcome.degradation);
        if (outcome.entry !== undefined) entries.push(outcome.entry);
      }
    }
  }
  return { entries, skipped, degraded };
}

/**
 * One template hook, as at most one entry plus at most one notice.
 *
 * The three outcomes are independent on purpose: a hook can install cleanly, be
 * skipped entirely, or install AND report what it lost. Folding them into two
 * would make the third indistinguishable from one of the others.
 */
function convertHook(
  event: string,
  group: HookEntry,
  hook: HookEntry["hooks"][number],
): { entry?: TomlHookEntry; skip?: HookSkip; degradation?: HookDegradation } {
  if (typeof hook.command !== "string" || hook.command.length === 0) {
    return {
      skip: {
        event,
        reason: `hook of type '${hook.type}' has no command — Kimi Code only runs command hooks`,
      },
    };
  }
  const matcher = carriedMatcher(event, group.matcher);
  const timeout = clampTimeout(hook.timeout);
  const entry: TomlHookEntry = {
    event,
    ...(typeof matcher === "string" ? { matcher } : {}),
    command: hook.command,
    ...(timeout === undefined ? {} : { timeout }),
  };
  // The hook installs; what does not travel is its matcher. Reported because
  // "declared degradation" and "silent drop" are the same bytes on disk and
  // opposite things to a person reading the install output.
  if (matcher === null) {
    return {
      entry,
      degradation: {
        event,
        reason: `matcher '${group.matcher}' not carried — Kimi Code tests it against this event's own vocabulary, not the tool name, so the hook installs without matcher and therefore always fires`,
      },
    };
  }
  return { entry };
}

/**
 * The matcher that travels: the value itself, `undefined` when there was none to
 * carry, or `null` when one existed and had to be dropped.
 *
 * Three outcomes rather than two, because only the third is a degradation to
 * report — a template group with no matcher at all loses nothing.
 */
function carriedMatcher(event: string, matcher: string | undefined): string | undefined | null {
  if (matcher === undefined || matcher.trim().length === 0) return undefined;
  return TOOL_NAME_MATCH_EVENTS.has(event) ? matcher : null;
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
 * The marked block is for humans reading the file — it cannot be the identity of
 * our entries, because Kimi Code rewrites its own `config.toml` whenever it
 * touches a setting (`kimi provider remove`, an OAuth refresh, …): it
 * re-serializes the parsed config, which keeps the `hooks` array and drops EVERY
 * comment, our markers included. Identity therefore rests on `isOurCommand`.
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

/** Every key Kimi's strict hook schema admits. Anything else fails `.strict()`. */
const KIMI_HOOK_KEYS: ReadonlySet<string> = new Set(["event", "matcher", "command", "timeout"]);

/**
 * Why one `[[hooks]]` entry fails Kimi Code's schema, or `null` when it passes.
 *
 * The schema is `.strict()`, and that word is the whole reason this function has
 * to exist: its loader drops the ENTIRE `hooks` section when a single entry fails
 * validation. So the cost of one bad entry is not that entry — it is every hook in
 * the file, ours and the user's alike.
 */
export function kimiHookEntryDefect(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "not a table";
  }
  const record = entry as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !KIMI_HOOK_KEYS.has(key));
  if (unknown.length > 0) {
    return `unknown key(s) ${unknown.join(", ")} — the schema is strict and rejects extras`;
  }
  if (typeof record.event !== "string" || record.event.length === 0) {
    return "'event' is required and must be a string";
  }
  if (!KIMI_HOOK_EVENTS.has(record.event)) {
    return `'${record.event}' is not one of the events Kimi Code defines`;
  }
  if (typeof record.command !== "string" || record.command.length === 0) {
    return "'command' is required and must be a non-empty string";
  }
  if (record.matcher !== undefined && typeof record.matcher !== "string") {
    return "'matcher' must be a string when present";
  }
  return timeoutDefect(record.timeout);
}

/** The one field with a range, kept apart so the schema above reads as a flat list. */
function timeoutDefect(timeout: unknown): string | null {
  if (timeout === undefined) return null;
  if (typeof timeout !== "number" || !Number.isInteger(timeout)) {
    return "'timeout' must be an integer number of seconds when present";
  }
  if (timeout < TIMEOUT_MIN || timeout > TIMEOUT_MAX) {
    return `'timeout' must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} seconds (got ${timeout})`;
  }
  return null;
}

export interface HookSectionDefect {
  /** Position in the file's `hooks` array, so a person can find it. */
  index: number;
  /** Ours, or the user's own. It decides who has to fix it. */
  ours: boolean;
  event: string | null;
  reason: string;
}

export type HooksSectionAudit =
  /** The file does not parse as TOML at all: nothing can be said about its hooks. */
  | { parsed: false; defects: readonly HookSectionDefect[] }
  | { parsed: true; total: number; defects: readonly HookSectionDefect[] };

/**
 * Audits the `hooks` section a file WOULD have, entry by entry.
 *
 * Run against the prospective text before writing it, this is what turns "we
 * transformed our own hooks correctly" into "the section that will exist is one
 * the host will actually load". The two are not the same claim, and the gap
 * between them is destructive: a single invalid entry the USER already had is
 * enough for Kimi to discard the whole section, so writing our hooks next to it
 * silently disarms them — and the install still says "installed".
 */
export function auditHooksSection(
  text: string,
  parseToml: (t: string) => unknown,
): HooksSectionAudit {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return { parsed: false, defects: [] };
  }
  const hooks = (parsed as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return { parsed: true, total: 0, defects: [] };
  const defects: HookSectionDefect[] = [];
  for (const [index, entry] of hooks.entries()) {
    const reason = kimiHookEntryDefect(entry);
    if (reason === null) continue;
    const command = (entry as { command?: unknown } | null)?.command;
    const event = (entry as { event?: unknown } | null)?.event;
    defects.push({
      index,
      ours: typeof command === "string" && isOurCommand(command),
      event: typeof event === "string" ? event : null,
      reason,
    });
  }
  return { parsed: true, total: hooks.length, defects };
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
