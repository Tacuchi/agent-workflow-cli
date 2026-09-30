// The live run, reached only through `launch` after the typed approval: prepare
// every host, stop before any pane if one does not authenticate, open one Herdr
// pane per host, walk the scenario and write the evidence.
//
// Each host advances on its own. A pane waiting on the person (a permission, a
// trust prompt, or anything the classifier does not recognize) only holds that
// host. Nothing is ever typed into a pane without a fresh read of it first.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertSafe,
  blockSignature,
  classify,
  confirmsSelection,
  isPermissionScreen,
  lastReply,
  readyForInput,
} from "./classifier.mjs";
import {
  buildExtract,
  containsSecret,
  hookBinaries,
  hookLines,
  privacyViolations,
  shimRan,
  violationCategory,
} from "./extract.mjs";
import { HOSTS, SURFACES } from "./hosts.mjs";
import { MARKER_FILE, pidAlive, prepareHost, staleRoots } from "./isolation.mjs";
import { buildMatrix, declaredByDoctor, judgeSurface } from "./matrix.mjs";
import { stepForHost } from "./scenario.mjs";

const TICK_MS = 2000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
/** A step with no observed work is done only after this long idle. */
const QUIET_DONE_MS = 20000;

/** crush's provider and model for the matrix: set by a provider key, or its own data. */
export function crushFields(pm) {
  if (!pm) return {};
  if (pm === "own-data") return { crush_provider: "own-data", crush_model: null };
  return { crush_provider: pm.provider, crush_model: pm.model };
}

/** Removes what a dead run left in the temp dir (SIGKILL cannot be trapped). */
export function sweep(tmp, remove, log, now = Date.now()) {
  const ageOf = (path) => {
    try {
      const st = statSync(path);
      // The creation time where the platform has one; else the last change.
      return now - (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
    } catch {
      return undefined;
    }
  };
  const entries = readdirSync(tmp, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: join(tmp, e.name), ageMs: ageOf(join(tmp, e.name)) }));
  const readMarker = (path) => {
    try {
      return JSON.parse(readFileSync(join(path, MARKER_FILE), "utf8"));
    } catch {
      return null;
    }
  };
  for (const path of staleRoots(entries, readMarker, pidAlive)) {
    remove(path);
    log(`swept a dead run's leftovers: ${path}`);
  }
}

/** Prepares every host; returns the plans, or null when the run must stop before panes. */
export async function prepareAll(ctx) {
  const prepared = [];
  const unauthenticated = [];
  // Every root exists before any is prepared, so each profile can deny the
  // others by their exact paths (their copied credentials, their token files).
  const roots = Object.fromEntries(ctx.hosts.map((host) => [host, ctx.makeRoot(host)]));
  for (const root of Object.values(roots)) ctx.cleanup.track(root);
  for (const host of ctx.hosts) {
    const root = roots[host];
    const siblings = Object.values(roots).filter((r) => r !== root);
    const plan = ctx.planFor(host, root, siblings);
    const steps = await prepareHost(plan, ctx.prepareDeps);
    for (const s of steps) ctx.log(`  [${host}] ${s.ok ? "ok  " : "FAIL"} ${s.step} — ${s.detail}`);
    const failed = steps.find((s) => !s.ok);
    if (failed?.step.startsWith("auth probe")) unauthenticated.push(host);
    else if (failed) {
      ctx.log(`[${host}] preparation failed; the run stops before opening any pane`);
      return null;
    }
    prepared.push(plan);
  }
  if (unauthenticated.length > 0) {
    ctx.log(
      [
        `these hosts do not authenticate from a disposable home: ${unauthenticated.join(", ")}.`,
        "The run stops here and goes back to you (plan 085, T3.1): choose another way to authenticate",
        "them, or amend spec 062 (`aw amend`) to declare them not covered.",
      ].join("\n"),
    );
    return null;
  }
  return prepared;
}

function readIf(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function logText(home) {
  const dir = join(home, ".workflow", "logs");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => readIf(join(dir, f)))
    .join("\n");
}

const shimLog = (home) => readIf(join(home, ".host-run", "shim-calls.log"));

function quickCheckpoint(workspace) {
  const dir = join(workspace, ".workflow", "sessions");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (d) => d.endsWith("-quick") && existsSync(join(dir, d, "CHECKPOINT.md")),
  );
}

const HOST_WORD = "claude|codex|oz|warp|gemini|antigravity|opencode|crush|kimi";
/** Row states as the CLI prints them, and as a host relays them in Spanish. */
const ROW_STATE =
  "read|absent|empty|disabled|unreadable|le[ií]d[oa]s?|ausente|vac[ií][oa]|desactivad[oa]|ilegible";
const RECALL_ROW = new RegExp(`\\b(${HOST_WORD})\\b.*\\b(${ROW_STATE})`, "i");

/**
 * /w:recall relayed its rows: the shims saw `host-memory`, and at least two
 * screen lines each name a host and a row state.
 */
export function recallRelayed(screen, shim) {
  const rows = String(screen)
    .split("\n")
    .filter((l) => RECALL_ROW.test(l)).length;
  return shimRan(shim, "host-memory") && rows >= 2;
}

function answeredHow(answered) {
  if (answered.includes("native")) return "native";
  return answered.includes("markdown") ? "markdown" : null;
}

/** Evidence of one surface from the host's home, workspace and the step's screens. */
const COLLECTORS = {
  // The wrapper ran the CLI's doctor during this step (the shim saw it); the
  // relay on screen is recorded but not required — claude folds a tool's output.
  commands: (h, { screen, shimSince }) => ({
    ran: shimRan(shimSince, "doctor"),
    relayed: /\bVeredicto:/.test(screen),
    via: HOSTS[h.id].commandsVia,
  }),
  "structured-choice": (_h, { answered, reachedBoundaries }) => ({
    reached: reachedBoundaries.length > 0,
    answered: answeredHow(answered),
    boundaries: reachedBoundaries,
  }),
  // The host listed the tools, and its own server was reached while the pane ran
  // (the CLI logs `mcp request` whenever the host launches or calls it). The
  // setup receipt is not evidence: preparation writes it before any pane opens.
  mcp: (_h, { screen, logSincePane }) => ({
    toolsListed: screen.includes("execute_sql") && screen.includes("search_objects"),
    serverReached: / INFO mcp request\b/.test(logSincePane) || /READ_ONLY_POLICY/.test(screen),
  }),
  hooks: (h, { logSincePane }) => ({
    lines: hookLines(logSincePane),
    binaries: hookBinaries(shimLog(h.home)),
  }),
  "host-memory": (h, { screen }) => ({
    ran: recallRelayed(screen, shimLog(h.home)),
    destination: h.destination === true,
  }),
  compaction: (h, { compactStartLog }) => {
    const lines = hookLines(logText(h.home).slice(compactStartLog));
    return {
      preCompact: lines.PreCompact,
      postCompact: lines.PostCompact,
      checkpoint: quickCheckpoint(h.workspace),
    };
  },
};

export function collectEvidence(surface, host, seen = {}) {
  const collector = COLLECTORS[surface];
  if (!collector) return null;
  return collector(host, {
    screen: (seen.screens ?? []).join("\n"),
    answered: seen.answered ?? [],
    reachedBoundaries: seen.reachedBoundaries ?? [],
    compactStartLog: seen.compactStartLog ?? 0,
    // What the host did after its pane opened / after this step was sent.
    logSincePane: logText(host.home).slice(host.logStart ?? 0),
    shimSince: shimLog(host.home).slice(seen.shimStart ?? 0),
  });
}

/**
 * A host whose model call failed (quota, key, unknown model) did not exercise
 * the surface: its step is not reached, never broken (s280 run 3: opencode on a
 * default model with no quota).
 */
const MODEL_FAILURE =
  /\bquota exceeded\b|exceeded your current quota|\binsufficient_quota\b|\brate[- ]limit(ed| exceeded| reached)\b|\b429 too many requests\b|invalid (api )?key|\b401 unauthorized\b|model [^\n]{0,40} not found|no (large )?model selected/i;
export const MODEL_FAILED = "the host's model call failed (quota, key or model)";

const hasKindOf = (h) => HOSTS[h.id].herdrKind !== null;

/**
 * Sends one classifier decision; returns how it was answered, or null. Enter
 * follows the arrows only when a fresh screen, classified from scratch, still
 * shows the same question with the cursor on the label.
 */
async function act(ctx, h, step, decision) {
  const { herdr, answers } = ctx;
  assertSafe(decision, answers);
  if (decision.action === "prompt") {
    herdr.prompt(h.pane, decision.text, hasKindOf(h));
    return "markdown";
  }
  herdr.keys(h.pane, decision.keys, hasKindOf(h));
  await ctx.sleep(500);
  const after = herdr.snapshot(h.id, h.pane, hasKindOf(h));
  if (!confirmsSelection(after, step, decision)) {
    ctx.notify(
      h.id,
      `'${decision.label}' could not be confirmed on a fresh screen; answer it yourself`,
    );
    return null;
  }
  herdr.keys(h.pane, ["enter"], hasKindOf(h));
  return "native";
}

/**
 * The palette's own title or filter input, never the footer hint `ctrl+p
 * commands`: a line that is only «Commands» (optionally boxed), or a filter
 * prompt. Unverified against crush's commands dialog.
 */
const PALETTE_OPEN =
  /^[\s│┃╭╰─]*commands[\s│┃╮╯─]*$|type to filter|filter commands|search commands/im;

/**
 * crush's palette: ctrl+p, then a fresh read must show the palette open (the
 * screen changed, its title or filter shows, nothing permission-like) before any
 * text is typed. Unverified against a live crush pane: when it does not read as
 * open, nothing more is sent and the person types the command.
 */
async function openPalette(ctx, h, before) {
  ctx.herdr.keys(h.pane, ["ctrl+p"], hasKindOf(h));
  await ctx.sleep(500);
  const after = ctx.herdr.snapshot(h.id, h.pane, hasKindOf(h));
  // The marker must be NEW: a «Commands» line already on screen before ctrl+p
  // (a title, the footer) proves nothing.
  const seen = new Set(before.screen.split("\n").map((l) => l.trim()));
  const fresh = after.screen.split("\n").filter((l) => !seen.has(l.trim()));
  return (
    fresh.some((l) => PALETTE_OPEN.test(l)) &&
    !isPermissionScreen(after.screen, after.explain, { wholeScreen: true, host: h.id })
  );
}

function startAwaiting(ctx, h, screen) {
  h.sending = false;
  Object.assign(h, {
    phase: "await",
    since: ctx.now(),
    sawWork: false,
    lastScreen: screen,
    // The screen before the send, and what the logs held then: work is measured
    // against them.
    preSend: screen,
    stepLogStart: logText(h.home).length,
    screens: [],
    answered: [],
    reached: [],
    answeredSigs: new Set(),
    // Time spent waiting on the person does not count against the step.
    pausedMs: 0,
    waitingSince: null,
    quietNoticed: false,
    shimStart: shimLog(h.home).length,
  });
}

/**
 * Types the step's invocation — only into a pane that a fresh read shows idle
 * with nothing permission- or trust-like on it. Otherwise the person is told
 * and nothing is typed; the next tick reads it again.
 */
/**
 * Before any byte is typed or answered: nothing in the workspace may point
 * outside the root (a source, a kimi additional_dir). Otherwise the host is
 * held for good, the person is told, and its evidence is marked broken.
 */
function holdIfSteeredOut(ctx, h) {
  const reasons = ctx.guard ? ctx.guard(h) : [];
  if (reasons.length === 0) return false;
  h.phase = "held";
  h.heldReason = "the workspace pointed outside the disposable root";
  h.evidenceBroken = reasons.join("; ");
  ctx.notify(h.id, `held: ${h.evidenceBroken}. Nothing more is sent to this host.`);
  return true;
}

export async function sendStep(ctx, h) {
  if (holdIfSteeredOut(ctx, h)) return false;
  const pane = ctx.herdr.snapshot(h.id, h.pane, hasKindOf(h));
  ctx.transcript(h.id, pane.screen);
  const ready = readyForInput(pane);
  if (!ready.ok) {
    ctx.notify(h.id, ready.reason);
    return false;
  }
  const step = stepForHost(ctx.steps[h.stepIndex], h.id);
  if (step.surface === "compaction") h.compactStartLog = logText(h.home).length;
  // From here on something may reach the pane: a failure is never retried (it
  // would retype text the pane may already hold).
  h.sending = true;
  if (step.invocation.via === "palette" && !(await openPalette(ctx, h, pane))) {
    ctx.notify(
      h.id,
      `the command palette did not read as open: type '${step.invocation.text}' yourself`,
    );
    startAwaiting(ctx, h, pane.screen);
    return false;
  }
  ctx.herdr.prompt(h.pane, step.invocation.text, hasKindOf(h));
  startAwaiting(ctx, h, pane.screen);
  return true;
}

/** The notice for a send that failed after part of it may have reached the pane. */
export const SEND_FAILED_MIDWAY =
  "a send to this pane failed midway; check it and continue by hand";

function finishStep(ctx, h, observedEvidence, lastScreen = "") {
  const surface = ctx.steps[h.stepIndex].surface;
  h.evidence[surface] = observedEvidence;
  h.screensBySurface[surface] = lastScreen;
  h.stepIndex += 1;
  h.phase = h.stepIndex < ctx.steps.length ? "send" : "done";
}

function completeStep(ctx, h, step, pane) {
  // A model call that failed: nothing about the surface was exercised. Only the
  // end of the reply the step produced counts — never scrollback (a doctor
  // report may well mention a «rate limit»).
  if (MODEL_FAILURE.test(newReply(pane.screen, h.preSend))) {
    finishStep(ctx, h, { reached: false, reason: MODEL_FAILED }, pane.screen);
    return;
  }
  if (step.surface === "commands") h.doctorText = h.screens.join("\n");
  if (step.surface === "host-memory") {
    // The rows come from the CLI in that home, not from the agent's retelling.
    h.hostMemory = ctx.readHostMemory(h);
    h.destination = h.hostMemory?.current_host?.destination != null;
  }
  const evidence = collectEvidence(step.surface, h, {
    screens: h.screens,
    answered: h.answered,
    reachedBoundaries: h.reached,
    compactStartLog: h.compactStartLog,
    shimStart: h.shimStart,
  });
  finishStep(ctx, h, evidence, pane.screen);
}

/** A screen-only pane (crush) reads `unknown` right after a send; that is not the person's yet. */
const SCREEN_ONLY_GRACE_MS = 10000;

/**
 * Answers one decision, at most once per showing of a boundary: the same
 * boundary with the same block on screen is never answered again in this step.
 */
async function answerOnce(ctx, h, step, decision, screen) {
  const key = `${decision.boundary}\n${blockSignature(screen)}`;
  h.answeredSigs ??= new Set();
  if (h.answeredSigs.has(key)) {
    ctx.notify(
      h.id,
      `'${decision.label}' was already answered and the same ${decision.boundary} is still shown: check the pane`,
    );
    return;
  }
  if (holdIfSteeredOut(ctx, h)) return;
  h.answeredSigs.add(key);
  h.reached.push(decision.boundary);
  h.sending = true;
  const how = await act(ctx, h, step, decision);
  h.sending = false;
  if (how) h.answered.push(how);
}

/** The step's own input still sits in the pane's input line: it was never submitted. */
export function inputNotSubmitted(screen, invocation) {
  // The invocation's first word (`$w-doctor`, `/w:quick`, `/compact`) is enough.
  const head =
    String(invocation ?? "")
      .trim()
      .split(/\s+/)[0] ?? "";
  if (!head) return false;
  const lines = String(screen ?? "")
    .split("\n")
    .filter((l) => l.trim());
  return lines.slice(-4).some((l) => /^[\s│┃]*[>›❯]\s/.test(l) && l.includes(head));
}

/** The lines of the agent's last reply that were not on screen before the send. */
function newReply(screen, preSend) {
  const before = new Set(String(preSend ?? "").split("\n"));
  return lastReply(screen)
    .filter((l) => !before.has(l))
    .slice(-6)
    .join("\n");
}

/** Notices the person gets about a step that did not start. */
export const NOT_SUBMITTED =
  "the step's input is still in the pane's input box: press Enter there (the run never retypes it)";
export const NOT_STARTED = "the step did not start: check the pane";

async function awaitStep(ctx, h) {
  const step = stepForHost(ctx.steps[h.stepIndex], h.id);
  const pane = ctx.herdr.snapshot(h.id, h.pane, hasKindOf(h));
  ctx.transcript(h.id, pane.screen);
  h.screens.push(pane.screen);
  noteRelay(h, pane.screen);
  noteWork(h, pane, step.invocation.text);
  const quietGrace =
    !hasKindOf(h) && pane.state === "unknown" && ctx.now() - h.since < SCREEN_ONLY_GRACE_MS;
  const decision = quietGrace ? { action: "wait" } : classify(pane, step);
  pauseWhileWaiting(ctx, h, decision);
  if (decision.action === "notify") ctx.notify(h.id, decision.reason);
  else if (decision.action === "send-keys" || decision.action === "prompt") {
    await answerOnce(ctx, h, step, decision, pane.screen);
  } else if (decision.action === "stop") {
    completeStep(ctx, h, step, pane);
  } else if (decision.action === "idle") {
    idleStep(ctx, h, step, pane);
  }
  if (h.phase === "await" && activeMs(ctx, h) > STEP_TIMEOUT_MS) timeOut(ctx, h, step, pane);
}

/**
 * Work on the step, for every host: Herdr reads the agent working; the CLI saw a
 * call (new shim or log lines since the send); or the screen differs from the
 * pre-send screen beyond the input line and the echo of the step's own input.
 * A step that finished between two ticks is therefore not «never started».
 */
function noteWork(h, pane, invocation) {
  h.lastScreen = pane.screen;
  if (h.sawWork) return;
  if (pane.state === "working") h.sawWork = true;
  else if (shimLog(h.home).length > (h.shimStart ?? 0)) h.sawWork = true;
  else if (logText(h.home).length > (h.stepLogStart ?? 0)) h.sawWork = true;
  else if (h.preSend != null && content(pane.screen, invocation) !== content(h.preSend, invocation))
    h.sawWork = true;
}

/** A screen minus its input line, key hints and the echo of the step's own input. */
function content(screen, invocation) {
  const head =
    String(invocation ?? "")
      .trim()
      .split(/\s+/)[0] ?? "";
  return String(screen ?? "")
    .split("\n")
    .filter((l) => l.trim())
    .filter((l) => !/^[\s│┃]*[>›❯](\s|$)/.test(l))
    .filter((l) => !(head && l.includes(head)))
    .filter((l) => !/(\? for shortcuts|esc to interrupt|enter to (select|confirm))/i.test(l))
    .join("\n");
}

/** Keeps every doctor relay the host shows during the run (its Hosts section). */
function noteRelay(h, screen) {
  if (!/· runtime /.test(screen)) return;
  h.relays ??= [];
  if (h.relays.at(-1) !== screen) h.relays.push(screen);
  if (h.relays.length > 20) h.relays.shift();
}

/** A step waiting on the person (permission, first-run, a tab that is theirs) pauses its clock. */
function pauseWhileWaiting(ctx, h, decision) {
  const waiting = decision.action === "notify";
  h.waitingSince ??= null;
  if (waiting && h.waitingSince === null) h.waitingSince = ctx.now();
  if (!waiting && h.waitingSince !== null) {
    h.pausedMs = (h.pausedMs ?? 0) + ctx.now() - h.waitingSince;
    h.waitingSince = null;
  }
}

/** The step's time on the clock: waiting on the person is not counted. */
function activeMs(ctx, h) {
  const waiting = h.waitingSince ?? null;
  const paused = (h.pausedMs ?? 0) + (waiting === null ? 0 : ctx.now() - waiting);
  return ctx.now() - h.since - paused;
}

/**
 * The pane is idle: the step is done only if work was seen. A step that never
 * started is never completed from files alone: the person is told once, and the
 * step stays open (its clock runs) until work shows or it times out.
 */
function idleStep(ctx, h, step, pane) {
  if (h.sawWork) {
    completeStep(ctx, h, step, pane);
    return;
  }
  if (h.quietNoticed || activeMs(ctx, h) < QUIET_DONE_MS) return;
  h.quietNoticed = true;
  ctx.notify(
    h.id,
    inputNotSubmitted(pane.screen, step.invocation.text) ? NOT_SUBMITTED : NOT_STARTED,
  );
}

/**
 * A timeout keeps what was observed; a step that never started, or that ended
 * waiting on the person, is not reached — with why.
 */
function timeOut(ctx, h, step, pane) {
  const progressed = h.sawWork || h.reached.length > 0;
  const reason =
    (h.waitingSince ?? null) !== null
      ? "waiting for the person"
      : inputNotSubmitted(pane.screen, step.invocation.text)
        ? "the step's input was never submitted"
        : "the step never started";
  ctx.notify(
    h.id,
    `step ${step.surface} timed out${progressed ? "" : `: not reached (${reason})`}`,
  );
  if (progressed) completeStep(ctx, h, step, pane);
  else finishStep(ctx, h, { reached: false, reason }, pane.screen);
}

/** One pass over every host. */
/** Consecutive failed herdr calls on one pane before that host is left to the person. */
export const HERDR_FAILURES_BEFORE_HOLD = 3;

export async function tick(ctx, hosts) {
  for (const h of hosts.filter((x) => x.phase !== "done" && x.phase !== "held")) {
    try {
      if (h.phase === "send") await sendStep(ctx, h);
      else await awaitStep(ctx, h);
      h.herdrFailures = 0;
    } catch (err) {
      // One pane Herdr cannot read or drive never ends the whole run.
      if (err?.name !== "HerdrError") throw err;
      if (h.sending) {
        // Part of a send (text, Enter, ctrl+p, a prompt) may be in the pane.
        h.sending = false;
        h.phase = "held";
        h.heldReason = SEND_FAILED_MIDWAY;
        ctx.notify(h.id, SEND_FAILED_MIDWAY);
        continue;
      }
      h.herdrFailures = (h.herdrFailures ?? 0) + 1;
      if (h.herdrFailures < HERDR_FAILURES_BEFORE_HOLD) {
        ctx.notify(h.id, `herdr ${err.what} failed; retrying`);
      } else {
        h.phase = "held";
        h.heldReason = `herdr ${err.what} failed ${h.herdrFailures} times in a row`;
        ctx.notify(h.id, `${h.heldReason}: this host is left to you; the others go on`);
      }
    }
  }
}

/**
 * Why a run stopped, as one sanitized category: never an error's own text
 * (it can carry a pane's output or a path).
 */
export function stopReason(err) {
  if (typeof err === "string") return err;
  if (err?.name === "HerdrError") return `herdr ${err.what} failed`;
  if (err?.code === "ETIMEDOUT") return "timeout";
  return `internal error (${err?.name ?? typeof err})`;
}

/**
 * Opens every pane and walks the scenario; whatever happens — a pane that
 * cannot be opened, an exception — `finish(hosts, stop)` runs exactly once and
 * writes the matrix (unreached cells not-reached), and ONE line says why the
 * run stopped. `session` = {hosts: [], finished: false} is shared with the
 * signal path (Cleanup), which finishes it as interrupted.
 */
export async function runLiveSession({ session, plans, open, ctx, finish, log }) {
  let stop = null;
  try {
    for (const plan of plans) {
      const host = await open(plan);
      // What the log already holds (preparation's own calls) is not the host's doing.
      if (host.home) host.logStart = logText(host.home).length;
      session.hosts.push(host);
    }
    await walk(ctx, session.hosts);
  } catch (err) {
    stop = stopReason(err);
    session.error = err;
  }
  finishSession(session, finish, stop, log);
  return stop;
}

/** Finishes a session once: the matrix, then the summary line. */
export function finishSession(session, finish, stop, log) {
  if (session.finished) return;
  session.finished = true;
  let unwritten = null;
  try {
    finish(session.hosts, stop);
  } catch (err) {
    // Our own refusals carry their category («matrix not written: contains a token»).
    unwritten = err?.category ? err.message : `matrix not written: ${stopReason(err)}`;
  }
  const why = [stop, unwritten].filter(Boolean).join("; ");
  log(why ? `run stopped: ${why}` : "run finished: every host walked the scenario");
}

/** Walks the scenario until every host is done. */
export async function walk(ctx, hosts) {
  while (hosts.some((h) => h.phase !== "done" && h.phase !== "held")) {
    await tick(ctx, hosts);
    await ctx.sleep(TICK_MS);
  }
}

/**
 * Where a degradation is declared: the host's own relay of /w:doctor, or — when
 * the host folds the report (claude shows «Ran 1 shell command») — the same
 * CLI's doctor in that home. null when neither declares it.
 */
function declaration(relay, cliDoctor, surface, label) {
  if (declaredByDoctor(relay, surface, label)) return "relay";
  if (declaredByDoctor(cliDoctor, surface, label)) return "cli";
  return null;
}

/** Why a surface was not reached: the step's own reason, the hold, or the run's end. */
function unreachedWhy(h, surface) {
  const own = h.evidence[surface]?.reason;
  if (own) return own;
  if (h.phase === "held") return h.heldReason ?? "the host was held";
  return "the step was never sent";
}

function hostRunOf(ctx, h) {
  // Hooks are judged after compaction, when Pre/PostCompact had their chance.
  if (h.evidence.hooks && h.evidence.hooks.reached !== false) {
    h.evidence.hooks = collectEvidence("hooks", h);
  }
  const cells = {};
  const relay = (h.relays ?? []).join("\n");
  const cliDoctor = ctx.cliDoctorText?.(h) ?? "";
  for (const step of ctx.steps) {
    const surface = step.surface;
    const observed = judgeSurface(surface, h.evidence[surface]);
    const declared = declaration(relay, cliDoctor, surface, ctx.labels[h.id]);
    cells[surface] = {
      observed,
      mode: "interactive",
      // AC-05: only the host's own relay declares; the CLI's doctor is support.
      declared_by_doctor: declared === "relay",
      ...(declared ? { declared_source: declared } : {}),
      ...(observed === "not-reached" ? { not_reached_reason: unreachedWhy(h, surface) } : {}),
      extract: `extracts/${h.id}/${surface}.json`,
    };
  }
  // Something in the workspace pointing outside the root (a source, a kimi
  // additional_dir), before a send or now: nothing this host observed stands.
  const late = ctx.guard ? ctx.guard(h) : [];
  const broken = [h.evidenceBroken, ...late].filter(Boolean);
  return {
    version: h.version,
    model: h.model,
    effort: h.effort,
    agy_without_profile: h.agyWithoutProfile,
    ...(h.agyModelProvider ? { agy_model_provider: h.agyModelProvider } : {}),
    ...(h.agyKeychain ? { agy_keychain: h.agyKeychain } : {}),
    ...crushFields(h.crushProviderModel),
    // Only the category reaches the committed matrix, never the paths found.
    ...(broken.length > 0
      ? { evidence_broken: "the workspace pointed outside the disposable root" }
      : {}),
    cells,
  };
}

/**
 * The matrix and the extracts of this run. An extract that fails the privacy
 * filter is not written: its cell records why instead, and the rest stands.
 */
export function evidenceOf(ctx, hosts, { launched = null, stopped = null } = {}) {
  const hostRuns = Object.fromEntries(hosts.map((h) => [h.id, hostRunOf(ctx, h)]));
  const extracts = [];
  for (const h of hosts) {
    for (const surface of SURFACES) {
      const cell = hostRuns[h.id].cells[surface];
      if (!cell) continue;
      const draft = buildMatrix({
        runId: ctx.runId,
        date: ctx.date,
        cli: ctx.cli,
        scenarioDigest: ctx.digest,
        catalog: ctx.catalog,
        hostRuns: { [h.id]: { ...hostRuns[h.id], cells: { [surface]: cell } } },
        hosts: [h.id],
      }).hosts[h.id].cells[surface];
      const extract = buildExtract({
        host: h.id,
        surface,
        cell: draft,
        screen: h.screensBySurface?.[surface] ?? "",
        evidence: h.evidence[surface],
        hostMemory: h.hostMemory,
        paths: { root: h.root, realHome: ctx.realHome },
      });
      const problems = privacyViolations(extract, {
        realHome: ctx.realHome,
        username: ctx.username,
        foreignMcp: ctx.foreignMcp ?? [],
        secrets: ctx.secrets ?? [],
      });
      if (problems.length > 0) {
        cell.extract = undefined;
        cell.extract_refused = [...new Set(problems.map(violationCategory))];
      } else extracts.push({ path: cell.extract, extract });
    }
  }
  const matrix = buildMatrix({
    runId: ctx.runId,
    date: ctx.date,
    cli: ctx.cli,
    scenarioDigest: ctx.digest,
    catalog: ctx.catalog,
    hostRuns,
    steps: ctx.steps.map((s) => s.surface),
    // Every planned host counts as launched: one the run never opened (it
    // stopped first) has its cells not-reached, not not-run.
    hosts: launched ?? hosts.map((h) => h.id),
    stopped,
  });
  return { matrix, extracts };
}

/**
 * The notifier the run uses: one line per host and reason, never the same
 * reason twice in a row for a host (a pane re-read every tick would spam).
 */
export function makeNotifier(write, secrets = []) {
  const last = new Map();
  return (id, reason) => {
    if (last.get(id) === reason) return false;
    last.set(id, reason);
    // A reason carrying a token is withheld, never printed.
    const shown = containsSecret(reason, secrets)
      ? "(a message was withheld: it contained a token)"
      : reason;
    write(`\u0007[${id}] waiting for you: ${shown}\n`);
    return true;
  };
}
