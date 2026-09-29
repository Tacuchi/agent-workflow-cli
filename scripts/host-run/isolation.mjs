// Isolation per host: a disposable root (mkdtemp, 0700) holding the host's home,
// its workspace and the `aw`/`agent-workflow` shims, and a clean environment
// that points only there.
//
// `planIsolation` is pure — it is what `--dry-run` prints, with the mkdtemp
// suffix left as a placeholder. `prepareHost` executes a plan through injected
// fs/spawn, and `Cleanup` removes every root on exit and on SIGINT/SIGTERM/SIGHUP.
// SIGKILL cannot be caught: `staleRoots` finds what a dead run left behind.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { redactSecrets } from "./extract.mjs";
import { HOSTS, tokenSpec } from "./hosts.mjs";
import { mergeJson, mergeToml } from "./profiles/index.mjs";
import { PROBE_DSN, PROBE_MCP } from "./scenario.mjs";

/** Every disposable root starts with this, so a later start can recognize it. */
export const ROOT_PREFIX = "aw-host-run-";
export const MARKER_FILE = ".host-run.json";

/** Throwaway git identity: not an address, so the privacy filter has nothing to find. */
const GIT_IDENTITY = ["-c", "user.name=host-run", "-c", "user.email=host-run@invalid"];

export function rootTemplate(tmpRoot, runId, hostId) {
  return join(tmpRoot, `${ROOT_PREFIX}${runId}-${hostId}-`);
}

/**
 * The environment a pane and every setup command run with, built from nothing
 * (`env -i`). `OPENCODE_CONFIG`, `CLAUDE_CONFIG_DIR` and `AW_MCP_PROBE` are
 * deliberately absent: inheriting any of them points the host at the person's
 * real config.
 */
export function cleanEnv({ root, hostDir = null }) {
  const home = join(root, "home");
  // <root>/bin holds the shims and node itself (hard-linked), so no PATH entry
  // points under the person's real HOME — the node dir there also holds a
  // globally installed `aw`. A host whose binary lives in a dir of its own
  // (kimi ships `fd` next to it) gets that dir too; shared dirs like
  // ~/.local/bin are left out, since they also hold `herdr`.
  // <root>/hostbin holds only a link to the host's own binary: `aw mcp setup`
  // verifies each descriptor with it, and the host may call itself.
  const dirs = [join(root, "bin"), join(root, "hostbin"), ...(hostDir ? [hostDir] : [])];
  return {
    HOME: home,
    PATH: [...dirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    CODEX_HOME: join(home, ".codex"),
    KIMI_CODE_HOME: join(home, ".kimi-code"),
    // CRUSH_GLOBAL_CONFIG is left out on purpose: `aw` reads it as the FILE path
    // (src/application/mcp-host-paths.ts) and crush documents it as a location,
    // unverified which. With XDG_CONFIG_HOME inside the home both resolve
    // <home>/.config/crush/crush.json anyway. Candidate for F4.
    XDG_CONFIG_HOME: join(home, ".config"),
    CRUSH_GLOBAL_DATA: join(home, ".local", "share", "crush"),
    // Temp files of the host and of `aw` stay inside the root too.
    TMPDIR: join(root, "tmp"),
    // A TUI needs a terminal type and a locale; neither points anywhere.
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  };
}

const shellQuote = (s) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replaceAll("'", "'\\''")}'`;

/** `env -i K=V … <absolute host binary> <args>`: the pane inherits Herdr's env, not ours. */
export function paneCommand(env, bin, args) {
  return [
    "env",
    "-i",
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
    shellQuote(bin),
    ...args.map(shellQuote),
  ].join(" ");
}

/** A shim logs which binary ran and why, then runs the checkout's CLI. */
export function shimSource({ node, cliMain }) {
  return `#!/bin/sh
printf '%s %s\\n' "$0" "$*" >> "$HOME/.host-run/shim-calls.log"
exec ${shellQuote(node)} ${shellQuote(cliMain)} "$@"
`;
}

/**
 * The whole preparation of one host, as data. `root` may be a placeholder: the
 * plan is printed by `--dry-run` before any mkdtemp exists.
 */
/** What of the checkout the disposable root gets its own copy of (resolveBundleRoot needs skills/ next to dist/). */
export const CLI_PARTS = ["dist", "skills", "package.json"];

export function planIsolation({
  hostId,
  root,
  checkout,
  node,
  hostBin,
  realHome,
  profile,
  model,
  effort,
  deps = [],
  tokenPresent = false,
  siblingRoots = [],
  token = undefined,
}) {
  const host = HOSTS[hostId];
  if (host === undefined) throw new Error(`host '${hostId}' is not covered by the run`);
  // The token spec in force: given by the caller (a host with key choices), or
  // the host's own. A provider key (crush) also fixes the provider and model.
  const spec = token === undefined ? tokenSpec(hostId) : token;
  const providerModel =
    tokenPresent && spec?.provider ? { provider: spec.provider, model: spec.model } : null;
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  // The root runs its OWN copy of the checkout's CLI, so the read-sets `aw` hands
  // the host (the packaged bundle next to dist/) and every hook and MCP command
  // path lie inside the root, never under the real HOME the profiles deny.
  const cliDir = join(root, "cli");
  const cliMain = join(cliDir, "dist", "cli", "main.js");
  const rootNode = join(root, "bin", "node");
  const env = {
    ...cleanEnv({ root, hostDir: host.ownBinDir ? dirname(hostBin) : null }),
    // Host switches that keep a token out of the host's own children (claude).
    ...(host.childEnv ?? {}),
  };
  const aw = (...args) => ({ kind: "aw", args, cwd: workspace });
  // A host whose token travels in a variable gets it ONLY through a wrapper that
  // reads <root>/secrets/<host>.env: the visible pane command names the wrapper,
  // never the value. Everything else (setup steps, `mcp list`) runs without it.
  const secret = spec
    ? {
        host: hostId,
        var: spec.env,
        path: join(root, "secrets", `${hostId}.env`),
        wrapper: join(root, "bin", `launch-${basename(hostBin)}`),
      }
    : null;
  const launcher = secret ? secret.wrapper : hostBin;
  const runModel = model;
  const paneArgs = [...profile.paneArgs, ...host.modelArgs(runModel, effort)];
  // A host that signs in inside its pane (agy): no probe — without a login, a
  // probe would open the OAuth flow.
  const probeSkipped = host.signInInPane === true;
  return {
    host: hostId,
    root,
    home,
    workspace,
    env,
    cliMain,
    node: rootNode,
    shims: ["aw", "agent-workflow"].map((name) => ({
      path: join(root, "bin", name),
      source: shimSource({ node: rootNode, cliMain }),
    })),
    dsnFile: {
      path: join(home, ".workflow", "dev", "dsn.env"),
      source: `${PROBE_MCP.dsnVar}=${PROBE_DSN}\n`,
    },
    steps: [
      {
        kind: "copy-cli",
        checkout,
        cliDir,
        parts: CLI_PARTS,
        node,
        nodeLink: rootNode,
        hostBin,
        hostLink: join(root, "hostbin", basename(hostBin)),
        deps,
      },
      aw("self", "install", "--target", host.installTarget, "--force"),
      // The installed wrappers carry `allowed-tools: [Bash, Read, Write, Edit]`,
      // which claude grants without asking for the invoking turn. In this home
      // only, the grant is removed; the checkout's skills/ are never touched.
      { kind: "strip-grants", dir: home },
      aw("self", "mcp", "use-env", "--name", PROBE_MCP.name, "--dsn-var", PROBE_MCP.dsnVar),
      aw(
        "mcp",
        "setup",
        "--host",
        host.mcpHost,
        "--instance",
        PROBE_MCP.name,
        "--global",
        "--force",
      ),
      {
        kind: "profile",
        files: profile.files({
          home,
          workspace,
          node: rootNode,
          realHome,
          tokenPresent,
          root,
          siblingRoots,
          providerModel,
        }),
      },
      {
        kind: "credentials",
        // With a provider key the person's own crush data (their model
        // selection) is not copied: it would override the configured provider.
        copies: (providerModel ? [] : host.credentials).map((rel) => ({
          from: join(realHome, rel),
          to: join(home, rel),
        })),
        keychain: host.keychain,
      },
      { kind: "git", args: ["init", "-q", "-b", "main"], cwd: workspace },
      aw("workspace-init"),
      // `aw flow` measures the checkout against HEAD: a repo with no commit fails
      // quick.branch-precondition with «bad revision 'HEAD'» (observed s280).
      { kind: "git", args: ["add", "-A"], cwd: workspace },
      {
        kind: "git",
        args: [...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "host-run base"],
        cwd: workspace,
      },
      // No declared source may point outside the root (a real repo would get a
      // branch and worktree metadata from `aw flow`).
      { kind: "sources-guard", root, cwd: workspace },
      ...(secret
        ? [{ kind: "secret", var: secret.var, path: secret.path, wrapper: secret.wrapper, hostBin }]
        : []),
      ...(probeSkipped
        ? []
        : [
            {
              kind: "auth-probe",
              host: hostId,
              bin: launcher,
              args: probeArgs(host, { providerModel }),
              cwd: workspace,
              timeoutMs: PROBE_TIMEOUT_MS,
              ...(secret ? { secret: { host: hostId, var: secret.var, path: secret.path } } : {}),
            },
          ]),
    ],
    secret,
    providerModel,
    model: runModel ?? null,
    signInInPane: probeSkipped,
    pane: { cwd: workspace, command: paneCommand(env, launcher, paneArgs) },
  };
}

/**
 * The auth probe's argv: the host's own, plus a provider key's `provider/model`
 * (crush, before the prompt), so the probe runs what the pane will.
 */
function probeArgs(host, { providerModel }) {
  if (!providerModel) return host.authProbe;
  const [sub, ...rest] = host.authProbe;
  return [sub, "-m", `${providerModel.provider}/${providerModel.model}`, ...rest];
}

/**
 * A root without a marker this young may be another run's, between its mkdtemp
 * and its marker write: a concurrent sweep leaves it alone.
 */
export const ROOT_GRACE_MS = 60_000;

/**
 * Creates one disposable root (mkdtemp, 0700) and writes its pid marker at
 * once, so no other terminal's sweep takes it for a dead run's leftovers.
 * `fs` = {mkdtemp(prefix) → path, chmod(path, mode), writeFile(path, text, mode)}.
 */
export function makeRoot(fs, tmpRoot, runId, hostId, pid = process.pid) {
  const root = fs.mkdtemp(rootTemplate(tmpRoot, runId, hostId));
  fs.chmod(root, 0o700);
  fs.writeFile(join(root, MARKER_FILE), JSON.stringify({ pid, host: hostId }), 0o600);
  return root;
}

/**
 * Roots a previous run left: recognizable prefix, and a marker whose pid is
 * gone — or no marker at all on a root older than ROOT_GRACE_MS (`ageMs`
 * unknown counts as old).
 */
export function staleRoots(entries, readMarker, isAlive) {
  return entries
    .filter((e) => e.name.startsWith(ROOT_PREFIX))
    .filter((e) => {
      const marker = readMarker(e.path);
      if (marker !== null) return !isAlive(marker.pid);
      return !(typeof e.ageMs === "number" && e.ageMs < ROOT_GRACE_MS);
    })
    .map((e) => e.path);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Removes every registered root once, whatever ends the process. */
export class Cleanup {
  constructor(remove, onSignal = (sig) => process.kill(process.pid, sig), reap = null) {
    this.remove = remove;
    this.onSignal = onSignal;
    // Ends the roots' processes before their dirs go (reapRootProcesses).
    this.reap = reap;
    this.roots = new Set();
    this.hooks = [];
  }
  track(root) {
    this.roots.add(root);
  }
  addHook(fn) {
    this.hooks.push(fn);
  }
  run() {
    // Every command still running goes first, its whole group.
    stopLiveGroups("SIGKILL");
    for (const fn of this.hooks.splice(0)) {
      try {
        fn();
      } catch {
        // A failed hook must not keep a home with copied credentials alive.
      }
    }
    try {
      this.reap?.([...this.roots]);
    } catch {
      // Removing the roots matters more than a failed process listing.
    }
    for (const root of this.roots) this.remove(root);
    this.roots.clear();
  }
  install(proc = process) {
    proc.on("exit", () => this.run());
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      proc.once(sig, () => {
        // Forwarded at once: the detached groups do not get the terminal's Ctrl-C.
        // They get up to TERM_GRACE_MS to stop; then run() SIGKILLs what is left.
        stopLiveGroups("SIGTERM");
        awaitGroupsGone(TERM_GRACE_MS);
        this.run();
        this.onSignal(sig);
      });
    }
  }
}

/**
 * Executes a plan. `deps` = {fs: {mkdir, writeFile, readFile, exists, copy, chmod},
 * run(cmd, args, {env, cwd}) → {status, stdout, stderr}, cliMain}. Returns the
 * outcome of each step; stops at the first failure.
 */
export async function prepareHost(plan, deps) {
  const { fs } = deps;
  const log = [];
  for (const dir of [plan.home, plan.workspace, join(plan.root, "bin"), join(plan.root, "tmp")]) {
    fs.mkdir(dir);
  }
  fs.mkdir(join(plan.home, ".host-run"));
  fs.writeFile(
    join(plan.root, MARKER_FILE),
    JSON.stringify({ pid: process.pid, host: plan.host }),
    0o600,
  );
  for (const shim of plan.shims) fs.writeFile(shim.path, shim.source, 0o755);
  fs.mkdir(join(plan.home, ".workflow", "dev"));
  fs.writeFile(plan.dsnFile.path, plan.dsnFile.source, 0o600);
  for (const step of plan.steps) {
    // Every `aw` step runs the root's own copy with the root's node.
    const outcome = await STEP_RUNNERS[step.kind](step, {
      ...deps,
      env: plan.env,
      node: plan.node ?? deps.node,
      cliMain: plan.cliMain ?? deps.cliMain,
    });
    log.push({ step: describeStep(step), ...outcome });
    if (!outcome.ok) break;
  }
  return log;
}

/** One step alone, with the plan's deps (tests drive a step without a whole plan). */
export function prepareStep(step, deps) {
  return STEP_RUNNERS[step.kind](step, deps);
}

/**
 * How every host-side command runs (setup steps, probes, version reads): stdin
 * ignored, stdout/stderr captured, and in a NEW SESSION (`detached`: setsid), so
 * it has no controlling terminal — `/dev/tty` cannot be opened. agy 1.1.2+ reads
 * a pasted OAuth code from /dev/tty in print mode and echoes it; without a
 * controlling terminal it fails fast instead («Print mode: not logged in and no
 * controlling terminal; cannot complete interactive login», agy binary strings).
 */
export const CAPTURED_SPAWN = Object.freeze({
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});

/** Every auth probe's time limit: a probe that waits for a sign-in times out. */
export const PROBE_TIMEOUT_MS = 90_000;

/** Output kept per stream, in memory only (a probe's text only classifies). */
const MAX_OUTPUT = 4 * 1024 * 1024;
/** After a SIGTERM, how long a group gets before SIGKILL. */
const TERM_GRACE_MS = 1000;

/** Process groups of commands still running: each is a session leader (detached). */
const liveGroups = new Set();

/** Signals a whole process group (the child and every descendant still in it). */
export function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone already.
  }
}

/** Waits (blocking: this is the exit path) until every running group is gone, up to `ms`. */
function awaitGroupsGone(ms) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < ms; waited += 50) {
    const left = [...liveGroups].filter((pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (left.length === 0) return;
    Atomics.wait(cell, 0, 0, 50);
  }
}

/** Signals every running command's group: a signal or cleanup ends them all. */
export function stopLiveGroups(signal = "SIGKILL") {
  for (const pid of liveGroups) killGroup(pid, signal);
}

/**
 * `run(cmd, args, {env, cwd, timeout})` → Promise<{status, signal, stdout,
 * stderr, error?}>, over `spawn` (child_process.spawn) with CAPTURED_SPAWN. It
 * never blocks: a Ctrl-C reaches the run at once and `Cleanup` ends the group.
 * On a timeout the whole group gets SIGTERM, then SIGKILL; when the child
 * exits, whatever of its group is left is killed too, so no grandchild outlives
 * its step.
 */
export function capturedRun(spawn, defaultTimeout = 180_000) {
  return (cmd, args, { env, cwd, timeout } = {}) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { ...CAPTURED_SPAWN, env, cwd });
      } catch (error) {
        resolve({ status: null, signal: null, stdout: "", stderr: "", error });
        return;
      }
      const pid = child.pid;
      if (pid) liveGroups.add(pid);
      const out = { stdout: "", stderr: "" };
      for (const name of ["stdout", "stderr"]) {
        child[name]?.setEncoding("utf8");
        child[name]?.on("data", (d) => {
          if (out[name].length < MAX_OUTPUT) out[name] += d;
        });
      }
      let timedOut = false;
      let error = null;
      let exit = { status: null, signal: null };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(pid, "SIGTERM");
        setTimeout(() => killGroup(pid, "SIGKILL"), TERM_GRACE_MS).unref();
      }, timeout ?? defaultTimeout);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        killGroup(pid, "SIGKILL");
        liveGroups.delete(pid);
        resolve({
          ...exit,
          ...out,
          ...(timedOut ? { error: { code: "ETIMEDOUT" } } : error ? { error } : {}),
        });
      };
      child.on("error", (e) => {
        error = e;
        finish();
      });
      child.on("exit", (status, signal) => {
        exit = { status, signal };
        // The rest of its group (a grandchild holding the pipes) goes now.
        killGroup(pid, "SIGKILL");
        // A descendant in another session may still hold the pipes: stop waiting.
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, TERM_GRACE_MS).unref();
      });
      child.on("close", finish);
    });
}

/**
 * The same isolation for the run's short reads during the live loop (a host's
 * `--version`, `aw sources`, `aw host-memory`): synchronous over `spawnSync`,
 * no stdin, captured, no controlling terminal, and its group killed after.
 */
export function capturedRunSync(spawn = spawnSync, defaultTimeout = 30_000) {
  return (cmd, args, { env, cwd, timeout } = {}) => {
    const r = spawn(cmd, args, {
      ...CAPTURED_SPAWN,
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT,
      env,
      cwd,
      timeout: timeout ?? defaultTimeout,
    });
    killGroup(r.pid, "SIGKILL");
    return r;
  };
}

/**
 * The processes that belong to the run's roots: a command line naming a path
 * under a root, or a working directory under one. `ps` gives
 * `pid pgid sess tty command` (never the environment); `cwds` maps pid → cwd.
 * A process with a controlling terminal (the person's own shell that `cd`-ed
 * into a root to look) is never killed: it is returned in `kept`.
 * → {kill: [{pid, pgid}], kept: [{pid, name}], ownPgid}.
 */
export function rootProcesses(psText, cwds, roots, self = [process.pid, process.ppid]) {
  const under = (text) =>
    roots.some((r) => text === r || text.includes(`${r}/`) || text.endsWith(r));
  const procs = String(psText ?? "")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, pgid, sess, tty, command]) => ({
      pid: Number(pid),
      pgid: Number(pgid),
      sess: Number(sess),
      tty,
      command,
    }));
  const ownPgid = procs.find((p) => p.pid === self[0])?.pgid ?? null;
  const matched = procs
    .filter((p) => !self.includes(p.pid))
    .filter((p) => under(p.command) || (cwds[p.pid] !== undefined && under(cwds[p.pid])));
  const hasTty = (p) => p.tty !== "??" && p.tty !== "-" && p.tty !== "";
  return {
    kill: matched.filter((p) => !hasTty(p)).map(({ pid, pgid }) => ({ pid, pgid })),
    kept: matched
      .filter(hasTty)
      .map((p) => ({ pid: p.pid, pgid: p.pgid, name: basename(p.command.split(/\s+/)[0]) })),
    ownPgid,
  };
}

/**
 * Ends every process of the run's roots — a detached server a host started
 * (crush can), a daemonized helper — and each one's process group, with
 * SIGTERM, then SIGKILL. Never the run's own group, never a group of a process
 * with a terminal, never pgid 0 or 1. Synchronous: it runs from Cleanup, also
 * on exit, after the Herdr close hooks. `deps` = {ps() → text, cwds() → {pid:
 * cwd}, kill(pid, signal), alive(pid), pause(ms)}. → {killed: [pid], kept:
 * [{pid, name}]} — `kept` is for the person: a terminal still inside a root.
 */
export function reapRootProcesses(roots, deps = nodeProcs()) {
  if (roots.length === 0) return { killed: [], kept: [] };
  const { kill, kept, ownPgid } = rootProcesses(deps.ps(), deps.cwds(), roots);
  const spared = new Set([0, 1, ownPgid, ...kept.map((k) => k.pgid)]);
  const groups = [...new Set(kill.map((p) => p.pgid))].filter((g) => !spared.has(g));
  const signal = (sig) => {
    for (const g of groups) deps.kill(-g, sig);
    for (const { pid } of kill) deps.kill(pid, sig);
  };
  signal("SIGTERM");
  if (kill.length > 0) deps.pause(TERM_GRACE_MS / 2);
  for (const g of groups) deps.kill(-g, "SIGKILL");
  for (const { pid } of kill.filter((p) => deps.alive(p.pid))) deps.kill(pid, "SIGKILL");
  return { killed: kill.map((p) => p.pid), kept: kept.map(({ pid, name }) => ({ pid, name })) };
}

/** The line that tells the person which terminals still sit inside a root (none killed). */
export function keptMessage(kept) {
  if (kept.length === 0) return null;
  const list = kept.map((k) => `${k.pid} ${k.name}`).join(", ");
  return `left running (they have a terminal, inside a disposable root): ${list} — leave that directory; the root is being removed`;
}

/** The real process table: `ps -axo pid,pgid,sess,command` and lsof's cwd list. */
export function nodeProcs() {
  const read = (cmd, args) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.status === 0 ? r.stdout : "";
  };
  return {
    ps: () => read("/bin/ps", ["-axo", "pid=,pgid=,sess=,tty=,command="]),
    cwds: () => {
      // lsof -Fpn: a `p<pid>` line, then the `n<path>` of its cwd.
      const out = {};
      let pid = null;
      for (const line of read("lsof", ["-nP", "-d", "cwd", "-Fpn"]).split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid !== null) out[pid] = line.slice(1);
      }
      return out;
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // Gone already.
      }
    },
    alive: (pid) => pidAlive(pid),
    pause: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

/**
 * agy's structured failure line. agy 1.2.x changelog (binary strings): a
 * headless turn that ends on an agent or model API failure «prints a structured
 * `AGY_ERROR: {...}` JSON line on stderr with canonical status, HTTP or gRPC
 * error code, retryability, and error ID … and exits with code `3`». Only the
 * enum-shaped status and the numeric codes are reported — never its free text
 * (`short_error` and messages can quote a request).
 */
export function agyErrorReason(text) {
  const line = /^AGY_ERROR:\s*(\{.*\})\s*$/m.exec(text)?.[1];
  if (!line) return null;
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return "model API error (unreadable AGY_ERROR line)";
  }
  const facts = [...new Set(errorFacts(data))].slice(0, 4);
  return facts.length > 0 ? `model API error: ${facts.join(", ")}` : "model API error";
}

/** The only AGY_ERROR keys whose values may be reported. */
const ERROR_KEYS = new Set(["status", "code", "reason", "http_status"]);

/**
 * The reportable facts of an AGY_ERROR object: only leaves under a key named
 * status, code, reason or http_status — an enum-shaped string or a number —
 * and retryability. Any other leaf, all-caps or not, is never read out.
 */
function errorFacts(data) {
  const leaves = [];
  const walk = (value, key) => {
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    } else leaves.push([key, value]);
  };
  walk(data, "");
  return leaves.map(errorFact).filter(Boolean);
}

/** One leaf's fact, or null when it may not be reported. */
function errorFact([key, value]) {
  if (typeof value === "boolean" && /^retry(able)?$/i.test(key))
    return value ? "retryable" : "not retryable";
  if (!ERROR_KEYS.has(key)) return null;
  if (typeof value === "string" && /^[A-Z][A-Z_]{2,40}$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1000)
    return `${key} ${value}`;
  return null;
}

/** A probe waiting for (or refusing without) an interactive sign-in. */
const NEEDS_SIGN_IN =
  /no controlling terminal|interactive login|authorization code|visit the url|waiting for authentication|opening browser|device code|not logged in|not signed in|please (sign|log) in|login required|authentication required|no stored credentials/i;
const REJECTED =
  /\b401\b|\b403\b|unauthori[sz]ed|invalid (api )?key|invalid_grant|expired (token|credentials)|token (has )?expired|permission denied/i;
const NO_MODEL = /no (large )?model|no providers configured|model .* not found|not configured/i;

/**
 * The ONE line a failed probe is reported with, from a fixed vocabulary. The
 * captured output is matched here, in memory, and never echoed or kept.
 */
export function probeReason(r) {
  if (r.error?.code === "ETIMEDOUT" || r.signal) return "timeout";
  if (r.error?.code === "ENOENT") return "probe binary not found";
  if (r.error) return "probe could not start";
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const apiError = agyErrorReason(text);
  if (apiError) return apiError;
  if (NEEDS_SIGN_IN.test(text)) return "probe needs interactive sign-in";
  if (REJECTED.test(text)) return "credentials rejected";
  if (NO_MODEL.test(text)) return "no provider or model configured";
  return `probe exited ${r.status}`;
}

const exitOutcome = (r) => ({
  ok: r.status === 0,
  detail: r.status === 0 ? "ok" : `exit ${r.status}`,
});

/** One runner per step kind; every command runs with the plan's clean env. */
const STEP_RUNNERS = {
  "copy-cli": (step, { fs }) => {
    const modules = join(step.checkout, "node_modules");
    if (!fs.exists(modules))
      return { ok: false, detail: `the checkout has no node_modules (${modules}): run npm ci` };
    if (!step.hostBin.startsWith("/")) {
      return { ok: false, detail: `the host binary is not an absolute path (${step.hostBin})` };
    }
    if (!Array.isArray(step.deps) || step.deps.length === 0) {
      return { ok: false, detail: "the production dependency closure is unknown (npm ls failed?)" };
    }
    for (const part of step.parts) fs.copy(join(step.checkout, part), join(step.cliDir, part));
    // The production dependencies are COPIED, never linked: a codex sandbox that
    // denies the real HOME would otherwise deny node its own requires. Each
    // package is copied without its nested node_modules, which are entries of
    // their own in the closure.
    const modulesReal = fs.realpath(modules);
    for (const rel of step.deps) {
      fs.copyPackage(join(modulesReal, rel.slice("node_modules/".length)), join(step.cliDir, rel));
    }
    fs.linkOrCopy(step.node, step.nodeLink);
    fs.mkdir(dirname(step.hostLink));
    fs.symlink(step.hostBin, step.hostLink);
    step.treeHash = fs.treeHash(step.cliDir, step.parts);
    step.checkoutHash = fs.treeHash(step.checkout, step.parts);
    step.depsHash = fs.packagesHash(step.cliDir, step.deps);
    step.checkoutDepsHash = fs.packagesHash(join(modulesReal, ".."), step.deps);
    const same = step.treeHash === step.checkoutHash && step.depsHash === step.checkoutDepsHash;
    return {
      ok: same,
      detail: same
        ? `copy is the checkout (sha256 ${step.treeHash.slice(0, 12)}, ${step.deps.length} dependencies ${step.depsHash.slice(0, 12)})`
        : "copy differs from the checkout",
    };
  },
  aw: async (step, { run, env, node, cliMain }) =>
    exitOutcome(await run(node, [cliMain, ...step.args], { env, cwd: step.cwd })),
  git: async (step, { run, env }) =>
    exitOutcome(await run("git", step.args, { env, cwd: step.cwd })),
  "strip-grants": (step, { fs }) => {
    const changed = fs
      .listFiles(step.dir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => {
        const text = fs.readFile(f);
        const stripped = stripToolGrants(text);
        if (stripped === text) return false;
        fs.writeFile(f, stripped, 0o600);
        return true;
      });
    const left = fs
      .listFiles(step.dir)
      .filter((f) => f.endsWith(".md") && toolGrants(fs.readFile(f)).length > 0);
    return {
      ok: left.length === 0,
      detail:
        left.length === 0
          ? `${changed.length} wrapper(s) stripped`
          : `grants left in ${left.join(", ")}`,
    };
  },
  "sources-guard": async (step, { run, env, node, cliMain }) => {
    const r = await run(node, [cliMain, "sources", "--no-git"], { env, cwd: step.cwd });
    const outside = sourcesOutside(r.stdout, step.root, step.cwd);
    if (r.status !== 0 || outside === null) return { ok: false, detail: "cannot read the sources" };
    return {
      ok: outside.length === 0,
      detail:
        outside.length === 0
          ? "no source outside the root"
          : `outside the root: ${outside.join(", ")}`,
    };
  },
  profile: (step, { fs, env }) => {
    for (const file of step.files) applyProfileFile(fs, file, env.HOME);
    return { ok: true, detail: `${step.files.length} file(s) merged` };
  },
  credentials: (step, { fs }) => {
    const copied = step.copies.filter((c) => fs.exists(c.from));
    // Names only (from the host's own list), for the auth check's reason line.
    step.missing = step.copies.filter((c) => !copied.includes(c)).map((c) => basename(c.to));
    for (const c of copied) fs.copy(c.from, c.to);
    // Size+mtime of each copy, never its content: a host that rotates an OAuth
    // token during the run changes it, and `rotatedCredentials` keeps that copy.
    step.stamps = Object.fromEntries(copied.map((c) => [c.to, fs.stamp(c.to)]));
    const missing = step.missing.length > 0 ? `; missing: ${step.missing.join(", ")}` : "";
    return { ok: true, detail: `${copied.length}/${step.copies.length} copied${missing}` };
  },
  // The probe runs as the pane will: same clean env, same binary.
  // The token file (0600, in a 0700 dir inside the root) and its wrapper (0700).
  // The value comes from deps.secrets, never from the plan: the plan is what
  // --dry-run prints and the digest seals.
  // Only the wrapper (0700) and the secrets dir (0700) are written here. The
  // token file itself is written just before each use — the auth probe, the
  // pane — and the wrapper deletes it right after reading it.
  secret: (step, { fs }) => {
    fs.mkdir(dirname(step.path));
    fs.writeFile(step.wrapper, wrapperSource(step), 0o700);
    return { ok: true, detail: "wrapper written; the token file is written just before each use" };
  },
  // Its output is captured (never inherited, never printed): only the fixed
  // reason `probeReason` derives from it leaves this function.
  // A failed probe's output, redacted, may be kept for the person in a 0600 file
  // of the 0700 transcripts dir (`keepProbeOutput(host, text)` → its path).
  "auth-probe": async (step, { run, env, fs, secrets = {}, keepProbeOutput }) => {
    const handoff = step.secret ? handTokenOver(fs, step.secret, secrets[step.secret.host]) : null;
    const r = await run(step.bin, step.args, { env, cwd: step.cwd, timeout: step.timeoutMs });
    const leftover = handoff ? handoff.settle() : null;
    const reason = r.status === 0 && !r.error ? null : probeReason(r);
    const kept =
      reason && keepProbeOutput
        ? keepProbeOutput(
            step.host ?? basename(step.bin),
            redactSecrets(`${r.stdout ?? ""}\n${r.stderr ?? ""}`, Object.values(secrets)),
          )
        : null;
    return {
      ok: reason === null,
      ...(reason ? { reason } : {}),
      ...(kept ? { kept } : {}),
      detail: `${reason === null ? "authenticated" : `NOT authenticated: ${reason}`}${leftover ? `; ${leftover}` : ""}${kept ? `; probe output (redacted): ${kept}` : ""}`,
    };
  },
};

export function applyProfileFile(fs, file, home) {
  const path = join(home, file.path);
  const current = fs.exists(path) ? fs.readFile(path) : null;
  if (file.kind === "json") {
    const base = current === null || current.trim() === "" ? {} : JSON.parse(current);
    fs.writeFile(path, `${JSON.stringify(mergeJson(base, file.value), null, 2)}\n`, 0o600);
  } else if (file.kind === "toml-top" || file.kind === "toml-table") {
    fs.writeFile(path, mergeToml(current ?? "", file), 0o600);
  } else {
    fs.writeFile(path, file.value, file.mode ?? 0o600);
  }
}

/**
 * The `allowed-tools` key of a frontmatter body as line indexes [start, end):
 * the key line plus every indented continuation line — a flow list over several
 * lines (`[`…`]`) or a YAML block list (`  - Bash`). null when absent.
 */
function grantLines(lines) {
  const start = lines.findIndex((l) => /^allowed-tools\s*:/.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && /^\s+\S|^\s*[\]-]/.test(lines[end])) end++;
  return { start, end };
}

/**
 * Frontmatter tool grants of a wrapper (`allowed-tools:`), as their entries, in
 * any of the flow, inline or block-list forms. Pure; [] means no grant.
 */
export function toolGrants(text) {
  const fm = frontmatter(text);
  if (fm === null) return [];
  const lines = fm.body.split("\n");
  const range = grantLines(lines);
  if (range === null) return [];
  const raw = [
    lines[range.start].replace(/^allowed-tools\s*:/, ""),
    ...lines.slice(range.start + 1, range.end),
  ];
  return raw
    .join("\n")
    .replace(/[[\]]/g, "")
    .split(/[,\n]/)
    .map((e) =>
      e
        .trim()
        .replace(/^-\s*/, "")
        .replace(/^["']|["']$/g, ""),
    )
    .filter(Boolean);
}

function frontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  return end === -1 ? null : { body: text.slice(4, end), end };
}

/** The same text with its `allowed-tools` key and all of its items removed. */
export function stripToolGrants(text) {
  const fm = frontmatter(text);
  if (fm === null) return text;
  const lines = fm.body.split("\n");
  const range = grantLines(lines);
  if (range === null) return text;
  const body = [...lines.slice(0, range.start), ...lines.slice(range.end)].join("\n");
  return `---\n${body}${text.slice(fm.end)}`;
}

/**
 * The declared sources of `aw sources --no-git` output that resolve outside
 * `root` (relative paths against the workspace). null when unreadable.
 */
export function sourcesOutside(stdout, root, workspace) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const sources = data?.data?.sources ?? data?.sources;
  if (!Array.isArray(sources)) return null;
  return sources.map((s) => resolve(workspace, String(s.path))).filter((p) => !isInside(root, p));
}

/**
 * A path by its real location: `..` normalized, symlinks followed. For a path
 * that does not exist (yet), its nearest existing parent is resolved and the
 * rest appended, so a link higher up still counts.
 */
export function resolveReal(p, realpath = realpathSync) {
  const abs = resolve(p);
  const tail = [];
  let current = abs;
  for (;;) {
    try {
      return join(realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Whether `p` really lies inside `root`, separator-aware (`/root-x` is not in `/root`). */
export function isInside(root, p, realpath = realpathSync) {
  const r = resolveReal(root, realpath);
  const q = resolveReal(p, realpath);
  return q === r || q.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

export function describeStep(step) {
  if (step.kind === "copy-cli") {
    return `copy the checkout's ${step.parts.join(", ")} and its ${step.deps?.length ?? 0} production dependencies into ${step.cliDir} (copied, no link to the checkout; node ${step.node} hard-linked as ${step.nodeLink}; host binary ${step.hostBin} linked as ${step.hostLink}); its tree hash must equal the checkout's`;
  }
  if (step.kind === "strip-grants")
    return "strip the installed wrappers' allowed-tools grants (disposable home only)";
  if (step.kind === "sources-guard") return "check that no declared source lies outside the root";
  if (step.kind === "aw") return `aw ${step.args.join(" ")}`;
  if (step.kind === "git") return `git ${step.args.join(" ")}`;
  if (step.kind === "profile")
    return `merge profile into ${[...new Set(step.files.map((f) => f.path))].join(", ")}`;
  if (step.kind === "credentials") {
    const keychain = step.keychain ? " (+ system keychain, not copied)" : "";
    const rotation =
      step.copies.length > 0
        ? " — an OAuth token may rotate during the run: a changed copy is kept in the transcripts dir (0700), your real file is never overwritten"
        : "";
    return `copy credentials: ${step.copies.map((c) => c.to).join(", ") || "(none)"}${keychain}${rotation}`;
  }
  if (step.kind === "auth-probe") return `auth probe: ${step.bin} ${step.args.join(" ")}`;
  if (step.kind === "secret") {
    return `write ${step.var} (if given) to ${step.path} (0600) and the wrapper ${step.wrapper} (0700) that execs ${step.hostBin} with it`;
  }
  return step.kind;
}

/**
 * Copied credentials that changed during the run (a rotated OAuth token), as
 * {to, rel}. They die with the home unless kept: the caller copies them to the
 * transcripts dir and tells the person. The real file is never touched.
 */
export function rotatedCredentials(plan, stamp) {
  const step = plan.steps.find((s) => s.kind === "credentials");
  return Object.entries(step?.stamps ?? {})
    .filter(([to, before]) => stamp(to) !== before)
    .map(([to]) => ({ to, rel: to.slice(plan.home.length + 1) }));
}

/**
 * sha256 over the sorted relative paths and contents of `parts` under `dir`.
 * `files` = [{rel, content}], as the fs port lists them. Pure.
 */
export function treeHashOf(files) {
  const hash = createHash("sha256");
  for (const { rel, content } of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    hash.update(rel).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

/** Every file under a dir, recursively. */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
}

/** Size and mtime of a file or of every file under a dir — never its content. */
function stamp(path) {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return `${st.size}:${st.mtimeMs}`;
    return readdirSync(path)
      .sort()
      .map((name) => `${name}=${stamp(join(path, name))}`)
      .join(",");
  } catch {
    return "missing";
  }
}

/** The real fs port `prepareHost` runs with (tests use it over mkdtemp roots). */
export function nodeFs() {
  const ensureParent = (p) => mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  return {
    mkdir: (p) => mkdirSync(p, { recursive: true, mode: 0o700 }),
    writeFile: (p, text, mode = 0o600) => {
      ensureParent(p);
      writeFileSync(p, text, { mode });
      chmodSync(p, mode);
    },
    readFile: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    listFiles,
    copy: (from, to) => {
      ensureParent(to);
      cpSync(from, to, { recursive: true });
    },
    symlink: (target, path) => {
      ensureParent(path);
      symlinkSync(target, path);
    },
    realpath: (p) => realpathSync(p),
    remove: (p) => rmSync(p, { force: true }),
    // A hard link keeps node's own path inside the root (process.execPath, which
    // `aw mcp setup` writes into the descriptor); a copy when volumes differ.
    linkOrCopy: (from, to) => {
      ensureParent(to);
      try {
        linkSync(from, to);
      } catch {
        cpSync(from, to);
        chmodSync(to, 0o755);
      }
    },
    // A package's own files, without its nested node_modules (dereferenced, so the
    // copy holds no link back to the checkout).
    copyPackage: (from, to) => {
      ensureParent(to);
      cpSync(from, to, {
        recursive: true,
        dereference: true,
        filter: (src) => !src.slice(from.length).split("/").includes("node_modules"),
      });
    },
    packagesHash: (base, rels) =>
      treeHashOf(
        rels.flatMap((rel) =>
          listFiles(join(base, rel))
            .filter((f) => !f.slice(join(base, rel).length).split("/").includes("node_modules"))
            .map((f) => ({ rel: f.slice(base.length + 1), content: readFileSync(f) })),
        ),
      ),
    treeHash: (dir, parts) =>
      treeHashOf(
        parts.flatMap((part) => {
          const base = join(dir, part);
          const files = statSync(base).isDirectory() ? listFiles(base) : [base];
          return files.map((f) => ({ rel: f.slice(dir.length + 1), content: readFileSync(f) }));
        }),
      ),
    stamp,
  };
}

/** kimi's `[workspace] additional_dir` entries in a `.kimi-code/local.toml` text. */
export function kimiAdditionalDirs(text) {
  const m = /additional_dir\s*=\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*')/.exec(String(text ?? ""));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]);
}

/**
 * Why a host must be held before anything more is typed into it: a declared
 * source, or a kimi additional_dir, that resolves outside the disposable root.
 * `sourcesStdout` is `aw sources --no-git`; `localToml` the workspace's
 * `.kimi-code/local.toml` or null. Pure; [] means nothing points outside.
 */
export function workspaceGuard({ root, workspace, sourcesStdout, localToml, home = null }) {
  const reasons = [];
  const outside = sourcesOutside(sourcesStdout, root, workspace);
  if (outside === null) reasons.push("the workspace's sources cannot be read");
  else if (outside.length > 0)
    reasons.push(`a declared source points outside the root: ${outside.join(", ")}`);
  // kimi expands `~` to its HOME (the disposable home); relative entries resolve
  // against the workspace. Without a known home a `~` entry counts as outside.
  const dirs = kimiAdditionalDirs(localToml)
    .map((d) =>
      d === "~" || d.startsWith("~/") ? (home ? join(home, d.slice(1)) : d) : resolve(workspace, d),
    )
    .filter((d) => !d.startsWith("/") || !isInside(root, d));
  if (dirs.length > 0)
    reasons.push(`.kimi-code/local.toml adds a directory outside the root: ${dirs.join(", ")}`);
  return reasons;
}

/**
 * The production dependency closure of a checkout, as `node_modules/…` paths,
 * from its package-lock.json (lockfile v2/v3 `packages`): every entry that is
 * neither `dev` nor `devOptional`, and is installed (`exists(rel)`). The lock is
 * used rather than `npm ls`, which reports extraneous packages as part of the
 * tree and writes a compile cache into $TMPDIR — the dry-run must write nothing.
 */
export function productionDeps(lockText, exists = () => true) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return [];
  }
  return Object.entries(lock?.packages ?? {})
    .filter(([rel, meta]) => rel.startsWith("node_modules/") && !meta.dev && !meta.devOptional)
    .map(([rel]) => rel)
    .filter((rel) => exists(rel))
    .sort();
}

/**
 * The wrapper a token host is launched through. It reads the token from its file
 * with the shell's own `read` (no subprocess, no echo, no trace), exports it only
 * for the exec'd host, and passes every argument through.
 */
export function wrapperSource({ var: name, path, hostBin }) {
  const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
# host-run: launches the host with its token from the disposable root. It
# writes nothing itself: no output, no log, no trace.
set +x
if [ -r ${q(path)} ]; then
  IFS= read -r HOST_RUN_SECRET < ${q(path)} || true
  rm -f ${q(path)}
  ${name}="$HOST_RUN_SECRET"
  export ${name}
  unset HOST_RUN_SECRET
fi
exec ${q(hostBin)} "$@"
`;
}

/** An env with every host token variable removed (for anything but a wrapper). */
export function withoutTokens(env, vars) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !vars.includes(k)));
}

/**
 * Writes a host's token file (0600) just before its wrapper runs, and returns a
 * `settle()` that checks the wrapper deleted it: if it did not (the wrapper died
 * before its `rm -f`), the file is removed here and a notice is returned.
 */
export function handTokenOver(fs, secret, value) {
  if (!value) return null;
  fs.writeFile(secret.path, `${value}\n`, 0o600);
  return {
    settle: () => {
      if (!fs.exists(secret.path)) return null;
      fs.remove(secret.path);
      return "the wrapper left the token file behind: removed by the run";
    },
  };
}

/** How long a pane may take to start its wrapper before the token file is removed. */
export const PANE_PICKUP_MS = 120_000;

/**
 * Waits, without blocking the event loop (signals stay handled), for a pane's
 * wrapper to delete its token file. Polls every `stepMs` up to `boundMs`; on
 * expiry removes the file and returns the notice for the person, else null.
 * `sleep(ms)` → Promise.
 */
export async function awaitTokenPickup(fs, path, opts = {}) {
  const { boundMs = PANE_PICKUP_MS, stepMs = 200, sleep } = opts;
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let waited = 0; waited < boundMs; waited += stepMs) {
    if (!fs.exists(path)) return null;
    await wait(stepMs);
  }
  if (!fs.exists(path)) return null;
  fs.remove(path);
  return `the pane had not started its wrapper after ${Math.round(boundMs / 1000)} s; token file removed, the host may start unauthenticated`;
}

/**
 * Opens a host's pane; a token host gets its token file just before. The
 * wrapper deletes it as it starts and the run waits for that; the file is gone
 * whatever happens, `openPane` throwing included. Returns {pane, notice}.
 */
export async function openPaneWithToken(fs, herdr, plan, value, pickup = {}) {
  const handoff = plan.secret ? handTokenOver(fs, plan.secret, value) : null;
  let waited = false;
  try {
    const pane = herdr.openPane(plan.workspace, `host-run-${plan.host}`, plan.pane.command);
    const notice = handoff ? await awaitTokenPickup(fs, plan.secret.path, pickup) : null;
    waited = true;
    return { pane, notice };
  } finally {
    if (handoff && !waited) handoff.settle();
  }
}
