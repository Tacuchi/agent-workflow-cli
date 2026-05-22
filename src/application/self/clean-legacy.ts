import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { type InstallTarget, TARGET_ROOTS } from "./install-skill.js";

export type CleanLegacyTargetChoice = InstallTarget | "all";

export interface LegacySkillRemoval {
  target: InstallTarget;
  path: string;
  status: "removed" | "dry-run";
  prefix_matched: string;
}

export interface SelfCleanLegacyData {
  status: "removed" | "dry-run" | "noop";
  removed: LegacySkillRemoval[];
  prefixes_used: string[];
  scanned_dirs: string[];
  summary: string;
}

const ALL_TARGETS: readonly InstallTarget[] = ["claude", "codex", "agents", "warp", "oz"];
const TARGET_CHOICES: readonly CleanLegacyTargetChoice[] = [...ALL_TARGETS, "all"];

// Default legacy patterns left over from pre-v7.0.0 plugins:
// - `qtc-*` — from qtc-workflow-plugin v3.x (37 skills with this prefix)
// - `agent-workflow-manager` — pre-v3.x SKILL name (single entry, full match)
const DEFAULT_LEGACY_PREFIXES: readonly string[] = ["qtc-", "agent-workflow-manager"];

export async function selfCleanLegacy(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfCleanLegacyData>> {
  const dryRun = args.flags.has("--dry-run");
  const targetArg = (args.values.get("target") ?? "all") as CleanLegacyTargetChoice;
  const extraPrefixes = args.valuesMulti.get("prefix") ?? [];
  const prefixes = [...DEFAULT_LEGACY_PREFIXES, ...extraPrefixes];

  if (!TARGET_CHOICES.includes(targetArg)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TARGET",
        message: `--target must be one of: ${TARGET_CHOICES.join(", ")}. Got '${targetArg}'.`,
      },
      exitCode: 1,
    };
  }

  const targets: InstallTarget[] =
    targetArg === "all" ? [...ALL_TARGETS] : [targetArg as InstallTarget];
  const home = ctx.env.homeDir();

  const removed: LegacySkillRemoval[] = [];
  const scannedDirs: string[] = [];
  const seenDirs = new Set<string>();

  for (const target of targets) {
    const skillsDir = join(home, ...TARGET_ROOTS[target]);
    if (seenDirs.has(skillsDir)) continue;
    seenDirs.add(skillsDir);
    scannedDirs.push(skillsDir);
    removed.push(...(await scanDir(ctx, target, skillsDir, prefixes, dryRun)));
  }

  const status: SelfCleanLegacyData["status"] = dryRun
    ? "dry-run"
    : removed.length === 0
      ? "noop"
      : "removed";

  return {
    ok: true,
    data: {
      status,
      removed,
      prefixes_used: prefixes,
      scanned_dirs: scannedDirs,
      summary: buildSummary(status, removed.length, scannedDirs.length),
    },
    exitCode: 0,
  };
}

async function scanDir(
  ctx: CliContext,
  target: InstallTarget,
  skillsDir: string,
  prefixes: readonly string[],
  dryRun: boolean,
): Promise<LegacySkillRemoval[]> {
  if (!(await ctx.fs.exists(skillsDir))) return [];
  const entries = await ctx.fs.list(skillsDir);
  const out: LegacySkillRemoval[] = [];
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    const matched = matchPrefix(entry.name, prefixes);
    if (matched === null) continue;
    const full = join(skillsDir, entry.name);
    if (!dryRun) await rm(full, { recursive: true, force: true });
    out.push({
      target,
      path: full,
      status: dryRun ? "dry-run" : "removed",
      prefix_matched: matched,
    });
  }
  return out;
}

function matchPrefix(name: string, prefixes: readonly string[]): string | null {
  for (const p of prefixes) {
    if (p.endsWith("-")) {
      if (name.startsWith(p)) return p;
    } else if (name === p) {
      return p;
    }
  }
  return null;
}

function buildSummary(
  status: SelfCleanLegacyData["status"],
  count: number,
  dirsScanned: number,
): string {
  if (status === "dry-run") {
    return `[dry-run] ${count} legacy skill(s) found across ${dirsScanned} host dir(s); nothing removed.`;
  }
  if (status === "noop") {
    return `No legacy skills found across ${dirsScanned} host dir(s). All clean.`;
  }
  return `Removed ${count} legacy skill(s) across ${dirsScanned} host dir(s).`;
}
