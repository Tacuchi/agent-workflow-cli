import { cp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";

export const SKILL_DIR_NAME = "agent-workflow";
export const BUNDLED_SKILL_REL_PATH = `skills/${SKILL_DIR_NAME}`;

export type InstallTarget = "claude" | "codex" | "agents";

export const TARGET_ROOTS: Record<InstallTarget, readonly string[]> = {
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  agents: [".agents", "skills"],
};

export const AGENTS_LOCK_REL = [".agents", ".skill-lock.json"] as const;
export const LEGACY_SKILL_NAME = "agent-workflow-manager";

export interface SelfInstallTargetResult {
  target: InstallTarget;
  dest: string;
  status: "installed" | "dry-run" | "skipped";
  overwrote_existing: boolean;
  files_copied?: number;
  error?: string;
}

export interface SelfInstallSkillData {
  status: "installed" | "dry-run" | "partial";
  source: string;
  source_kind: "path" | "bundled";
  dests: SelfInstallTargetResult[];
}

const TARGET_CHOICES: readonly (InstallTarget | "all")[] = ["claude", "codex", "agents", "all"];

const ALL_INSTALL_TARGETS: readonly InstallTarget[] = ["claude", "codex"];

export async function selfInstallSkill(
  args: ParsedArgs,
  ctx: CliContext,
  resolveBundled: () => Promise<string | null> = resolveBundledSkillPath,
): Promise<CommandResult<SelfInstallSkillData>> {
  const force = args.flags.has("--force");
  const dryRun = args.flags.has("--dry-run");
  const targetArg = args.values.get("target") ?? "all";

  const targetsResult = resolveTargets(targetArg);
  if (!targetsResult.ok) return targetsResult.result;
  const targets = targetsResult.value;

  const sourceResult = await resolveSource(args.values.get("from"), resolveBundled);
  if (!sourceResult.ok) return sourceResult.result;
  const { sourceArg, sourceKind } = sourceResult.value;

  const destByTarget = buildDestByTarget(ctx.env.homeDir());
  const existingTargets = await Promise.all(
    targets.map(async (t) => ({ target: t, exists: await ctx.fs.exists(destByTarget[t]) })),
  );

  const blocking = existingTargets.filter((t) => t.exists && !force && !dryRun);
  if (blocking.length > 0) {
    const names = blocking.map((t) => destByTarget[t.target]).join(", ");
    return {
      ok: false,
      error: {
        code: "DEST_EXISTS",
        message: `Destination already exists: ${names}. Use --force to overwrite, --dry-run to preview, or --target <claude|codex> to install only one.`,
      },
      exitCode: 1,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      data: {
        status: "dry-run",
        source: sourceArg,
        source_kind: sourceKind,
        dests: existingTargets.map((t) => ({
          target: t.target,
          dest: destByTarget[t.target],
          status: "dry-run",
          overwrote_existing: t.exists,
        })),
      },
      exitCode: 0,
    };
  }

  const validation = await validateSourceContents(sourceArg, ctx);
  if (validation) return validation;

  const results: SelfInstallTargetResult[] = [];
  for (const t of existingTargets) {
    const dest = destByTarget[t.target];
    if (t.exists && force) {
      await rm(dest, { recursive: true, force: true });
    }
    const filesCopied = await copyTree(sourceArg, dest);
    results.push({
      target: t.target,
      dest,
      status: "installed",
      overwrote_existing: t.exists,
      files_copied: filesCopied,
    });
  }

  return {
    ok: true,
    data: {
      status: "installed",
      source: sourceArg,
      source_kind: sourceKind,
      dests: results,
    },
    exitCode: 0,
  };
}

type Resolved<T> =
  | { ok: true; value: T }
  | { ok: false; result: CommandResult<SelfInstallSkillData> };

function resolveTargets(targetArg: string): Resolved<InstallTarget[]> {
  if (!TARGET_CHOICES.includes(targetArg as InstallTarget | "all")) {
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: "INVALID_TARGET",
          message: `--target must be one of: ${TARGET_CHOICES.join(", ")}. Got '${targetArg}'.`,
        },
        exitCode: 1,
      },
    };
  }
  const targets: InstallTarget[] =
    targetArg === "all" ? [...ALL_INSTALL_TARGETS] : [targetArg as InstallTarget];
  return { ok: true, value: targets };
}

async function resolveSource(
  fromArg: string | undefined,
  resolveBundled: () => Promise<string | null>,
): Promise<Resolved<{ sourceArg: string; sourceKind: "path" | "bundled" }>> {
  if (fromArg !== undefined) {
    if (looksLikeRemoteUrl(fromArg)) {
      return {
        ok: false,
        result: {
          ok: false,
          error: {
            code: "INVALID_SOURCE",
            message:
              "--from must be a local filesystem path. Remote URLs are no longer supported — the skill is bundled inside the CLI tarball. Drop --from to install the bundled skill, or pass a local checkout path.",
          },
          exitCode: 1,
        },
      };
    }
    return { ok: true, value: { sourceArg: fromArg, sourceKind: "path" } };
  }
  const bundled = await resolveBundled();
  if (bundled === null) {
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: "BUNDLED_NOT_FOUND",
          message: `Bundled skill not found relative to the CLI install. This usually means you are running from a dev checkout without a build, or the tarball is missing 'skills/'. Use --from <local-path> to override.`,
        },
        exitCode: 1,
      },
    };
  }
  return { ok: true, value: { sourceArg: bundled, sourceKind: "bundled" } };
}

function buildDestByTarget(home: string): Record<InstallTarget, string> {
  return {
    claude: join(home, ...TARGET_ROOTS.claude, SKILL_DIR_NAME),
    codex: join(home, ...TARGET_ROOTS.codex, SKILL_DIR_NAME),
    agents: join(home, ...TARGET_ROOTS.agents, SKILL_DIR_NAME),
  };
}

async function validateSourceContents(
  sourceArg: string,
  ctx: CliContext,
): Promise<CommandResult<SelfInstallSkillData> | null> {
  if (!(await ctx.fs.exists(sourceArg))) {
    return {
      ok: false,
      error: {
        code: "SOURCE_NOT_FOUND",
        message: `Source path '${sourceArg}' does not exist.`,
      },
      exitCode: 1,
    };
  }
  const skillPath = join(sourceArg, "SKILL.md");
  if (!(await ctx.fs.exists(skillPath))) {
    return {
      ok: false,
      error: {
        code: "INVALID_SKILL_REPO",
        message: `Source missing SKILL.md at ${skillPath}.`,
      },
      exitCode: 1,
    };
  }
  const skillContent = await readFile(skillPath, "utf8");
  if (!hasValidFrontmatter(skillContent)) {
    return {
      ok: false,
      error: {
        code: "INVALID_SKILL_FRONTMATTER",
        message: "SKILL.md frontmatter must include 'name' and 'description'.",
      },
      exitCode: 1,
    };
  }
  return null;
}

function looksLikeRemoteUrl(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(value);
}

function hasValidFrontmatter(content: string): boolean {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return false;
  const block = match[1] ?? "";
  return /^name:\s*\S/m.test(block) && /^description:\s*\S/m.test(block);
}

async function copyTree(src: string, dest: string): Promise<number> {
  let count = 0;
  await cp(src, dest, {
    recursive: true,
    filter: (source: string) => {
      const rel = source.slice(src.length);
      if (rel.startsWith("/.git") || rel === "/.git") return false;
      count += 1;
      return true;
    },
  });
  return count;
}

export async function resolveBundledSkillPath(): Promise<string | null> {
  const here = dirname(fileURLToPath(import.meta.url));
  let current = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(current, BUNDLED_SKILL_REL_PATH);
    const skillFile = join(candidate, "SKILL.md");
    try {
      await stat(skillFile);
      return candidate;
    } catch {
      // not here, walk up
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
