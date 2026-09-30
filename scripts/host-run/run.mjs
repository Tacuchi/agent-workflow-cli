#!/usr/bin/env node
// Maintainer tool: runs the plan-085 scenario inside the five covered hosts, each
// in a disposable home with the checkout's Workline, in its own Herdr pane.
//
// Usage:
//   node scripts/host-run/run.mjs --dry-run      what it would do; prepares and opens nothing
//   node scripts/host-run/run.mjs [--model <host>=<m>]… [--effort <host>=<e>]…
//                                 [--hosts h1,h2] [--steps s1,s2] [--agy-without-profile]
//
// Only a person runs it, from a real terminal outside any agent host, after
// typing the digest of the scenario, profiles and pane commands it shows. It
// answers only the scenario's fixed labels; every permission stays with the
// person, in the pane.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  agentAncestor,
  agentMarkers,
  approvalDigest,
  parseArgs,
  processChain,
} from "./approval.mjs";
import { RUNS_DIR, listRunIds, loadMatrix, mergedRunBlocks, regressions } from "./compare.mjs";
import { privacyViolations, redactSecrets, violationCategory } from "./extract.mjs";
import { staleBuildInputs } from "./freshness.mjs";
import { HerdrClient, herdrArgv } from "./herdr.mjs";
import { COVERED_HOSTS, HOSTS, NOT_COVERED, TOKEN_VARS, tokenSpec, tokenSpecs } from "./hosts.mjs";
import {
  Cleanup,
  capturedRun,
  capturedRunSync,
  cleanEnv,
  describeStep,
  keptMessage,
  makeRoot,
  nodeFs,
  openPaneWithToken,
  planIsolation,
  prepareHost,
  productionDeps,
  reapRootProcesses,
  rootTemplate,
  rotatedCredentials,
  withoutTokens,
  workspaceGuard,
} from "./isolation.mjs";
import { launch } from "./launch.mjs";
import { mergeRun, parseLedgerSource, renderLedger } from "./ledger.mjs";
import { catalogStates } from "./matrix.mjs";
import { PROFILES, loadProfiles, renderedText } from "./profiles/index.mjs";
import { STEPS, buildScenario, resolveSteps } from "./scenario.mjs";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_MAIN = join(CHECKOUT, "dist", "cli", "main.js");
const LEDGER = join(CHECKOUT, "src", "domain", "host-verification.ts");
/** The placeholder root the digest and --dry-run render plans against. */
const ROOT_PLACEHOLDER = "<root>";

/**
 * Every command the run spawns inherits the person's env WITHOUT any host token
 * (herdr, npm, git, ps, version reads) unless it passes its own env; the only
 * process that ever sees a token is its host's wrapper.
 */
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30000,
    env: withoutTokens(process.env, TOKEN_VARS),
    ...opts,
  });
}

/** `command -v` under a given PATH, read-only. */
function commandV(name, path) {
  const r = sh("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { env: { PATH: path } });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

function resolveBin(harness, home) {
  for (const bin of harness.runtime.bins) {
    const found = commandV(bin, process.env.PATH ?? "");
    if (found) return found;
  }
  for (const p of harness.runtime.fallbackBinPaths ?? []) {
    const abs = p.startsWith("~") ? join(home, p.slice(1)) : p;
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Revision and dirtiness without refreshing the index (`--no-optional-locks`). */
function checkoutInfo() {
  const git = (...a) => sh("git", ["--no-optional-locks", "-C", CHECKOUT, ...a]).stdout.trim();
  const rev = git("rev-parse", "--short", "HEAD") || "unknown";
  const dirty = git("status", "--porcelain").length > 0;
  const version = JSON.parse(readFileSync(join(CHECKOUT, "package.json"), "utf8")).version;
  return {
    version,
    revision: dirty ? `${rev}-dirty` : rev,
    src_sha256: nodeFs().treeHash(CHECKOUT, ["src"]),
  };
}

function psInfo(pid) {
  const r = sh("ps", ["-o", "ppid=,args=", "-p", String(pid)]);
  const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout ?? "");
  return m ? { ppid: Number(m[1]), args: m[2] } : null;
}

if (!existsSync(CLI_MAIN)) {
  console.error(`dist not built: ${CLI_MAIN} is missing. Run 'npm run build' first.`);
  process.exit(1);
}

// The run exercises dist: it must be built from the checkout as it is now.
const stale = staleBuildInputs(CHECKOUT);
if (stale.length > 0) {
  console.error(
    `dist is older than the checkout (${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""}). Run 'npm run build' first; nothing was prepared or opened.`,
  );
  process.exit(1);
}

let args;
let steps;
try {
  const argv = process.argv.slice(2);
  // A host the catalog does not cover (kimi, excluded by the person) is refused by name.
  const hostsAt = argv.indexOf("--hosts");
  for (const h of hostsAt >= 0 ? (argv[hostsAt + 1] ?? "").split(",") : []) {
    if (h in NOT_COVERED) throw new Error(`${h}: not covered: ${NOT_COVERED[h]}`);
  }
  if (argv.includes("--agy-token-file")) {
    throw new Error(
      "--agy-token-file was removed: agy signs in with your own login inside its pane when the run starts; a Gemini API key goes to crush only (--crush-gemini-key-file)",
    );
  }
  const agyWithoutProfile = argv.includes("--agy-without-profile");
  args = {
    ...parseArgs(
      argv.filter((a) => a !== "--agy-without-profile"),
      COVERED_HOSTS,
    ),
    agyWithoutProfile,
  };
  const resolved = args.steps ? resolveSteps(args.steps) : { steps: STEPS, added: [] };
  steps = resolved.steps;
  if (resolved.added.length > 0) {
    console.log(`--steps: added the steps they depend on: ${resolved.added.join(", ")}`);
  }
  if (args.dryRun && args.authCheck)
    throw new Error("--dry-run and --auth-check are separate runs");
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

/**
 * A token host's token, trimmed: from --<host>-token-file when given, else from
 * the person's env. Empty or whitespace-only is absent; a missing file or a
 * value with a newline is a one-line refusal. The value itself is never
 * printed, sealed or hashed — only whether it is there.
 */
function tokenValue(t) {
  if (!t) return null;
  const file = args.tokenFiles[t.flag];
  if (file && !existsSync(file)) refuse(`${t.flag}: no such file: ${file}`);
  const value = (file ? readFileSync(file, "utf8") : (process.env[t.env] ?? "")).trim();
  if (/[\r\n]/.test(value)) refuse(`${t.label} contains a newline: give one token on one line`);
  return value.length > 0 ? value : null;
}

function refuse(message) {
  console.error(message);
  process.exit(2);
}

/** The token spec in force for a host: crush takes the first key given (Gemini first). */
const specOf = (id) => tokenSpec(id, (spec) => tokenValue(spec) !== null);

const tokenPresent = (id) => (specOf(id) ? tokenValue(specOf(id)) !== null : null);

/**
 * The token values of the selected hosts, keyed by HOST (live run or
 * --auth-check only): a host's value reaches only its own host's wrapper (a
 * GEMINI_API_KEY in the env is crush's; agy never takes one), each from
 * its own flag, and each reaches only its own host's wrapper.
 */
function readTokens() {
  const out = {};
  for (const id of args.hosts) {
    const value = tokenValue(specOf(id));
    if (value) out[id] = value;
  }
  return out;
}

/**
 * A failed probe of a host whose token or key is absent: its reason line also
 * names what would authenticate it (fixed text from hosts.mjs).
 */
function withAbsentHint(id, steps) {
  const spec = specOf(id);
  const failed = steps.find((st) => !st.ok && st.step.startsWith("auth probe"));
  if (failed && spec?.absent && !tokenPresent(id))
    failed.reason = `${failed.reason}; ${spec.absent}`;
  return steps;
}

/**
 * Writes a failed probe's output — already redacted — to a 0600 file in the
 * 0700 transcripts dir (`dirOf()` creates it on first use) and returns its path.
 */
const probeKeeper = (dirOf) => (host, text) => {
  const path = join(dirOf(), `probe-${host}.log`);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

/**
 * Cleanup's reap (after the Herdr close hooks): ends the roots' processes and
 * names any terminal still inside a root, which it never kills.
 */
function reapAndTell(roots) {
  const message = keptMessage(reapRootProcesses(roots).kept);
  if (message) console.error(message);
}

/**
 * Every setup step and probe: no stdin, output captured, no controlling
 * terminal, asynchronous (Ctrl-C reaches the run at once), group killed after.
 */
const hostRun = capturedRun(spawn);
/** The live loop's short reads, with the same isolation. */
const hostRead = capturedRunSync(spawnSync);

/**
 * One environment variable feeding two hosts (OPENAI_API_KEY to opencode and
 * crush, GEMINI_API_KEY): each host still gets it only through its own wrapper,
 * but the person is told, and pointed at the per-host flags. A host whose flag
 * file is given never takes the variable.
 */
function sharedEnvWarnings() {
  const byVar = {};
  for (const id of args.hosts) {
    const spec = specOf(id);
    if (!spec || args.tokenFiles[spec.flag] || !(process.env[spec.env] ?? "").trim()) continue;
    byVar[spec.env] = [...(byVar[spec.env] ?? []), { id, flag: spec.flag }];
  }
  return Object.entries(byVar)
    .filter(([, hosts]) => hosts.length > 1)
    .map(
      ([v, hosts]) =>
        `WARNING: ${v} in this shell feeds ${hosts.map((h) => h.id).join(" and ")}; prefer one file per host: ${hosts.map((h) => h.flag).join(", ")}`,
    );
}

/** What crush runs against, disclosed wherever crush is. */
function crushProvider() {
  const spec = specOf("crush");
  const both = HOSTS.crush.tokenChoices.every((c) => tokenValue(c) !== null);
  if (!tokenPresent("crush"))
    return "crush → your own crush data (no provider key: GEMINI_API_KEY / --crush-gemini-key-file, or OPENAI_API_KEY / --crush-openai-key-file)";
  return `crush → ${spec.provider}/${spec.model} (${spec.label}: present, value never shown)${both ? "; both keys given: Gemini (free) is used" : ""}`;
}

/**
 * What agy runs against, disclosed wherever agy is: always the person's own
 * login, done inside its pane when the run starts. A GEMINI_API_KEY in the env
 * is crush's alone, and is said so.
 */
function agyProvider() {
  const keySeen = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((v) => (process.env[v] ?? "").trim());
  return `agy → sign-in in the pane (you sign in when the run starts): no agy probe runs, the run waits for your login and sends nothing meanwhile${keySeen ? "; GEMINI_API_KEY/GOOGLE_API_KEY in this shell go to crush only, never to agy" : ""}`;
}

const { HARNESSES } = await import(join(CHECKOUT, "dist", "domain", "harnesses.js"));
const { capabilitiesFor } = await import(
  join(CHECKOUT, "dist", "application", "self", "host-states.js")
);
const realHome = homedir();
const node = process.execPath;
const cli = checkoutInfo();
/** The production dependency closure each root gets a copy of (from package-lock.json). */
const PROD_DEPS = productionDeps(
  existsSync(join(CHECKOUT, "package-lock.json"))
    ? readFileSync(join(CHECKOUT, "package-lock.json"), "utf8")
    : "",
  (rel) => existsSync(join(CHECKOUT, rel)),
);
const profiles = loadProfiles(PROFILES, { home: "<home>", workspace: "<workspace>", node });
const scenario = buildScenario(args.hosts, steps);
const harnessOf = (id) => HARNESSES.find((h) => h.id === id);
const hostBins = Object.fromEntries(
  args.hosts.map((id) => [id, resolveBin(harnessOf(id), realHome)]),
);
const profileFor = (id) =>
  id === "gemini" && args.agyWithoutProfile
    ? {
        ...profiles[id],
        files: () => [],
        paneArgs: [],
        deniedIn: () => [],
        allowedIn: () => [],
        // Nothing is written, so nothing is shown as if it were.
        effective: () => ({ profile: "none: agy runs with its own defaults and asks you" }),
        limitations: ["no profile: every permission goes to you, and the matrix records it"],
      }
    : profiles[id];

const planFor = (id, root, siblingRoots = []) =>
  planIsolation({
    hostId: id,
    root,
    checkout: CHECKOUT,
    node,
    hostBin: hostBins[id] ?? `<${HOSTS[id].bin} not found>`,
    realHome,
    profile: profileFor(id),
    model: args.model[id],
    effort: args.effort[id],
    deps: PROD_DEPS,
    tokenPresent: tokenPresent(id) === true,
    token: specOf(id),
    siblingRoots,
  });

/**
 * What the digest seals per host: the profile as written (its files and
 * effective rules), and the plan — pane command template with its args,
 * model/effort, every setup step and the credentials it copies.
 */
/** Every other selected host's root, as the same placeholder form. */
const siblingsOf = (id, rootOf) => args.hosts.filter((h) => h !== id).map(rootOf);

/** What `effective()` needs to show a profile as it would be written. */
const effectiveCtx = (id, plan, siblingRoots) => ({
  workspace: plan.workspace,
  home: plan.home,
  realHome,
  root: plan.root,
  siblingRoots,
  tokenPresent: tokenPresent(id) === true,
  providerModel: plan.providerModel,
});

function hostView(id) {
  const siblings = siblingsOf(id, (h) => `${ROOT_PLACEHOLDER}:${h}`);
  const plan = planFor(id, ROOT_PLACEHOLDER, siblings);
  const profile = profileFor(id);
  const files = plan.steps.find((s) => s.kind === "profile").files;
  return {
    effective: profile.effective(effectiveCtx(id, plan, siblings)),
    files: files.map((f) => ({ path: f.path, kind: f.kind })),
    text: renderedText(files),
    // What is typed, and the launcher it runs: the person approves what runs.
    pane_command: plan.pane.command,
    pane_launcher: plan.pane.launcher.source,
    setup: plan.steps.map(describeStep),
    workspace_seeds: plan.workspaceSeeds,
    credentials: HOSTS[id].credentials,
    model: args.model[id] ?? null,
    effort: args.effort[id] ?? null,
    // Only whether a token is there: never its value, never a hash of it.
    ...(specOf(id) ? { token: tokenPresent(id) ? "present" : "absent" } : {}),
    ...(plan.providerModel ? { provider: plan.providerModel } : {}),
    // The person's consent is part of what they approve.
    ...(plan.signInInPane ? { sign_in: "sign-in in the pane, real keychain accepted" } : {}),
  };
}

const hostViews = Object.fromEntries(args.hosts.map((id) => [id, hostView(id)]));
const digest = approvalDigest(scenario, hostViews);
/** The temp dir by its real path (macOS /var → /private/var), so path rules match. */
const TMP_ROOT = realpathSync(tmpdir());
/** What `makeRoot` creates a root with: used only after the person confirmed. */
const rootFs = {
  mkdtemp: (prefix) => mkdtempSync(prefix),
  chmod: (path, mode) => chmodSync(path, mode),
  writeFile: (path, text, mode) => writeFileSync(path, text, { mode }),
};
const runId = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace(/-\d{3}Z$/, "Z");

function showScenario(out) {
  out("\n== Scenario (fixed answers are literal CLI labels) ==");
  for (const step of scenario.steps) {
    out(`\n[${step.surface}] ${step.goal}`);
    for (const b of step.boundaries) {
      const labels = JSON.stringify([...b.labels, ...scenario.flow_controls]);
      out(`  boundary ${b.id}: labels ${labels} → answer '${b.answer}'`);
    }
    if (step.boundaries.length === 0) out("  boundaries: none (anything shown goes to you)");
    out(`  stop: ${step.stop}`);
    for (const [host, inv] of Object.entries(step.hosts)) {
      out(`  ${host.padEnd(12)} ${inv.via === "palette" ? "(palette) " : ""}${inv.text}`);
    }
  }
}

function credentialLine(id) {
  if (HOSTS[id].signInInPane)
    return `  credentials to copy: (none) — agy signs in inside its pane when the run starts (no probe)\n  WARNING: ${HOSTS[id].keychainNotice}`;
  // A provider key replaces the person's own crush data: nothing is copied then.
  if (specOf(id)?.provider && tokenPresent(id))
    return `  credentials to copy: (none) — ${specOf(id).label} is used instead of your own data`;
  const creds = HOSTS[id].credentials.map(
    (rel) => `${join("~", rel)} ${existsSync(join(realHome, rel)) ? "(present)" : "(absent)"}`,
  );
  const keychain = HOSTS[id].keychain
    ? " — also the system keychain, which is NOT copied: the auth probe decides"
    : "";
  return `  credentials to copy: ${creds.join(", ") || "(none)"}${keychain}`;
}

/** The dry-run's token lines for a host: presence only, and where it would come from. */
function tokenLines(id) {
  const specs = tokenSpecs(id);
  if (HOSTS[id].signInInPane) return [`  ${agyProvider()}`];
  if (specs.length === 0)
    return ["  token: this host takes no token through a variable here; the auth probe decides"];
  const lines = specs.map((t) => {
    const state = tokenValue(t) !== null ? "present" : "absent";
    const source = args.tokenFiles[t.flag] ? `from ${t.flag}` : `from ${t.env}`;
    const absent =
      state === "absent" ? ` — ${t.absent ?? "without it the auth probe decides"}` : "";
    return `  ${t.label}: ${state} (${source}; value never shown)${absent}`;
  });
  return [...lines, ...(id === "crush" ? [`  ${crushProvider()}`] : [])];
}

function showHost(out, id) {
  const root = `${rootTemplate(TMP_ROOT, runId, id)}XXXXXX`;
  const siblings = siblingsOf(id, (h) => `${rootTemplate(TMP_ROOT, runId, h)}XXXXXX`);
  const plan = planFor(id, root, siblings);
  const view = hostViews[id];
  const without = cleanEnv({ root: "/nonexistent" }).PATH;
  out(`\n### ${id}  (binary: ${hostBins[id] ?? "NOT FOUND"})`);
  out(`  disposable root (mkdtemp, 0700): ${root}`);
  out(`  home: ${plan.home}`);
  out(`  workspace: ${plan.workspace} (git repo, no remote)`);
  out(
    `  shims first on PATH: command -v aw → ${join(root, "bin", "aw")}, command -v agent-workflow → ${join(root, "bin", "agent-workflow")} (both exec ${plan.node} ${plan.cliMain}, the root's own copy of the checkout, through ${join(root, "bin", "aw-guard.mjs")}, which refuses any --root/--workspace whose realpath is outside the root)`,
  );
  out(
    `  without the shims that PATH would resolve: aw → ${commandV("aw", without) ?? "(none)"}, agent-workflow → ${commandV("agent-workflow", without) ?? "(none)"}`,
  );
  out("  setup (env -i, the same clean env as the pane):");
  for (const s of plan.steps) out(`    - ${describeStep(s)}`);
  for (const seed of plan.workspaceSeeds ?? [])
    out(`    - seed the workspace: ${seed.path} (${seed.text.trim()})`);
  out(credentialLine(id));
  for (const line of tokenLines(id)) out(line);
  out(
    `  profile files: ${view.files.map((f) => `${f.path} [${f.kind}]`).join(", ") || "(none: agy without profile)"}`,
  );
  out(
    `  effective permissions: ${JSON.stringify(profileFor(id).effective(effectiveCtx(id, plan, siblings)))}`,
  );
  for (const l of profileFor(id).limitations) out(`  limitation: ${l}`);
  out(`  pane launcher ${plan.pane.launcher.path} (0700): ${plan.pane.launchLine}`);
  out(
    `  typed into the pane: ${plan.pane.command} (${Buffer.byteLength(plan.pane.command)} bytes)`,
  );
  out(
    `  herdr: ${["herdr", ...herdrArgv.createWorkspace(plan.workspace, `host-run-${id}`)].join(" ")}`,
  );
  const kind = HOSTS[id].herdrKind ? "" : "  (no Herdr kind: state read from the screen)";
  out(`  herdr: herdr pane run <root-pane> ${plan.pane.command}${kind}`);
}

function show(out = console.log) {
  out(`Host run (plan 085) — checkout ${cli.version} @ ${cli.revision}, run id ${runId}`);
  out(
    `src tree sha256 ${cli.src_sha256} (dist built after every src, skills and package.json change)`,
  );
  const uncovered = Object.entries(NOT_COVERED).map(([h, r]) => `${h} (${r})`);
  out(`Hosts: ${args.hosts.join(", ")}; not covered: ${uncovered.join("; ")}`);
  for (const w of sharedEnvWarnings()) out(w);
  showScenario(out);
  out("\n== Per host ==");
  for (const id of args.hosts) showHost(out, id);
  out(`\nEvidence: tests/fixtures/host-runs/${runId}/matrix.json + extracts/; ledger: ${LEDGER}`);
  out(
    "Full transcripts: $TMPDIR/aw-host-transcripts-<run id>-*, kept on purpose, never committed.",
  );
  out(`Approval digest: ${digest}`);
}

if (args.dryRun) {
  show();
  console.log("\n--dry-run: nothing was prepared, copied, installed or opened.");
  process.exit(0);
}

if (args.authCheck) {
  const { authCheck } = await import("./authcheck.mjs");
  process.exit(await runAuthCheck(authCheck));
}

const code = await launch({
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  env: process.env,
  markers: agentMarkers(HARNESSES),
  ancestor: () => agentAncestor(processChain(process.ppid, psInfo)),
  digest,
  show,
  log: (m) => console.error(m),
  ask: askLine,
  start: () => startLive(),
});
process.exit(code);

/** `--auth-check`: prepare each root, run its auth probe only, report, clean up. No Herdr. */
async function runAuthCheck(authCheck) {
  const remove = (p) => rmSync(p, { recursive: true, force: true });
  const cleanup = new Cleanup(remove, undefined, reapAndTell);
  cleanup.install();
  const { sweep } = await import("./live.mjs");
  // Every root exists before any is prepared, so each profile denies the others.
  // Nothing is swept or created before the person typed the confirmation word.
  const roots = {};
  const makeRoots = () => {
    sweep(TMP_ROOT, remove, console.log);
    for (const id of args.hosts) {
      roots[id] = makeRoot(rootFs, TMP_ROOT, runId, id);
      cleanup.track(roots[id]);
    }
  };
  const planned = [];
  let keptDir = null;
  const keptIn = () => {
    keptDir ??= mkdtempSync(join(TMP_ROOT, `aw-host-transcripts-${runId}-`));
    return keptDir;
  };
  cleanup.addHook(() => keepRotatedCredentials(planned, keptIn));
  const secrets = readTokens();
  // Every line to the terminal is redacted too (the probes' output never gets here).
  const log = (m) => console.log(redactSecrets(m, Object.values(secrets)));
  return authCheck({
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    env: process.env,
    markers: agentMarkers(HARNESSES),
    ancestor: () => agentAncestor(processChain(process.ppid, psInfo)),
    hosts: args.hosts,
    notes: [
      ...(args.hosts.includes("gemini")
        ? [agyProvider(), `WARNING: ${HOSTS.gemini.keychainNotice}`]
        : []),
      ...(args.hosts.includes("crush") ? [crushProvider()] : []),
      ...sharedEnvWarnings(),
    ],
    beforePrepare: makeRoots,
    inPane: args.hosts.filter((id) => HOSTS[id].signInInPane),
    tokens: Object.fromEntries(
      args.hosts
        .filter((id) => specOf(id))
        .map((id) => [
          id,
          { label: specOf(id).label, state: tokenPresent(id) ? "present" : "absent" },
        ]),
    ),
    ask: askLine,
    log,
    prepare: async (id) => {
      if (hostBins[id] === null)
        return [
          {
            step: "resolve the host binary",
            ok: false,
            detail: "not found",
            reason: "host binary not found",
          },
        ];
      const root = roots[id];
      const plan = planFor(
        id,
        root,
        Object.values(roots).filter((r) => r !== root),
      );
      planned.push(plan);
      const steps = await prepareHost(plan, {
        fs: nodeFs(),
        run: hostRun,
        cliMain: CLI_MAIN,
        node,
        secrets,
        keepProbeOutput: probeKeeper(keptIn),
      });
      return withAbsentHint(id, steps);
    },
    finish: () => cleanup.run(),
  });
}

async function askLine(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

/** Names of the person's own Workline MCP connections, so no extract can carry one. */
function foreignMcpNames() {
  const r = sh(node, [CLI_MAIN, "self", "mcp", "--action", "list"]);
  try {
    return (JSON.parse(r.stdout)?.data?.connections ?? JSON.parse(r.stdout)?.connections ?? [])
      .map((c) => c.name ?? c.connection)
      .filter((n) => typeof n === "string");
  } catch {
    return [];
  }
}

async function openWithToken(herdr, plan, tokens, cleanup) {
  // The close hook is registered the moment the workspace exists: a Ctrl-C
  // during the launch or the token pick-up wait still closes it.
  const opened = await openPaneWithToken(nodeFs(), herdr, plan, tokens[plan.host], {
    onCreated: (ws) => cleanup.addHook(() => herdr.close(ws)),
  });
  if (opened.notice) console.log(`[${plan.host}] ${opened.notice}`);
  return opened.pane;
}

/** What the matrix records per host about how it ran: agy's sign-in and keychain, crush's provider. */
function hostRecords(plan) {
  const agy = plan.host === "gemini";
  return {
    agyWithoutProfile: agy && args.agyWithoutProfile,
    agyModelProvider: agy ? "sign-in-in-pane" : null,
    agyKeychain: HOSTS[plan.host].keychainState ?? null,
    crushProviderModel: plan.host === "crush" ? (plan.providerModel ?? "own-data") : null,
  };
}

async function openHost(herdr, plan, cleanup, tokens) {
  const opened = await openWithToken(herdr, plan, tokens, cleanup);
  const out =
    hostRead(hostBins[plan.host], ["--version"], {
      env: plan.env,
      cwd: plan.workspace,
      timeout: 30000,
    }).stdout ?? "";
  const exposes = HOSTS[plan.host].exposes;
  return {
    id: plan.host,
    ...opened,
    root: plan.root,
    home: plan.home,
    workspace: plan.workspace,
    env: plan.env,
    // The root's own node and CLI copy, for every read the run makes of the host.
    nodeBin: plan.node,
    cliMain: plan.cliMain,
    version: /\d+\.\d+[\w.\-+]*/.exec(out)?.[0] ?? null,
    model: exposes.model ? (plan.model ?? null) : null,
    effort: exposes.effort ? (args.effort[plan.host] ?? null) : null,
    ...hostRecords(plan),
    phase: "send",
    stepIndex: 0,
    evidence: {},
    screensBySurface: {},
  };
}

function liveContext(herdr, transcriptsDir, live, secretValues = []) {
  return {
    herdr,
    steps,
    answers: new Set(steps.flatMap((s) => s.boundaries.map((b) => b.answer))),
    catalog: catalogStates(HARNESSES, capabilitiesFor),
    labels: Object.fromEntries(HARNESSES.map((h) => [h.id, h.label])),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // The full transcript is local only, and even there no token is written.
    transcript: (id, screen) =>
      writeFileSync(
        join(transcriptsDir, `${id}.log`),
        `\n--- ${new Date().toISOString()}\n${redactSecrets(screen, secretValues)}`,
        {
          flag: "a",
          mode: 0o600,
        },
      ),
    notify: live.makeNotifier((line) => process.stdout.write(line)),
    // Read before every send and answer, and once more for the evidence.
    guard: (h) =>
      workspaceGuard({
        root: h.root,
        workspace: h.workspace,
        home: h.home,
        sourcesStdout: hostRead(h.nodeBin, [h.cliMain, "sources", "--no-git"], {
          env: h.env,
          cwd: h.workspace,
        }).stdout,
        localToml: existsSync(join(h.workspace, ".kimi-code", "local.toml"))
          ? readFileSync(join(h.workspace, ".kimi-code", "local.toml"), "utf8")
          : null,
      }),
    // The CLI's own doctor in that home: the declarations when the host folds
    // its relay (claude). Read once per host, at the end.
    cliDoctorText: (h) => {
      h.cliDoctor ??=
        hostRead(h.nodeBin, [h.cliMain, "doctor", "--host", h.id, "--format", "human"], {
          env: h.env,
          cwd: h.workspace,
        }).stdout ?? "";
      return h.cliDoctor;
    },
    readHostMemory: (h) => {
      const argv = [h.cliMain, "host-memory", "--json", "--host", HOSTS[h.id].installTarget];
      const r = hostRead(h.nodeBin, argv, { env: h.env, cwd: h.workspace });
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    },
  };
}

/** A refusal of ours, with its category: the stop line repeats it. */
function refused(what, problems) {
  const category = [...new Set(problems.map(violationCategory))].join("; ");
  const err = new Error(`${what} not written: ${category}`);
  err.category = category;
  return err;
}

function writeEvidence(matrix, extracts, privacy, dir = join(RUNS_DIR, runId)) {
  // Everything committed goes through the same filter as the extracts.
  const problems = privacyViolations(matrix, privacy);
  if (problems.length > 0) throw refused("matrix", problems);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
  for (const { path, extract } of extracts) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${JSON.stringify(extract, null, 2)}\n`);
  }
  return dir;
}

/** The ledger merged from the SOURCE file (dist may be stale), privacy-checked before writing. */
function writeLedger(privacy) {
  const all = listRunIds().map((id) => loadMatrix(id));
  const current = parseLedgerSource(readFileSync(LEDGER, "utf8"));
  const order = HARNESSES.map((h) => h.id);
  const text = renderLedger(mergeRun(current, mergedRunBlocks(all), order));
  const problems = privacyViolations({ text }, privacy);
  if (problems.length > 0) throw refused("ledger", problems);
  writeFileSync(LEDGER, text);
}

/**
 * A host may rotate the OAuth token it was given; that copy dies with the home.
 * Keep each changed copy in the transcripts dir (0700) and tell the person — the
 * real file is never overwritten.
 */
function keepRotatedCredentials(plans, transcriptsDir) {
  for (const plan of plans) {
    for (const { to, rel } of rotatedCredentials(plan, nodeFs().stamp)) {
      const dir = typeof transcriptsDir === "function" ? transcriptsDir() : transcriptsDir;
      const kept = join(dir, "rotated-credentials", plan.host, rel);
      mkdirSync(dirname(kept), { recursive: true, mode: 0o700 });
      cpSync(to, kept, { recursive: true });
      console.log(
        `[${plan.host}] its credential ${rel} changed during the run (a rotated token?). The new copy is in ${kept}; your real file was not touched — replace it yourself if the host logged you out.`,
      );
    }
  }
}

/**
 * A run that was stopped (Ctrl-C) may have left `host-run-*` workspaces open:
 * listed by label (read-only `herdr workspace list`), closed only if the person
 * says so.
 */
async function offerToCloseLeftovers(herdr, ask = askLine, log = console.log) {
  let left;
  try {
    left = herdr.leftoverWorkspaces();
  } catch {
    log("could not list Herdr workspaces (is the Herdr server running?); continuing");
    return;
  }
  if (left.length === 0) return;
  log(`Herdr workspaces left open by an earlier run: ${left.map((w) => w.label).join(", ")}`);
  const typed = await ask("Close them now? [y/N] ");
  if (typeof typed === "string" && /^y(es)?$/i.test(typed.trim())) {
    for (const w of left) herdr.close(w.id);
    log(`closed: ${left.map((w) => w.label).join(", ")}`);
  } else log("left open; close them yourself in Herdr");
}

async function startLive() {
  const missing = args.hosts.filter((id) => hostBins[id] === null);
  if (missing.length > 0) {
    console.error(`host binaries not found: ${missing.join(", ")}; nothing was opened`);
    return 1;
  }
  const live = await import("./live.mjs");
  // Read once, at launch; passed only to the token hosts' secret step, and to
  // every privacy filter as forbidden strings.
  const tokens = readTokens();
  const remove = (p) => rmSync(p, { recursive: true, force: true });
  const cleanup = new Cleanup(remove, undefined, reapAndTell);
  cleanup.install();
  live.sweep(TMP_ROOT, remove, console.log);
  const herdr = new HerdrClient((argv) => sh("herdr", argv));
  await offerToCloseLeftovers(herdr);
  // Kept on purpose after the run: the full transcript is the person's, outside the repo.
  const transcriptsDir = mkdtempSync(join(TMP_ROOT, `aw-host-transcripts-${runId}-`));
  // Registered BEFORE preparing: an auth probe can already rotate a token, and a
  // failure or a signal during preparation must not lose the rotated copy.
  const planned = [];
  cleanup.addHook(() => keepRotatedCredentials(planned, transcriptsDir));
  const plans = await live.prepareAll({
    hosts: args.hosts,
    makeRoot: (id) => makeRoot(rootFs, TMP_ROOT, runId, id),
    cleanup,
    planFor: (id, root, siblings) => {
      const plan = planFor(id, root, siblings);
      planned.push(plan);
      return plan;
    },
    prepareDeps: {
      fs: nodeFs(),
      run: hostRun,
      cliMain: CLI_MAIN,
      node,
      secrets: tokens,
      keepProbeOutput: probeKeeper(() => transcriptsDir),
    },
    log: (m) => console.log(redactSecrets(m, Object.values(tokens))),
  });
  const ctx = {
    ...liveContext(herdr, transcriptsDir, live, Object.values(tokens)),
    secrets: Object.values(tokens),
  };
  ctx.notify = live.makeNotifier((line) => process.stdout.write(line), ctx.secrets);
  const privacy = {
    realHome,
    username: userInfo().username,
    foreignMcp: foreignMcpNames(),
    secrets: Object.values(tokens),
  };
  // Whatever ends the run — a stop before the panes, a pane that cannot be
  // opened, an exception, Ctrl-C — a matrix is written (unreached cells
  // not-reached) and one line says why it stopped.
  const session = { hosts: [], finished: false };
  let cliEvidence = { ...cli };
  const finish = (hosts, stop) => {
    const { matrix, extracts } = live.evidenceOf(
      {
        ...ctx,
        runId,
        date: new Date().toISOString().slice(0, 10),
        cli: cliEvidence,
        digest,
        ...privacy,
      },
      hosts,
      { launched: args.hosts, stopped: stop },
    );
    if (stop) {
      // A stopped run's evidence stays out of the checkout: in the 0700
      // transcripts dir, never in tests/fixtures/host-runs, never in the ledger.
      const dir = writeEvidence(matrix, extracts, privacy, join(transcriptsDir, "stopped-run"));
      console.log(`stopped run's matrix (local only, not committed): ${join(dir, "matrix.json")}`);
      return;
    }
    const dir = writeEvidence(matrix, extracts, privacy);
    writeLedger(privacy);
    reportRegressions(matrix);
    console.log(`evidence: ${dir}\nfull transcripts (kept, never committed): ${transcriptsDir}`);
  };
  const say = (line) => console.error(redactSecrets(line, ctx.secrets));
  cleanup.addHook(() =>
    live.finishSession(session, finish, `interrupted by ${cleanup.stoppedBy ?? "exit"}`, say),
  );
  stopOnCrash(session, finish, say, cleanup);
  if (plans === null) {
    live.finishSession(session, finish, "preparation stopped before any pane opened", say);
    cleanup.run();
    return 1;
  }

  // The evidence names the Workline it exercised: every root's copy hashed equal
  // to the checkout (the copy-cli step refuses otherwise).
  const copies = plans.map((p) => p.steps.find((st) => st.kind === "copy-cli"));
  const trees = [...new Set(copies.map((c) => `${c?.treeHash}:${c?.depsHash}`))];
  if (trees.length !== 1 || !copies[0]?.treeHash) {
    live.finishSession(
      session,
      finish,
      "the roots do not all run the same copy of the checkout",
      say,
    );
    cleanup.run();
    return 1;
  }
  cliEvidence = { ...cli, tree_sha256: copies[0].treeHash, deps_sha256: copies[0].depsHash };
  const stop = await live.runLiveSession({
    session,
    plans,
    open: (plan) => openHost(herdr, plan, cleanup, tokens),
    ctx,
    finish,
    log: say,
  });
  if (session.error && !stop?.startsWith("herdr"))
    writeCrashLog(transcriptsDir, session.error, ctx.secrets, say);
  cleanup.run();
  return stop ? 1 : 0;
}

/** Regressions against the previous run, if there is one. */
function reportRegressions(matrix) {
  const ids = listRunIds();
  if (ids.length < 2) return;
  const found = regressions(loadMatrix(ids.at(-2)), matrix);
  const list = found.map((r) => `${r.host}/${r.surface} ${r.from}→${r.to}`).join(", ");
  console.log(
    found.length === 0 ? "no regressions against the previous run" : `regressions: ${list}`,
  );
}

/**
 * An internal error's stack, redacted, in a 0600 file of the transcripts dir:
 * the summary line stays one sanitized category; the detail is local only.
 */
function writeCrashLog(dir, err, secrets, say) {
  const path = join(dir, "run-error.log");
  writeFileSync(path, redactSecrets(String(err?.stack ?? err), secrets), { mode: 0o600 });
  say(`detail (redacted, local only): ${path}`);
}

/**
 * An exception or a rejection nobody awaited never ends the run silently: the
 * session is finished (matrix + one line), then cleanup runs and the run exits 1.
 */
function stopOnCrash(session, finish, say, cleanup) {
  const crash = async (err) => {
    const live = await import("./live.mjs");
    live.finishSession(session, finish, live.stopReason(err), say);
    cleanup.run();
    process.exit(1);
  };
  process.on("unhandledRejection", crash);
  process.on("uncaughtException", crash);
}
