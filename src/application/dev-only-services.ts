import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESSES, type Harness } from "../domain/harnesses.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { firstNonEmptyLine, parseMdSection, parseMdValue } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";

// ─── harness ────────────────────────────────────────────────────────────────

export interface HarnessOutput {
  harness: Harness;
  supports_plan_subagent: boolean;
  detected_via: string;
  known_harnesses: string[];
}

export function runHarness(
  envGet: (k: string) => string | undefined,
  homedirFn: () => string = homedir,
): HarnessOutput {
  const knownHarnesses = [...HARNESSES.map((h) => h.id), "unknown"];

  // First-match over HARNESSES registry (oz before warp for overlap handling)
  for (const spec of HARNESSES) {
    for (const marker of spec.envMarkers) {
      if (envGet(marker)) {
        return {
          harness: spec.id,
          supports_plan_subagent: spec.id === "claude-code",
          detected_via: `env:${marker}`,
          known_harnesses: knownHarnesses,
        };
      }
    }
    if (spec.termProgramMatch && envGet("TERM_PROGRAM") === spec.termProgramMatch) {
      return {
        harness: spec.id,
        supports_plan_subagent: spec.id === "claude-code",
        detected_via: `env:TERM_PROGRAM=${spec.termProgramMatch}`,
        known_harnesses: knownHarnesses,
      };
    }
  }

  // Filesystem fallback: detect codex by ~/.codex/ directory presence
  const codexHome = join(homedirFn(), ".codex");
  if (existsSync(codexHome) && statSync(codexHome).isDirectory()) {
    if (existsSync(join(codexHome, "config.toml")) || existsSync(join(codexHome, "sessions"))) {
      return {
        harness: "codex",
        supports_plan_subagent: false,
        detected_via: "fs:~/.codex/",
        known_harnesses: knownHarnesses,
      };
    }
  }

  return {
    harness: "unknown",
    supports_plan_subagent: false,
    detected_via: "unknown",
    known_harnesses: knownHarnesses,
  };
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
  exists: boolean;
  current_max: number;
  next: string;
  files: string[];
}

export async function runNextNumber(
  fs: FileSystemPort,
  env: EnvPort,
  directory: string,
): Promise<NextNumberOutput> {
  const cwd = env.cwd();
  const target = directory.startsWith("/") ? directory : join(cwd, directory);
  const exists = await fs.exists(target);
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
    current_max: currentMax,
    next: String(currentMax + 1).padStart(3, "0"),
    files,
  };
}

// Re-export firstNonEmptyLine to keep import surface stable; the helper isn't used
// here yet but downstream services may need it.
export { firstNonEmptyLine };
// `relpath` is exported for future commands that need to relativize paths.
export { relpath };
