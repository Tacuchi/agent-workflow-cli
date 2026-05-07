import { cp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";

export const SKILL_DIR_NAME = "agent-workflow";
export const BUNDLED_SKILL_REL_PATH = `skills/${SKILL_DIR_NAME}`;

export interface SelfInstallSkillData {
  status: "installed" | "dry-run";
  source: string;
  source_kind: "path" | "bundled";
  dest: string;
  files_copied?: number;
  overwrote_existing?: boolean;
}

export async function selfInstallSkill(
  args: ParsedArgs,
  ctx: CliContext,
  resolveBundled: () => Promise<string | null> = resolveBundledSkillPath,
): Promise<CommandResult<SelfInstallSkillData>> {
  const force = args.flags.has("--force");
  const dryRun = args.flags.has("--dry-run");
  const fromArg = args.values.get("from");
  const dest = join(ctx.env.homeDir(), ".claude", "skills", SKILL_DIR_NAME);

  let sourceArg: string;
  let sourceKind: "path" | "bundled";

  if (fromArg !== undefined) {
    if (looksLikeRemoteUrl(fromArg)) {
      return {
        ok: false,
        error: {
          code: "INVALID_SOURCE",
          message: `--from must be a local filesystem path. Remote URLs are no longer supported — the skill is bundled inside the CLI tarball. Drop --from to install the bundled skill, or pass a local checkout path.`,
        },
        exitCode: 1,
      };
    }
    sourceArg = fromArg;
    sourceKind = "path";
  } else {
    const bundled = await resolveBundled();
    if (bundled === null) {
      return {
        ok: false,
        error: {
          code: "BUNDLED_NOT_FOUND",
          message: `Bundled skill not found relative to the CLI install. This usually means you are running from a dev checkout without a build, or the tarball is missing 'skills/'. Use --from <local-path> to override.`,
        },
        exitCode: 1,
      };
    }
    sourceArg = bundled;
    sourceKind = "bundled";
  }

  const destExists = await ctx.fs.exists(dest);
  if (destExists && !force && !dryRun) {
    return {
      ok: false,
      error: {
        code: "DEST_EXISTS",
        message: `Destination ${dest} already exists. Use --force to overwrite or --dry-run to preview.`,
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
        dest,
        overwrote_existing: destExists,
      },
      exitCode: 0,
    };
  }

  const sourceExists = await ctx.fs.exists(sourceArg);
  if (!sourceExists) {
    return {
      ok: false,
      error: {
        code: "SOURCE_NOT_FOUND",
        message: `Source path '${sourceArg}' does not exist.`,
      },
      exitCode: 1,
    };
  }
  const stagingDir = sourceArg;

  const skillPath = join(stagingDir, "SKILL.md");
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

  if (destExists && force) {
    await rm(dest, { recursive: true, force: true });
  }

  const filesCopied = await copyTree(stagingDir, dest);

  return {
    ok: true,
    data: {
      status: "installed",
      source: sourceArg,
      source_kind: sourceKind,
      dest,
      files_copied: filesCopied,
      overwrote_existing: destExists,
    },
    exitCode: 0,
  };
}

/**
 * Reject `--from` values that look like a remote URL up front so users get a
 * clear error instead of a confusing "path does not exist". The skill is
 * bundled-only since v3.0.2 — the standalone repo `Tacuchi/agent-workflow-manager`
 * is no longer maintained.
 */
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

/**
 * Resolve the bundled skill path by walking up from this module's directory
 * until a `skills/agent-workflow/SKILL.md` is found. Returns the directory
 * containing SKILL.md, or null if no candidate is reachable.
 *
 * Works in both dist (`dist/application/self/install-skill.js`) and dev
 * (`src/application/self/install-skill.ts` via a runner) layouts because the
 * walk-up looks for the marker file rather than a fixed depth.
 */
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
