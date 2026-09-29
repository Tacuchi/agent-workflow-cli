// Evidence the checkout keeps: one normalized extract per cell, built by
// allowlist, because the CLI repo is public. The full transcript stays on the
// person's machine. Every extract passes `privacyViolations` before it is
// written; one that does not is never written.

import { PROBE_MCP } from "./scenario.mjs";

export const FRAGMENT_MAX_LINES = 20;
export const FRAGMENT_MAX_CHARS = 1200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Screen text with the disposable paths named, no ANSI, no trailing blanks. */
export function normalize(text, { root, realHome }) {
  let out = String(text ?? "").replace(ANSI, "");
  if (root)
    out = out
      .replaceAll(`${root}/home`, "<home>")
      .replaceAll(`${root}/workspace`, "<workspace>")
      .replaceAll(root, "<root>");
  if (realHome) out = out.replaceAll(realHome, "<real-home>");
  return out
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The last lines of a step, bounded in lines and characters. */
export function boundedFragment(text) {
  const tail = text.split("\n").slice(-FRAGMENT_MAX_LINES).join("\n");
  return tail.length > FRAGMENT_MAX_CHARS ? tail.slice(tail.length - FRAGMENT_MAX_CHARS) : tail;
}

/**
 * The hook lines of the home's daily log (`~/.workflow/logs/agent-workflow-*.log`,
 * one `<iso> INFO <command…>` per CLI call). Only the event names travel.
 */
export function hookLines(logText) {
  const has = (re) => re.test(logText ?? "");
  return {
    SessionStart: has(/ INFO self namespace\b/),
    PreToolUse: has(/ INFO hook sql-mutation-guard\b/),
    PreCompact: has(/ INFO checkpoint-write\b/),
    PostCompact: has(/ INFO resume-summary\b/),
  };
}

const HOOK_COMMANDS = [
  ["self namespace", "SessionStart"],
  ["hook sql-mutation-guard", "PreToolUse"],
  ["checkpoint-write", "PreCompact"],
  ["resume-summary", "PostCompact"],
];

/** Which binary ran each hook, from the shims' own log: basenames only. */
export function hookBinaries(shimLog) {
  const out = {};
  for (const line of String(shimLog ?? "").split("\n")) {
    const [bin, ...args] = line.trim().split(/\s+/);
    const event = HOOK_COMMANDS.find(([cmd]) => args.join(" ").startsWith(cmd))?.[1];
    if (bin && event) out[event] = bin.split("/").pop();
  }
  return out;
}

/** Whether the shims saw the host run this CLI command (`doctor`, `host-memory`, …). */
export function shimRan(shimLog, command) {
  return String(shimLog ?? "")
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[1] === command);
}

/** recall keeps only each row's state and reason (`aw host-memory --json` → hosts[]). */
export function recallRows(hostMemory) {
  return (hostMemory?.hosts ?? []).map((row) => ({
    host: row.host,
    state: row.state,
    reason: row.reason,
  }));
}

/**
 * One cell's extract. Only these fields exist; a caller cannot add others.
 * `evidence` is reduced to booleans and names per surface.
 */
export function buildExtract({ host, surface, cell, screen, evidence, hostMemory, paths }) {
  const base = {
    host,
    surface,
    run_id: cell.run_id,
    state: cell.state,
    expected: cell.expected,
    observed: cell.observed,
    mode: cell.mode,
    declared_by_doctor: cell.declared_by_doctor,
  };
  if (surface === "host-memory") {
    return {
      ...base,
      rows: recallRows(hostMemory).map((r) => ({ ...r, reason: normalize(r.reason, paths) })),
    };
  }
  return {
    ...base,
    evidence: allowlistedEvidence(surface, evidence ?? {}),
    fragment: boundedFragment(normalize(screen, paths)),
  };
}

function allowlistedEvidence(surface, e) {
  switch (surface) {
    case "commands":
      return { ran: e.ran === true };
    case "structured-choice":
      return { answered: e.answered ?? null, boundaries: [...(e.boundaries ?? [])] };
    case "hooks":
      return { lines: { ...e.lines }, binaries: { ...e.binaries } };
    case "mcp":
      return { tools_listed: e.toolsListed === true, receipt: e.receipt === true };
    case "compaction":
      return {
        pre_compact: e.preCompact === true,
        post_compact: e.postCompact === true,
        checkpoint: e.checkpoint === true,
      };
    default:
      return {};
  }
}

// A dotted domain ending in a letters-only TLD: `claude-code@2.1.284` is a version.
const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/;
// Server names may carry underscores (`mcp__claude_ai_Claude_Docs__batch`).
const MCP_NAME =
  /\bmcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_]|\bmcp_([A-Za-z0-9_-]+?)_(?:execute_sql|search_objects)\b/g;

/**
 * Why an extract may not be written: the real HOME, the user name, an email
 * address, or an MCP server other than the scenario's — by tool-name form, or
 * literally when the caller knows the person's own server names (`foreignMcp`).
 */
export function privacyViolations(
  extract,
  { realHome, username, allowedMcp = [PROBE_MCP.name], foreignMcp = [] },
) {
  const text = JSON.stringify(extract);
  const found = [];
  if (realHome && text.includes(realHome)) found.push("contains the real HOME");
  if (username && username.length >= 3 && new RegExp(`\\b${username}\\b`, "i").test(text)) {
    found.push("contains the user name");
  }
  if (EMAIL.test(text)) found.push("contains an email address");
  for (const m of text.matchAll(MCP_NAME)) {
    const name = m[1] ?? m[2];
    if (!allowedMcp.includes(name)) found.push(`names an MCP outside the scenario: ${name}`);
  }
  for (const name of foreignMcp) {
    if (!allowedMcp.includes(name) && text.includes(name)) {
      found.push(`names an MCP outside the scenario: ${name}`);
    }
  }
  return found;
}

/**
 * A violation reduced to its category — what may be written to the committed
 * matrix: «names an MCP outside the scenario», never the name it found.
 */
export const violationCategory = (violation) => violation.split(":")[0];
