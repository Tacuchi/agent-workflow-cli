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
const RECALL_ROW = new RegExp(
  `\\b(${HOST_WORD})\\b.*\\b(read|absent|empty|disabled|unreadable)\\b`,
  "i",
);

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
  commands: (h, { screen }) => ({
    ran: /\bVeredicto:/.test(screen) && shimRan(shimLog(h.home), "doctor"),
    via: HOSTS[h.id].commandsVia,
  }),
  "structured-choice": (_h, { answered, reachedBoundaries }) => ({
    reached: reachedBoundaries.length > 0,
    answered: answeredHow(answered),
    boundaries: reachedBoundaries,
  }),
  mcp: (h, { screen }) => ({
    toolsListed: screen.includes("execute_sql") && screen.includes("search_objects"),
    receipt: existsSync(join(h.home, ".workflow", "dev", "mcp-host-receipts.json")),
  }),
  hooks: (h) => ({ lines: hookLines(logText(h.home)), binaries: hookBinaries(shimLog(h.home)) }),
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
  });
}

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
  Object.assign(h, {
    phase: "await",
    since: ctx.now(),
    sawWork: false,
    lastScreen: screen,
    screens: [],
    answered: [],
    reached: [],
    answeredSigs: new Set(),
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

function finishStep(ctx, h, observedEvidence, lastScreen = "") {
  const surface = ctx.steps[h.stepIndex].surface;
  h.evidence[surface] = observedEvidence;
  h.screensBySurface[surface] = lastScreen;
  h.stepIndex += 1;
  h.phase = h.stepIndex < ctx.steps.length ? "send" : "done";
}

function completeStep(ctx, h, step, pane) {
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
  const how = await act(ctx, h, step, decision);
  if (how) h.answered.push(how);
}

async function awaitStep(ctx, h) {
  const step = stepForHost(ctx.steps[h.stepIndex], h.id);
  const pane = ctx.herdr.snapshot(h.id, h.pane, hasKindOf(h));
  ctx.transcript(h.id, pane.screen);
  h.screens.push(pane.screen);
  // A screen-only pane (crush) shows work as a changing screen.
  if (pane.state === "working" || pane.screen !== h.lastScreen) h.sawWork = true;
  h.lastScreen = pane.screen;
  const quietGrace =
    !hasKindOf(h) && pane.state === "unknown" && ctx.now() - h.since < SCREEN_ONLY_GRACE_MS;
  const decision = quietGrace ? { action: "wait" } : classify(pane, step);
  if (decision.action === "notify") ctx.notify(h.id, decision.reason);
  else if (decision.action === "send-keys" || decision.action === "prompt") {
    await answerOnce(ctx, h, step, decision, pane.screen);
  } else if (decision.action === "stop") {
    completeStep(ctx, h, step, pane);
  } else if (decision.action === "idle" && (h.sawWork || ctx.now() - h.since > QUIET_DONE_MS)) {
    completeStep(ctx, h, step, pane);
  }
  if (h.phase === "await" && ctx.now() - h.since > STEP_TIMEOUT_MS) timeOut(ctx, h, step, pane);
}

/** A timeout keeps what was observed; only a step that never progressed is not reached. */
function timeOut(ctx, h, step, pane) {
  const progressed = h.sawWork || h.reached.length > 0;
  ctx.notify(
    h.id,
    `step ${step.surface} timed out${progressed ? "" : ": recorded as not reached"}`,
  );
  if (progressed) completeStep(ctx, h, step, pane);
  else finishStep(ctx, h, { reached: false }, pane.screen);
}

/** One pass over every host. */
export async function tick(ctx, hosts) {
  for (const h of hosts.filter((x) => x.phase !== "done" && x.phase !== "held")) {
    if (h.phase === "send") await sendStep(ctx, h);
    else await awaitStep(ctx, h);
  }
}

/** Walks the scenario until every host is done. */
export async function walk(ctx, hosts) {
  while (hosts.some((h) => h.phase !== "done" && h.phase !== "held")) {
    await tick(ctx, hosts);
    await ctx.sleep(TICK_MS);
  }
}

function hostRunOf(ctx, h) {
  // Hooks are judged after compaction, when Pre/PostCompact had their chance.
  if (h.evidence.hooks && h.evidence.hooks.reached !== false) {
    h.evidence.hooks = collectEvidence("hooks", h);
  }
  const cells = {};
  for (const step of ctx.steps) {
    const surface = step.surface;
    cells[surface] = {
      observed: judgeSurface(surface, h.evidence[surface]),
      mode: "interactive",
      declared_by_doctor: declaredByDoctor(h.doctorText, surface, ctx.labels[h.id]),
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
export function evidenceOf(ctx, hosts) {
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
    hosts: hosts.map((h) => h.id),
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
