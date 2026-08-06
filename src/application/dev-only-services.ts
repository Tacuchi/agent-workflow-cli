import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HARNESSES, type Harness, type HarnessId, harnessById } from "../domain/harnesses.js";
import {
  type HostExecutionCapability,
  type ResourcePlan,
  decideResources,
} from "../domain/resource-policy.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseMdSection, parseMdValue } from "./markdown.js";
import type { PathsService } from "./paths-service.js";

// ─── harness ────────────────────────────────────────────────────────────────

export interface HarnessOutput {
  /** @deprecated Use agent_host. Kept for callers of the previous JSON shape. */
  harness: Harness;
  /** The agent runtime that owns model/tool execution. */
  agent_host: Harness;
  /** The terminal that carries the agent, when it can be observed separately. */
  terminal_host: Harness;
  /** Native dispatch primitive; the CLI's resource policy still controls use. */
  execution: HostExecutionCapability;
  /** The two no-guess defaults the CLI applies before any model work. */
  resource_policy: {
    deterministic: ResourcePlan;
    semantic_default: ResourcePlan;
  };
  supports_plan_subagent: boolean;
  detected_via: string;
  terminal_detected_via: string;
  known_harnesses: string[];
  /**
   * Set when `harness` is `unknown`. Env markers are the only signal this
   * function has, and several hosts export none to their subprocesses — so
   * `unknown` means "no marker in this environment", NEVER "no host here".
   * Which hosts exist on the machine is `aw self detect-hosts`' question, and it
   * answers it from binaries and config dirs instead.
   */
  note?: string;
}

const UNKNOWN_NOTE =
  "No env marker matched. Some hosts export none to their subprocesses, so this is not evidence that no host is present — run 'agent-workflow self detect-hosts' for the machine's real host states.";

/**
 * Which harness are we running INSIDE? Env markers only — that is the single
 * signal a process has about its own parent. A host that exports none (Kimi
 * Code) legitimately answers `unknown`; see `note`.
 */
export function isHarnessId(value: string): value is HarnessId {
  return harnessById(value as HarnessId) !== null;
}

/**
 * Resolves the execution host independently from the terminal. An installed
 * wrapper may bind its target explicitly; the live agent markers are the
 * fallback. This prevents `TERM_PROGRAM=WarpTerminal` from masking Codex (or
 * any other agent) that happens to run inside Warp.
 */
export function runHarness(
  envGet: (k: string) => string | undefined,
  boundHost?: HarnessId,
): HarnessOutput {
  const knownHarnesses = [...HARNESSES.map((h) => h.id), "unknown"];
  const terminal = detectTerminalHarness(envGet);

  if (boundHost !== undefined) {
    const spec = harnessById(boundHost);
    // `boundHost` is typed, but keep this fail-closed guard for JS/API callers.
    if (spec !== null) {
      return outputFor(spec.id, `binding:${spec.id}`, terminal, knownHarnesses);
    }
  }

  // First-match over HARNESSES registry (oz before warp for overlap handling)
  for (const spec of HARNESSES) {
    for (const marker of spec.envMarkers) {
      if (envGet(marker)) {
        return outputFor(spec.id, `env:${marker}`, terminal, knownHarnesses);
      }
    }
    // A terminal-only marker is a fallback agent signal, never precedence over
    // an actual agent marker from an earlier catalog entry.
    if (spec.id === "warp" && terminal.host === "warp") {
      return outputFor("warp", terminal.via, terminal, knownHarnesses);
    }
  }

  // There used to be a filesystem fallback here: `~/.codex/` present → answer
  // "codex". It conflated two different facts — "Codex is INSTALLED on this
  // machine" and "we are RUNNING INSIDE Codex" — and the second is the only one
  // this function is asked about. The consequence was concrete: `aw mcp setup`
  // with no `--host`, run from any unrecognized host, resolved to codex and
  // would have written that host's config.toml, purely because the directory
  // existed. Which hosts are installed is `aw self detect-hosts`' question, and
  // it answers it from binaries and config dirs, as separate states.
  return {
    harness: "unknown",
    agent_host: "unknown",
    terminal_host: terminal.host,
    execution: { subagents: "none", max_subagents: 0, mechanism: null },
    resource_policy: resourcePolicyFor({ subagents: "none", max_subagents: 0, mechanism: null }),
    supports_plan_subagent: false,
    detected_via: "unknown",
    terminal_detected_via: terminal.via,
    known_harnesses: knownHarnesses,
    note: UNKNOWN_NOTE,
  };
}

function outputFor(
  agentHost: HarnessId,
  detectedVia: string,
  terminal: { host: Harness; via: string },
  knownHarnesses: string[],
): HarnessOutput {
  const execution = harnessById(agentHost)?.execution;
  return {
    harness: agentHost,
    agent_host: agentHost,
    terminal_host: terminal.host,
    execution: execution ?? { subagents: "none", max_subagents: 0, mechanism: null },
    resource_policy: resourcePolicyFor(
      execution ?? { subagents: "none", max_subagents: 0, mechanism: null },
    ),
    supports_plan_subagent: execution?.subagents === "parallel",
    detected_via: detectedVia,
    terminal_detected_via: terminal.via,
    known_harnesses: knownHarnesses,
  };
}

function resourcePolicyFor(host: HostExecutionCapability): HarnessOutput["resource_policy"] {
  return {
    deterministic: decideResources({ boundary: "deterministic", host }),
    semantic_default: decideResources({ boundary: "semantic", host }),
  };
}

function detectTerminalHarness(envGet: (k: string) => string | undefined): {
  host: Harness;
  via: string;
} {
  const warp = harnessById("warp");
  if (warp !== null) {
    for (const marker of warp.envMarkers) {
      if (envGet(marker)) return { host: "warp", via: `env:${marker}` };
    }
    if (warp.termProgramMatch && envGet("TERM_PROGRAM") === warp.termProgramMatch) {
      return { host: "warp", via: `env:TERM_PROGRAM=${warp.termProgramMatch}` };
    }
  }
  return { host: "unknown", via: "unknown" };
}

// ─── profiles ───────────────────────────────────────────────────────────────

export interface ProfilesOutput {
  validation_mode: "ask" | "auto" | "manual";
  teaching_mode: "off" | "on";
  delegate_to_subagent: boolean;
  source: "default" | "user-config";
  legacy_section_detected: boolean;
}

export async function runProfiles(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<ProfilesOutput> {
  const result: ProfilesOutput = {
    validation_mode: "ask",
    teaching_mode: "off",
    delegate_to_subagent: false,
    source: "default",
    legacy_section_detected: false,
  };

  const sharedCfg = paths.userConfigMd();
  const legacyCfg = join(homedir(), ".developer-workflow", "user-config.md");
  const userCfg = (await fs.exists(sharedCfg))
    ? sharedCfg
    : (await fs.exists(legacyCfg))
      ? legacyCfg
      : null;
  if (userCfg === null) return result;

  const text = await fs.readText(userCfg);
  let prefsText = parseMdSection(text, "Preferences");
  if (prefsText === undefined) {
    const legacyText = parseMdSection(text, "Workflow profile");
    if (legacyText !== undefined) {
      result.legacy_section_detected = true;
      prefsText = legacyText;
    }
  }
  if (prefsText === undefined) return result;

  const val = parseMdValue(prefsText, "Validation mode")?.toLowerCase();
  if (val === "ask" || val === "auto" || val === "manual") {
    result.validation_mode = val;
    result.source = "user-config";
  }
  const teach = parseMdValue(prefsText, "Teaching mode")?.toLowerCase();
  if (teach === "off" || teach === "on") {
    result.teaching_mode = teach;
    result.source = "user-config";
  }
  const delegate = parseMdValue(prefsText, "Delegate to subagent")?.toLowerCase();
  if (delegate === "true" || delegate === "false") {
    result.delegate_to_subagent = delegate === "true";
    result.source = "user-config";
  }
  return result;
}

// ─── logs ───────────────────────────────────────────────────────────────────

export interface LogsInput {
  tail?: number;
  clear?: boolean;
}

export interface LogsClearedOutput {
  cleared: true;
  path: string;
}

export interface LogsListOutput {
  path: string;
  total_lines?: number;
  showing?: number;
  lines: string[];
  message?: string;
}

export type LogsOutput = LogsClearedOutput | LogsListOutput;

export async function runLogs(
  env: EnvPort,
  paths: PathsService,
  input: LogsInput,
): Promise<LogsOutput> {
  // Unified to the GLOBAL, user-level daily log (~/.${ns}/logs/agent-workflow-*.log):
  // the same source the [Status] tab lists. The old per-workspace path is obsolete.
  void env;
  const logsDir = paths.userLogsDir();
  const path = paths.userDailyLogFile(new Date());

  if (input.clear === true) {
    // Clear every daily log, not just today's.
    if (existsSync(logsDir)) {
      for (const name of readdirSync(logsDir)) {
        if (/^agent-workflow-.*\.log$/.test(name)) unlinkSync(join(logsDir, name));
      }
    }
    return { cleared: true, path: logsDir };
  }

  if (!existsSync(path)) {
    return { lines: [], path, message: "No log file found" };
  }
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  // Mirror Python str.splitlines() — drops trailing empty string.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const tail = input.tail ?? 20;
  const tailLines = tail < total ? lines.slice(total - tail) : lines;
  return {
    path,
    total_lines: total,
    showing: tailLines.length,
    lines: tailLines,
  };
}

// ─── next-number ────────────────────────────────────────────────────────────

export interface NextNumberOutput {
  directory: string;
  /** Pre-call state: whether the directory already existed. */
  exists: boolean;
  /** True when this call created the directory (never with dryRun). */
  created: boolean;
  current_max: number;
  next: string;
  files: string[];
}

export interface NextNumberInput {
  directory: string;
  /** Pure query: never creates the directory (plan/dry-run mode). */
  dryRun?: boolean;
}

export async function runNextNumber(
  fs: FileSystemPort,
  env: EnvPort,
  input: NextNumberInput,
): Promise<NextNumberOutput> {
  const cwd = env.cwd();
  const { directory, dryRun = false } = input;
  const target = isAbsolute(directory) ? directory : join(cwd, directory);
  const exists = await fs.exists(target);
  let created = false;
  if (!exists && !dryRun) {
    // On-demand creation: the CLI owns docs/<category> dirs — workspace-init no
    // longer scaffolds them upfront, they are born at the first numbered write.
    await fs.mkdirp(target);
    created = true;
  }
  const files: string[] = [];
  const numbers: number[] = [];
  if (exists) {
    const entries = await fs.list(target);
    const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sortedEntries) {
      files.push(entry.name);
      const m = entry.name.match(/^(\d{3})/);
      if (m?.[1]) numbers.push(Number.parseInt(m[1], 10));
    }
  }
  const currentMax = numbers.length > 0 ? Math.max(...numbers) : 0;
  return {
    directory: target.split("\\").join("/"),
    exists,
    created,
    current_max: currentMax,
    next: String(currentMax + 1).padStart(3, "0"),
    files,
  };
}
