// Decides, for one pane at one moment, whether the run may answer — and it
// almost never may. Pure: it reads Herdr's state, `agent explain --json` and the
// screen, and returns an action; the executor does the sending.
//
// Only two cases are answered, both with the scenario's label for the boundary
// the screen shows:
//   (a) `blocked`, the selector at the bottom of the screen shows every label of
//       that boundary, and the detection rule says it is a QUESTION (Herdr's rule
//       for claude and kimi; text markers for codex, opencode, agy and crush) →
//       `send-keys`, moving the cursor onto the label; Enter only after a fresh
//       screen classifies the same way with the cursor already on it;
//   (b) `idle`, the labeled markdown at the bottom shows those labels → `prompt`
//       with the label text.
// Anything that looks like a permission, and anything that does not fit, is
// `notify`: nothing is sent, that host waits, the others go on.

import { HOSTS } from "./hosts.mjs";
import { FLOW_CONTROLS } from "./scenario.mjs";

/**
 * Wording of approval/permission/trust UIs, searched over the WHOLE screen. Any
 * hit vetoes every send, even if a scenario label is also on screen: a
 * permission dialog that happens to contain «Cerrar» is still a permission.
 */
export const PERMISSION_MARKERS = [
  /\bdo you want to (proceed|allow|run|make|create|edit|execute)\b/i,
  /\b(allow|approve|deny|trust)\b.{0,40}\b(command|tool|once|always|session|this)\b/i,
  /\bpermission\b/i,
  /\byes, (allow|and don't ask|proceed)\b/i,
  /\balways allow\b/i,
  /\brun this command\?/i,
  /\bapprove\b/i,
  /\brequires? approval\b/i,
  /\bnew hook - review required\b/i,
  // First-run workspace trust (claude: «Do you trust the files in this folder?»,
  // codex: «Do you trust the contents of this directory?»).
  /\bdo you trust\b/i,
  /\btrust (the|this) (files|folder|directory|workspace|contents|project)\b/i,
  // crush's permission overlay (internal/ui/dialog/permissions.go): its title and
  // its horizontal buttons, wherever they land on screen.
  /\bpermission required\b/i,
  /\ballow for session\b/i,
  /\ballow\b[^\n]{0,60}\bdeny\b/i,
];

/**
 * A host's own sign-in on screen (agy signs in inside its pane when the run
 * starts; wording from agy 1.2.x binary strings: «Authentication required.
 * Please visit the URL to log in:», «Waiting for authentication (timeout 60s)»,
 * «Opening browser to authenticate with %s», «Enter the authorization code:»,
 * «Select login method», «Other sign-in options», «Sign in …»):
 * permission-class — the person signs in, the run notifies once and sends
 * nothing. The code or URL it shows is redacted from transcripts and extracts
 * (extract.mjs: the Google OAuth patterns, and SIGN_IN_URL).
 */
export const SIGN_IN_MARKERS = [
  /\bauthorization code\b/i,
  /\bvisit the url to log in\b/i,
  /\bauthentication required\b/i,
  /\bplease sign in\b/i,
  /\bSign in\b/,
  /\bwaiting for authentication\b/i,
  /\bopening browser to authenticate\b/i,
  /\bselect login method\b/i,
  /\bother sign-in options\b/i,
  /\bsign in with google\b/i,
  /accounts\.google\.com\/o\/oauth2/i,
  /\bcompleting authentication\b/i,
];

/**
 * First-run screens a host may still show although the run pre-seeds what it
 * can (claude: onboarding and trust in ~/.claude.json; codex: trust in
 * config.toml, --no-daemon): permission-class — notified, never answered.
 * Wording from claude 2.1.285 and codex 0.157.1 (screens and binary strings).
 */
export const FIRST_RUN_MARKERS = {
  "claude-code": [
    /\bLet's get started\b/,
    /\bChoose the text style\b/i,
    /\bSelect login method\b/i,
  ],
  codex: [
    /\bWelcome to Codex\b/,
    /\bSign in with ChatGPT\b/,
    /\bChoose how you want to use Codex\b/,
    /\bInstalling daemon from CLI version\b/,
    /\bUpdate available!/,
  ],
};

/** claude asking to log in means its token did not take. */
export const CLAUDE_LOGIN_NOTICE =
  "claude is asking to log in: the token did not take (check --claude-token-file)";

/** Why a permission-class screen is the person's: a specific notice where one exists. */
function blockedReason(host, screen, fallback) {
  if (host === "claude-code" && /\bSelect login method\b/i.test(String(screen ?? "")))
    return CLAUDE_LOGIN_NOTICE;
  return fallback;
}

/** Hosts that sign in inside their pane (hosts.mjs `signInInPane`). */
const SIGN_IN_HOSTS = new Set(Object.keys(HOSTS).filter((id) => HOSTS[id].signInInPane));

/**
 * Text markers of a structured question for hosts whose Herdr rule cannot be
 * read as one (unverified against a live pane; the run treats a miss as notify).
 */
export const QUESTION_MARKERS = {
  codex: [/\bOther:\s/],
  opencode: [/\btype your own answer\b/i, /\bcustom\b.{0,20}\banswer\b/i],
  gemini: [/\bwrite[- ]in\b/i, /\bselect (one|an option)\b/i],
  crush: [/\bsingle[_ ]choice\b/i, /\bchoose (one|an option)\b/i, /\bquestion \d+ of \d+\b/i],
};

/** Hosts whose Herdr detection rule names the question UI. */
const RULE_HOSTS = new Set(["claude-code", "kimi"]);

/**
 * The glyph a selector draws in front of the highlighted option. Deliberately
 * narrow: `>`, `*` and `●` also start echoed prompts and bullets, so `>` counts
 * only in front of a numbered option.
 */
const CURSOR = /^\s*(?:[❯›▶→]\s*|>\s*(?=\d+[.)]\s))/;

/**
 * An option line: cursor, number, bullet or checkbox, then text. A bare `>` is
 * an input or echo line, never an option, unless it points at a numbered one.
 */
const OPTION = /^\s*(?:[❯›▶→*•-]|>(?=\s*\d+[.)])|\d+[.)]|\[[ x]\])\s+\S/;

/**
 * The host's input line, empty or not (`> `, `❯ `, `› Ask Codex…`, `│ > │`),
 * and an echoed prompt (`> Recortar alcance`). A numbered cursor line is an
 * option, not input.
 */
const INPUT = /^[\s│┃]*[>›❯](?!\s*\d+[.)])(?:\s.*)?$/;

/**
 * The detection rule's own words, from `herdr agent explain --json`. Its shape is
 * untyped in Herdr 0.9.0's API schema (`explain: true`), so every plausible spot
 * is read.
 */
export function explainRuleText(explain) {
  if (explain === null || typeof explain !== "object") return "";
  const rule = explain.matched_rule ?? explain.rule ?? explain.matchedRule ?? null;
  const parts = [explain.state, explain.status, explain.reason];
  if (typeof rule === "string") parts.push(rule);
  else if (rule !== null && typeof rule === "object") {
    parts.push(rule.id, rule.name, rule.kind, rule.state);
  }
  return parts.filter((p) => typeof p === "string").join(" ");
}

/** Lines above the live selector that still belong to its dialog (title, command shown). */
const DIALOG_CONTEXT = 8;
/** Without a selector at the bottom, how much of the bottom counts as the live dialog. */
const LIVE_TAIL = 12;

/**
 * The part of the screen that is the host's live dialog: the selector at the
 * bottom with its context, or the last lines. Scrollback above it — an earlier
 * doctor report saying «permission», a relayed log — does not stall later steps.
 */
export function liveRegion(screen) {
  const all = String(screen ?? "").split("\n");
  const found = bottomBlock(all);
  const from = found
    ? Math.max(0, found.start - DIALOG_CONTEXT)
    : Math.max(0, all.length - LIVE_TAIL);
  return all.slice(from).join("\n");
}

/**
 * Strict over the live dialog: any marker there vetoes every send. A
 * screen-only host (no Herdr state: crush) draws its permission dialogs as
 * overlays anywhere on screen, so for it the WHOLE screen is the live dialog.
 */
export function isPermissionScreen(screen, explain, { wholeScreen = false, host = null } = {}) {
  if (/\b(permission|approval|approve|trust|allow)\b/i.test(explainRuleText(explain))) return true;
  const region = wholeScreen ? String(screen ?? "") : liveRegion(screen);
  // Sign-in wording only counts on the hosts that sign in inside their pane (agy):
  // elsewhere «Sign in» is just text a host may show.
  const markers = [
    ...PERMISSION_MARKERS,
    ...(SIGN_IN_HOSTS.has(host) ? SIGN_IN_MARKERS : []),
    ...(FIRST_RUN_MARKERS[host] ?? []),
  ];
  return markers.some((re) => re.test(region));
}

export function isQuestion(hostId, screen, explain) {
  if (RULE_HOSTS.has(hostId)) return /\b(question|ask)/i.test(explainRuleText(explain));
  return (QUESTION_MARKERS[hostId] ?? []).some((re) => re.test(screen));
}

/** Lines allowed below a live selector: blanks, box borders, key hints. */
const BLANK_OR_BOX = /^[\s─━═│┃║╭╮╰╯┌┐└┘╔╗╚╝]*$/;
const FOOTER =
  /(press enter|enter to|esc to|tab\/arrow|arrow keys|to navigate|to select|to confirm|to cancel|\? for shortcuts|ctrl\+\w)/i;
const isTail = (line) => BLANK_OR_BOX.test(line) || FOOTER.test(line);

function skipTail(all, i) {
  let j = i;
  while (j >= 0 && isTail(all[j])) j--;
  return j;
}

/**
 * The selector the host is showing NOW, only if it is at the bottom: after it
 * there may be blank lines, box borders, a key hint and at most ONE input line
 * (empty, boxed or echoed), nothing else. Returns {start, end} or null.
 */
function bottomBlock(all) {
  let end = skipTail(all, all.length - 1);
  if (end >= 0 && INPUT.test(all[end])) end = skipTail(all, end - 1);
  if (end < 0 || INPUT.test(all[end]) || !OPTION.test(all[end])) return null;
  const block = blockEndingAt(all, end);
  return block.options >= 2 ? { start: block.start, end } : null;
}

/**
 * The lines of the selector at the bottom of the screen (with their indented
 * descriptions), or [] when the bottom is not a selector. Scrollback above it —
 * echoed prompts, earlier answers, stale selectors — is never part of a decision.
 */
export function currentBlock(screen) {
  const all = String(screen ?? "").split("\n");
  const found = bottomBlock(all);
  return found ? all.slice(found.start, found.end + 1) : [];
}

/**
 * What identifies one showing of the bottom selector: everything on screen up to
 * the block's end, minus input and echo lines. Echoing the answer below the
 * block does not change it; the block reappearing after new output does.
 */
export function blockSignature(screen) {
  const all = String(screen ?? "").split("\n");
  const found = bottomBlock(all);
  if (!found) return null;
  return all
    .slice(0, found.end + 1)
    .filter((l) => !INPUT.test(l))
    .join("\n");
}

/** Walks up from an option line through options and their indented descriptions. */
function blockEndingAt(all, end) {
  let start = end;
  let options = 1;
  for (let i = end - 1; i >= 0; i--) {
    const isOption = OPTION.test(all[i]);
    if (!isOption && !/^\s{3,}\S/.test(all[i])) break;
    if (isOption) options++;
    start = i;
  }
  return { start, options };
}

function labelPattern(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*(?:(?:[❯›▶→>*•\\-]|\\d+[.)]|\\[[ x]\\])\\s*)*(?:\\*\\*|\`)?${escaped}(?:\\*\\*|\`)?(?:\\s*(?:—|-|:|\\(|$)|\\s{2,})`,
  );
}

/** Index of the label's own option line inside the block, searching from the bottom. */
function labelIndex(block, label) {
  const re = labelPattern(label);
  for (let i = block.length - 1; i >= 0; i--) if (re.test(block[i])) return i;
  return -1;
}

const showsAll = (block, b) =>
  [...b.labels, ...FLOW_CONTROLS].every((label) => labelIndex(block, label) !== -1);

/** The boundary of the current step whose labels ALL show in the current block. */
export function matchBoundary(step, screen) {
  const block = currentBlock(screen);
  const hits = step.boundaries.filter((b) => showsAll(block, b));
  if (hits.length !== 1) return null;
  // With no own labels (doctor, recall, close) the flow controls are all there is:
  // only unambiguous when the step has exactly that one boundary.
  const [hit] = hits;
  if (hit.labels.length === 0 && step.boundaries.length > 1) return null;
  return hit;
}

/**
 * Arrow keys that move the cursor onto `label` inside the current block, one per
 * option line crossed; null when either cannot be located there. Never Enter.
 */
export function selectionKeys(screen, label) {
  const block = currentBlock(screen);
  const target = labelIndex(block, label);
  const cursors = block.map((l, i) => (CURSOR.test(l) ? i : -1)).filter((i) => i !== -1);
  if (target === -1 || cursors.length !== 1) return null;
  const [cursor] = cursors;
  const [lo, hi] = cursor < target ? [cursor, target] : [target, cursor];
  let crossed = 0;
  for (let i = lo + 1; i <= hi; i++) if (OPTION.test(block[i])) crossed += 1;
  return Array.from({ length: crossed }, () => (target > cursor ? "down" : "up"));
}

/** The cursor of the current block sits on `label`. */
export function isSelected(screen, label) {
  const keys = selectionKeys(screen, label);
  return keys !== null && keys.length === 0;
}

/**
 * One decision for one pane. `pane` = {host, state, screen, explain}; `step` is
 * the step that pane is on, as `stepForHost` renders it.
 */
export function classify(pane, step) {
  const { host, state, screen = "", explain = null } = pane;
  if (state === "working") return { action: "wait", reason: "the host is working" };
  if (isPermissionScreen(screen, explain, { wholeScreen: pane.screenOnly === true, host })) {
    return {
      action: "notify",
      reason: blockedReason(host, screen, "permission or approval on screen: it is the person's"),
    };
  }
  // A known boundary past the step's stop point: the step is done, and that
  // boundary is left unanswered (quick.commit-authorization keeps the session active).
  const stop = (step?.stopAt ?? []).find((b) => showsAll(currentBlock(screen), b));
  if (stop)
    return { action: "stop", boundary: stop.id, reason: `stop point reached at ${stop.id}` };
  const hit = step ? matchBoundary(step, screen) : null;
  if (state === "blocked") return classifyBlocked(host, screen, explain, hit);
  if (state === "idle" || state === "done") {
    if (hit === null) return { action: "idle", reason: "no boundary of this step on screen" };
    return { action: "prompt", boundary: hit.id, label: hit.answer, text: hit.answer };
  }
  return { action: "notify", reason: `state '${state}' cannot be classified` };
}

function classifyBlocked(host, screen, explain, hit) {
  if (hit === null) {
    return { action: "notify", reason: "blocked on something that is not a boundary of this step" };
  }
  if (!isQuestion(host, screen, explain)) {
    return {
      action: "notify",
      reason: "the labels show but the detection does not read a question",
    };
  }
  const keys = selectionKeys(screen, hit.answer);
  if (keys === null) {
    return { action: "notify", reason: "cannot locate the cursor or the label in the selector" };
  }
  return { action: "send-keys", boundary: hit.id, label: hit.answer, keys, confirm: "enter" };
}

/**
 * Enter may follow the arrows only if a FRESH screen, classified from scratch,
 * is still that question: blocked, no permission, same boundary, cursor on the
 * label. Anything else and nothing more is sent.
 */
export function confirmsSelection(after, step, decision) {
  const again = classify(after, step);
  return (
    after.state === "blocked" &&
    again.action === "send-keys" &&
    again.boundary === decision.boundary &&
    again.label === decision.label &&
    again.keys.length === 0
  );
}

/**
 * Whether a step's invocation may be typed into this pane now: a fresh screen,
 * idle, with nothing that looks like a permission or trust prompt anywhere on it.
 */
export function readyForInput(pane) {
  if (pane.state !== "idle" && pane.state !== "done") {
    return { ok: false, reason: `pane is '${pane.state}', not idle: nothing is typed` };
  }
  if (
    isPermissionScreen(pane.screen, pane.explain, {
      wholeScreen: pane.screenOnly === true,
      host: pane.host,
    })
  ) {
    return {
      ok: false,
      reason: blockedReason(
        pane.host,
        pane.screen,
        "permission or trust prompt on screen: it is the person's",
      ),
    };
  }
  return { ok: true };
}

/** One tick over every pane: a pane waiting on the person never holds the others. */
export function classifyAll(panes, stepFor) {
  return panes.map((pane) => ({ host: pane.host, ...classify(pane, stepFor(pane.host)) }));
}

/**
 * The executor's last check before any byte leaves: arrows plus one Enter, or a
 * prompt that is exactly a scenario label. A bare Enter, «1» or «y» never passes.
 */
export function assertSafe(decision, answers) {
  if (decision.action === "send-keys") {
    const arrows = decision.keys.every((k) => k === "up" || k === "down");
    if (!arrows || decision.confirm !== "enter" || !answers.has(decision.label)) {
      throw new Error("unsafe key sequence refused");
    }
  } else if (decision.action === "prompt" && !answers.has(decision.text)) {
    throw new Error(`prompt '${decision.text}' is not a scenario label`);
  }
  return decision;
}
