// Isolation per host: a disposable root (mkdtemp, 0700) holding the host's home,
// its workspace and the `aw`/`agent-workflow` shims, and a clean environment
// that points only there.
//
// `planIsolation` is pure — it is what `--dry-run` prints, with the mkdtemp
// suffix left as a placeholder. `prepareHost` executes a plan through injected
// fs/spawn, and `Cleanup` removes every root on exit and on SIGINT/SIGTERM/SIGHUP.
// SIGKILL cannot be caught: `staleRoots` finds what a dead run left behind.

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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { HOSTS } from "./hosts.mjs";
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
}) {
  const host = HOSTS[hostId];
  if (host === undefined) throw new Error(`host '${hostId}' is not covered by the run`);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  // The root runs its OWN copy of the checkout's CLI, so the read-sets `aw` hands
  // the host (the packaged bundle next to dist/) and every hook and MCP command
  // path lie inside the root, never under the real HOME the profiles deny.
  const cliDir = join(root, "cli");
  const cliMain = join(cliDir, "dist", "cli", "main.js");
  const rootNode = join(root, "bin", "node");
  const env = cleanEnv({ root, hostDir: host.ownBinDir ? dirname(hostBin) : null });
  const aw = (...args) => ({ kind: "aw", args, cwd: workspace });
  const paneArgs = [...profile.paneArgs, ...host.modelArgs(model, effort)];
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
      { kind: "profile", files: profile.files({ home, workspace, node: rootNode, realHome }) },
      {
        kind: "credentials",
        copies: host.credentials.map((rel) => ({ from: join(realHome, rel), to: join(home, rel) })),
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
      { kind: "auth-probe", bin: hostBin, args: host.authProbe, cwd: workspace },
    ],
    pane: { cwd: workspace, command: paneCommand(env, hostBin, paneArgs) },
  };
}

/** Roots a previous run left: recognizable prefix, and a marker whose pid is gone. */
export function staleRoots(entries, readMarker, isAlive) {
  return entries
    .filter((e) => e.name.startsWith(ROOT_PREFIX))
    .filter((e) => {
      const marker = readMarker(e.path);
      return marker === null || !isAlive(marker.pid);
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
  constructor(remove, onSignal = (sig) => process.kill(process.pid, sig)) {
    this.remove = remove;
    this.onSignal = onSignal;
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
    for (const fn of this.hooks.splice(0)) {
      try {
        fn();
      } catch {
        // A failed hook must not keep a home with copied credentials alive.
      }
    }
    for (const root of this.roots) this.remove(root);
    this.roots.clear();
  }
  install(proc = process) {
    proc.on("exit", () => this.run());
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      proc.once(sig, () => {
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
export function prepareHost(plan, deps) {
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
    const outcome = STEP_RUNNERS[step.kind](step, {
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
  aw: (step, { run, env, node, cliMain }) =>
    exitOutcome(run(node, [cliMain, ...step.args], { env, cwd: step.cwd })),
  git: (step, { run, env }) => exitOutcome(run("git", step.args, { env, cwd: step.cwd })),
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
  "sources-guard": (step, { run, env, node, cliMain }) => {
    const r = run(node, [cliMain, "sources", "--no-git"], { env, cwd: step.cwd });
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
    for (const c of copied) fs.copy(c.from, c.to);
    // Size+mtime of each copy, never its content: a host that rotates an OAuth
    // token during the run changes it, and `rotatedCredentials` keeps that copy.
    step.stamps = Object.fromEntries(copied.map((c) => [c.to, fs.stamp(c.to)]));
    return { ok: true, detail: `${copied.length}/${step.copies.length} copied` };
  },
  // The probe runs as the pane will: same clean env, same binary.
  "auth-probe": (step, { run, env }) => {
    const r = run(step.bin, step.args, { env, cwd: step.cwd });
    return {
      ok: r.status === 0,
      detail: r.status === 0 ? "authenticated" : "does not authenticate from the disposable home",
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
