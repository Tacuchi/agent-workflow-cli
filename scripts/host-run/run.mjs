#!/usr/bin/env node
// Maintainer tool: runs the plan-085 scenario inside the six covered hosts, each
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

import { spawnSync } from "node:child_process";
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
import { privacyViolations, violationCategory } from "./extract.mjs";
import { staleBuildInputs } from "./freshness.mjs";
import { HerdrClient, herdrArgv } from "./herdr.mjs";
import { COVERED_HOSTS, HOSTS, NOT_COVERED } from "./hosts.mjs";
import {
  Cleanup,
  cleanEnv,
  describeStep,
  nodeFs,
  planIsolation,
  productionDeps,
  rootTemplate,
  rotatedCredentials,
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

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, ...opts });
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
} catch (err) {
  console.error(err.message);
  process.exit(2);
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

const planFor = (id, root) =>
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
  });

/**
 * What the digest seals per host: the profile as written (its files and
 * effective rules), and the plan — pane command template with its args,
 * model/effort, every setup step and the credentials it copies.
 */
function hostView(id) {
  const plan = planFor(id, ROOT_PLACEHOLDER);
  const profile = profileFor(id);
  const files = plan.steps.find((s) => s.kind === "profile").files;
  return {
    effective: profile.effective({ workspace: plan.workspace, realHome }),
    files: files.map((f) => ({ path: f.path, kind: f.kind })),
    text: renderedText(files),
    pane_command: plan.pane.command,
    setup: plan.steps.map(describeStep),
    credentials: HOSTS[id].credentials,
    model: args.model[id] ?? null,
    effort: args.effort[id] ?? null,
  };
}

const hostViews = Object.fromEntries(args.hosts.map((id) => [id, hostView(id)]));
const digest = approvalDigest(scenario, hostViews);
/** The temp dir by its real path (macOS /var → /private/var), so path rules match. */
const TMP_ROOT = realpathSync(tmpdir());
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
  const creds = HOSTS[id].credentials.map(
    (rel) => `${join("~", rel)} ${existsSync(join(realHome, rel)) ? "(present)" : "(absent)"}`,
  );
  const keychain = HOSTS[id].keychain
    ? " — also the system keychain, which is NOT copied: the auth probe decides"
    : "";
  return `  credentials to copy: ${creds.join(", ") || "(none)"}${keychain}`;
}

function showHost(out, id) {
  const root = `${rootTemplate(TMP_ROOT, runId, id)}XXXXXX`;
  const plan = planFor(id, root);
  const view = hostViews[id];
  const without = cleanEnv({ root: "/nonexistent" }).PATH;
  out(`\n### ${id}  (binary: ${hostBins[id] ?? "NOT FOUND"})`);
  out(`  disposable root (mkdtemp, 0700): ${root}`);
  out(`  home: ${plan.home}`);
  out(`  workspace: ${plan.workspace} (git repo, no remote)`);
  out(
    `  shims first on PATH: command -v aw → ${join(root, "bin", "aw")}, command -v agent-workflow → ${join(root, "bin", "agent-workflow")} (both exec ${plan.node} ${plan.cliMain}, the root's own copy of the checkout)`,
  );
  out(
    `  without the shims that PATH would resolve: aw → ${commandV("aw", without) ?? "(none)"}, agent-workflow → ${commandV("agent-workflow", without) ?? "(none)"}`,
  );
  out("  setup (env -i, the same clean env as the pane):");
  for (const s of plan.steps) out(`    - ${describeStep(s)}`);
  out(credentialLine(id));
  out(
    `  profile files: ${view.files.map((f) => `${f.path} [${f.kind}]`).join(", ") || "(none: agy without profile)"}`,
  );
  out(
    `  effective permissions: ${JSON.stringify(profileFor(id).effective({ workspace: plan.workspace, realHome }))}`,
  );
  for (const l of profileFor(id).limitations) out(`  limitation: ${l}`);
  out(`  pane command: ${plan.pane.command}`);
  out(
    `  herdr: ${["herdr", ...herdrArgv.createWorkspace(plan.workspace, `host-run-${id}`)].join(" ")}`,
  );
  const kind = HOSTS[id].herdrKind ? "" : "  (no Herdr kind: state read from the screen)";
  out(`  herdr: herdr pane run <root-pane> '<pane command>'${kind}`);
}

function show(out = console.log) {
  out(`Host run (plan 085) — checkout ${cli.version} @ ${cli.revision}, run id ${runId}`);
  out(
    `src tree sha256 ${cli.src_sha256} (dist built after every src, skills and package.json change)`,
  );
  const uncovered = Object.entries(NOT_COVERED).map(([h, r]) => `${h} (${r})`);
  out(`Hosts: ${args.hosts.join(", ")}; not covered: ${uncovered.join("; ")}`);
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

const code = await launch({
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  env: process.env,
  markers: agentMarkers(HARNESSES),
  ancestor: () => agentAncestor(processChain(process.ppid, psInfo)),
  digest,
  show,
  log: (m) => console.error(m),
  ask: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  },
  start: () => startLive(),
});
process.exit(code);

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

function openHosts(herdr, plans, cleanup) {
  return plans.map((plan) => {
    const opened = herdr.openPane(plan.workspace, `host-run-${plan.host}`, plan.pane.command);
    cleanup.addHook(() => herdr.close(opened.workspace));
    const out =
      sh(hostBins[plan.host], ["--version"], { env: plan.env, cwd: plan.workspace }).stdout ?? "";
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
      model: exposes.model ? (args.model[plan.host] ?? null) : null,
      effort: exposes.effort ? (args.effort[plan.host] ?? null) : null,
      agyWithoutProfile: plan.host === "gemini" && args.agyWithoutProfile,
      phase: "send",
      stepIndex: 0,
      evidence: {},
      screensBySurface: {},
    };
  });
}

function liveContext(herdr, transcriptsDir, live) {
  return {
    herdr,
    steps,
    answers: new Set(steps.flatMap((s) => s.boundaries.map((b) => b.answer))),
    catalog: catalogStates(HARNESSES, capabilitiesFor),
    labels: Object.fromEntries(HARNESSES.map((h) => [h.id, h.label])),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    transcript: (id, screen) =>
      writeFileSync(
        join(transcriptsDir, `${id}.log`),
        `\n--- ${new Date().toISOString()}\n${screen}`,
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
        sourcesStdout: sh(h.nodeBin, [h.cliMain, "sources", "--no-git"], {
          env: h.env,
          cwd: h.workspace,
        }).stdout,
        localToml: existsSync(join(h.workspace, ".kimi-code", "local.toml"))
          ? readFileSync(join(h.workspace, ".kimi-code", "local.toml"), "utf8")
          : null,
      }),
    readHostMemory: (h) => {
      const argv = [h.cliMain, "host-memory", "--json", "--host", HOSTS[h.id].installTarget];
      const r = sh(h.nodeBin, argv, { env: h.env, cwd: h.workspace });
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    },
  };
}

function writeEvidence(matrix, extracts, privacy) {
  // Everything committed goes through the same filter as the extracts.
  const problems = privacyViolations(matrix, privacy);
  if (problems.length > 0) {
    throw new Error(
      `matrix not written: ${[...new Set(problems.map(violationCategory))].join("; ")}`,
    );
  }
  const dir = join(RUNS_DIR, runId);
  mkdirSync(dir, { recursive: true });
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
  if (problems.length > 0) {
    throw new Error(
      `ledger not written: ${[...new Set(problems.map(violationCategory))].join("; ")}`,
    );
  }
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
      const kept = join(transcriptsDir, "rotated-credentials", plan.host, rel);
      mkdirSync(dirname(kept), { recursive: true, mode: 0o700 });
      cpSync(to, kept, { recursive: true });
      console.log(
        `[${plan.host}] its credential ${rel} changed during the run (a rotated token?). The new copy is in ${kept}; your real file was not touched — replace it yourself if the host logged you out.`,
      );
    }
  }
}

async function startLive() {
  const missing = args.hosts.filter((id) => hostBins[id] === null);
  if (missing.length > 0) {
    console.error(`host binaries not found: ${missing.join(", ")}; nothing was opened`);
    return 1;
  }
  const live = await import("./live.mjs");
  const remove = (p) => rmSync(p, { recursive: true, force: true });
  const cleanup = new Cleanup(remove);
  cleanup.install();
  live.sweep(TMP_ROOT, remove, console.log);
  const run = (cmd, argv, { env, cwd }) => sh(cmd, argv, { env, cwd, timeout: 180000 });
  const makeRoot = (id) => {
    const root = mkdtempSync(rootTemplate(TMP_ROOT, runId, id));
    chmodSync(root, 0o700);
    return root;
  };
  // Kept on purpose after the run: the full transcript is the person's, outside the repo.
  const transcriptsDir = mkdtempSync(join(TMP_ROOT, `aw-host-transcripts-${runId}-`));
  // Registered BEFORE preparing: an auth probe can already rotate a token, and a
  // failure or a signal during preparation must not lose the rotated copy.
  const planned = [];
  cleanup.addHook(() => keepRotatedCredentials(planned, transcriptsDir));
  const plans = live.prepareAll({
    hosts: args.hosts,
    makeRoot,
    cleanup,
    planFor: (id, root) => {
      const plan = planFor(id, root);
      planned.push(plan);
      return plan;
    },
    prepareDeps: { fs: nodeFs(), run, cliMain: CLI_MAIN, node },
    log: console.log,
  });
  if (plans === null) {
    cleanup.run();
    return 1;
  }

  const herdr = new HerdrClient((argv) => sh("herdr", argv));
  // The evidence names the Workline it exercised: every root's copy hashed equal
  // to the checkout (the copy-cli step refuses otherwise).
  const copies = plans.map((p) => p.steps.find((st) => st.kind === "copy-cli"));
  const trees = [...new Set(copies.map((c) => `${c?.treeHash}:${c?.depsHash}`))];
  if (trees.length !== 1 || !copies[0]?.treeHash)
    throw new Error("the roots do not all run the same copy of the checkout");
  const cliEvidence = { ...cli, tree_sha256: copies[0].treeHash, deps_sha256: copies[0].depsHash };
  const hosts = openHosts(herdr, plans, cleanup);
  const ctx = liveContext(herdr, transcriptsDir, live);
  await live.walk(ctx, hosts);

  const date = new Date().toISOString().slice(0, 10);
  const privacy = { realHome, username: userInfo().username, foreignMcp: foreignMcpNames() };
  const { matrix, extracts } = live.evidenceOf(
    { ...ctx, runId, date, cli: cliEvidence, digest, ...privacy },
    hosts,
  );
  const dir = writeEvidence(matrix, extracts, privacy);
  writeLedger(privacy);
  const ids = listRunIds();
  if (ids.length >= 2) {
    const found = regressions(loadMatrix(ids.at(-2)), matrix);
    const list = found.map((r) => `${r.host}/${r.surface} ${r.from}→${r.to}`).join(", ");
    console.log(
      found.length === 0 ? "no regressions against the previous run" : `regressions: ${list}`,
    );
  }
  console.log(`evidence: ${dir}\nfull transcripts (kept, never committed): ${transcriptsDir}`);
  cleanup.run();
  return 0;
}
