// The run starts only with a person's typed approval in a real terminal.
//
// Gates, all before anything is prepared or opened: stdin AND stdout are a TTY;
// no agent host marker is in the environment and no agent host (or Herdr) is
// among the process's ancestors — an agent must never launch the run for the
// person; and the person types back the digest of the exact scenario, profiles
// and pane commands shown.

import { createHash } from "node:crypto";
import { HOSTS, tokenSpecs } from "./hosts.mjs";

/**
 * Markers of a process running INSIDE an agent host. The catalog's `envMarkers`
 * (src/domain/harnesses.ts) plus what a host's sandbox or Herdr pane exports.
 * Config pointers a person may export in a plain shell (CODEX_HOME,
 * OPENCODE_CONFIG, CRUSH_CONFIG) are not markers. Kimi exports none to its
 * subprocesses; its shell tool has no TTY, so the TTY gate is what stops it.
 */
export const EXTRA_AGENT_MARKERS = [
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_CI",
  "CRUSH_SESSION_ID",
  "HERDR_ENV",
  "HERDR_PANE_ID",
];

/**
 * Not markers of an agent: config pointers a person may export in a plain shell,
 * and Warp's terminal marker — Warp is a terminal the person may run it from.
 */
const NOT_MARKERS = new Set([
  "CODEX_HOME",
  "OPENCODE_CONFIG",
  "CRUSH_CONFIG",
  "WARP_IS_LOCAL_SHELL_SESSION",
]);

export function agentMarkers(harnesses) {
  const fromCatalog = harnesses.flatMap((h) => h.envMarkers).filter((m) => !NOT_MARKERS.has(m));
  return [...new Set([...fromCatalog, ...EXTRA_AGENT_MARKERS])];
}

/** Executables of agent hosts, and Herdr, as they appear in a process's argv. */
export const AGENT_BINARIES = new Set([
  "claude",
  "codex",
  "opencode",
  "kimi",
  "agy",
  "crush",
  "oz",
  "herdr",
]);

/**
 * The ancestors of `pid` up to init, each as {pid, args}. `ps(pid)` →
 * {ppid, args} | null, injected; the default reads `ps -o ppid=,args= -p <pid>`.
 */
export function processChain(pid, ps, limit = 64) {
  const chain = [];
  let current = pid;
  while (current > 1 && chain.length < limit) {
    const info = ps(current);
    if (info === null) break;
    chain.push({ pid: current, args: info.args });
    current = info.ppid;
  }
  return chain;
}

/**
 * The agent host among the ancestors, or null. An argv word counts when its
 * basename is a host binary: `node /…/bin/codex` is codex too.
 */
export function agentAncestor(chain) {
  for (const { pid, args } of chain) {
    const word = String(args)
      .split(/\s+/)
      .map((w) => w.split("/").pop())
      .find((name) => AGENT_BINARIES.has(name));
    if (word) return `${word} (pid ${pid})`;
  }
  return null;
}

/** Why the run may not start here, or null when it may. */
export function refusal({ stdinIsTTY, stdoutIsTTY, env, markers, ancestor = null }) {
  if (!stdinIsTTY || !stdoutIsTTY) {
    return "run.mjs needs a real terminal (stdin and stdout must be a TTY); nothing was opened";
  }
  const present = markers.filter((m) => env[m] !== undefined && env[m] !== "");
  const found = [...present, ...(ancestor ? [`ancestor ${ancestor}`] : [])];
  if (found.length > 0) {
    return `run.mjs was launched from inside an agent host (${found.join(", ")}); only the person launches it, from a plain terminal outside Herdr`;
  }
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 12 hex chars of sha256 over the scenario and every profile's effective rules and files. */
export function approvalDigest(scenario, profileViews) {
  return createHash("sha256")
    .update(canonical({ scenario, profiles: profileViews }))
    .digest("hex")
    .slice(0, 12);
}

/** True only for the exact digest: no prefix, no case folding beyond trimming. */
export function approves(typed, digest) {
  return typeof typed === "string" && typed.trim() === digest;
}

/**
 * Parses `--model <host>=<m>` and `--effort <host>=<e>` (repeatable) plus the
 * flags run.mjs accepts. Unknown flags are an error, never ignored.
 */
export function parseArgs(argv, hostIds) {
  const out = {
    dryRun: false,
    authCheck: false,
    hosts: [...hostIds],
    model: {},
    effort: {},
    tokenFiles: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--auth-check") {
      out[arg === "--dry-run" ? "dryRun" : "authCheck"] = true;
      continue;
    }
    const parse = VALUE_FLAGS[arg];
    if (parse === undefined) throw new Error(`unknown argument '${arg}'`);
    parse(out, argv[++i] ?? "", hostIds, arg);
  }
  return out;
}

/** Every token/key file flag the hosts take (hosts.mjs). */
const TOKEN_FLAGS = Object.keys(HOSTS).flatMap((id) => tokenSpecs(id).map((t) => t.flag));

const commaList = (value) => value.split(",").filter(Boolean);

function hostValue(out, value, hostIds, flag) {
  const eq = value.indexOf("=");
  const host = value.slice(0, eq);
  if (eq <= 0 || !hostIds.includes(host)) {
    throw new Error(`${flag} expects <host>=<value> with host one of ${hostIds.join(", ")}`);
  }
  out[flag.slice(2)][host] = value.slice(eq + 1);
}

const VALUE_FLAGS = {
  "--model": hostValue,
  "--effort": hostValue,
  "--hosts": (out, value, hostIds) => {
    const list = commaList(value);
    if (list.length === 0 || list.some((h) => !hostIds.includes(h))) {
      throw new Error(`--hosts expects a comma list of ${hostIds.join(", ")}`);
    }
    out.hosts = list;
  },
  // A repeat of some steps only (F4): the matrix keeps the last observation per cell.
  // A file holding a host's token or provider key, keyed by its flag: read at
  // launch, never printed or sealed.
  ...Object.fromEntries(
    TOKEN_FLAGS.map((flag) => [
      flag,
      (out, value) => {
        if (!value) throw new Error(`${flag} expects a path`);
        out.tokenFiles[flag] = value;
      },
    ]),
  ),
  "--steps": (out, value) => {
    out.steps = commaList(value);
    if (out.steps.length === 0) throw new Error("--steps expects a comma list of surfaces");
  },
};
