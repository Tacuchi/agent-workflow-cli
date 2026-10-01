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
    PreCompact: has(/ INFO hook pre-compact\b/),
    PostCompact: has(/ INFO hook post-compact\b/),
  };
}

const HOOK_COMMANDS = [
  ["self namespace", "SessionStart"],
  ["hook sql-mutation-guard", "PreToolUse"],
  ["hook pre-compact", "PreCompact"],
  ["hook post-compact", "PostCompact"],
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
  { realHome, username, allowedMcp = [PROBE_MCP.name], foreignMcp = [], secrets = [] },
) {
  const text = JSON.stringify(extract);
  const found = [];
  if (containsSecret(text, secrets)) found.push("contains a token");
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

/** How much of a token betrays it: 12 characters of its distinctive part. */
export const SECRET_PREFIX = 12;

/**
 * Prefixes every token of a kind shares, which therefore identify nobody:
 * claude OAuth (`sk-ant-oat01-`) and API keys (`sk-ant-api03-`), Google keys (`AIza`).
 */
export const PUBLIC_TOKEN_PREFIXES = ["sk-ant-oat01-", "sk-ant-api03-", "AIza"];

/**
 * The part of a token that is its own: what follows a known public prefix,
 * first SECRET_PREFIX characters (or all of a shorter remainder).
 */
export function distinctivePart(value) {
  const prefix = PUBLIC_TOKEN_PREFIXES.find((p) => value.startsWith(p)) ?? "";
  const rest = value.slice(prefix.length);
  return rest.length > SECRET_PREFIX ? rest.slice(0, SECRET_PREFIX) : rest;
}

const usable = (secrets) => secrets.filter((v) => typeof v === "string" && v.length > 0);

/**
 * Credential shapes redacted whatever the run was given: a host's own output can
 * carry one it minted (an OAuth code agy echoed, s280). Each needs a run of
 * token characters after its prefix, so ordinary text («4/0» in a date, `sk-`
 * in a word) does not match.
 */
export const SECRET_PATTERNS = [
  // Google OAuth: authorization code, refresh token, access token.
  /(?<![\w/.-])4\/0A[0-9A-Za-z_-]{10,}/g,
  /(?<![\w/.-])1\/\/0[0-9A-Za-z_-]{10,}/g,
  /(?<![\w.-])ya29\.[0-9A-Za-z_-]{10,}/g,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_).
  /(?<![\w-])gh[pousr]_[A-Za-z0-9]{20,}/g,
  // Anthropic, then any other `sk-` key (OpenAI and others).
  /(?<![\w-])sk-ant-[A-Za-z0-9]{2,}-[A-Za-z0-9_-]{16,}/g,
  /(?<![\w-])sk-[A-Za-z0-9_-]{20,}/g,
  // Google API keys.
  /(?<![\w-])AIza[0-9A-Za-z_-]{30,}/g,
  // Slack tokens.
  /(?<![\w-])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // A sign-in URL a host shows (Google's OAuth consent or device page): it
  // carries the client, the state and the challenge of that person's login.
  /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>)]+/g,
  /https:\/\/oauth2\.googleapis\.com\/[^\s"'<>)]+/g,
  // JWT-like: three base64url segments, the first a JSON header.
  /(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** Characters a token is made of (base64url, and the dashes of its prefix). */
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

/** The body of a token that is its own: everything after a known public prefix. */
function distinctiveBody(value) {
  const prefix = PUBLIC_TOKEN_PREFIXES.find((p) => value.startsWith(p)) ?? "";
  return value.slice(prefix.length);
}

/**
 * `text` without whitespace, and for each kept character its index in `text`:
 * a token a pane wrapped over several lines (and indented) reads whole again.
 */
function compact(text) {
  let flat = "";
  const at = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    flat += text[i];
    at.push(i);
  }
  return { flat, at };
}

/**
 * Grows [a, b) over the token characters next to it on the same line: the
 * public prefix and any short edge the windows missed. A wrapped token needs no
 * crossing here — the windows match with whitespace removed, so their spans
 * already run over the line breaks and the wrap indentation between its parts;
 * crossing further would only eat the first word of the next line.
 */
function widen(text, a, b) {
  let start = a;
  while (start > 0 && TOKEN_CHAR.test(text[start - 1])) start -= 1;
  let end = b;
  while (end < text.length && TOKEN_CHAR.test(text[end])) end += 1;
  return [start, end];
}

/** Spans of the credential shapes (SECRET_PATTERNS), whatever the run was given. */
function patternSpans(t) {
  return SECRET_PATTERNS.flatMap((pattern) =>
    [...t.matchAll(pattern)].map((m) => widen(t, m.index, m.index + m[0].length)),
  );
}

/** Spans of every SECRET_PREFIX-long window of each value's own body, whitespace ignored. */
function valueSpans(t, values) {
  const { flat, at } = compact(t);
  const spans = [];
  for (const v of values) {
    const body = distinctiveBody(v);
    const size = Math.min(SECRET_PREFIX, body.length);
    for (let k = 0; size > 0 && k + size <= body.length; k++) {
      const window = body.slice(k, k + size);
      for (let i = flat.indexOf(window); i !== -1; i = flat.indexOf(window, i + 1)) {
        spans.push(widen(t, at[i], at[i + size - 1] + 1));
      }
    }
  }
  return spans;
}

/**
 * Where `text` carries a secret, as merged [start, end) spans of `text`: any
 * SECRET_PREFIX-long window of a token's distinctive body (or all of a shorter
 * body), matched with whitespace removed (so across wraps), grown to the whole
 * contiguous token on its first and last lines.
 */
export function secretSpans(text, secrets) {
  const t = String(text ?? "");
  const spans = [...patternSpans(t), ...valueSpans(t, usable(secrets))];
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/** Whether `text` carries any of `secrets`: any SECRET_PREFIX-long piece of one's own body. */
export function containsSecret(text, secrets) {
  return secretSpans(text, secrets).length > 0;
}

/** `text` with every token it carries replaced by `[redacted]`, wrapped lines included. */
export function redactSecrets(text, secrets) {
  const t = String(text ?? "");
  let out = "";
  let from = 0;
  for (const [a, b] of secretSpans(t, secrets)) {
    out += `${t.slice(from, a)}[redacted]`;
    from = b;
  }
  return out + t.slice(from);
}

/**
 * A violation reduced to its category — what may be written to the committed
 * matrix: «names an MCP outside the scenario», never the name it found.
 */
export const violationCategory = (violation) => violation.split(":")[0];
