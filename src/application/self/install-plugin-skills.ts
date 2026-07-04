import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { INSTALL_TARGETS, type InstallTarget, TARGET_ROOTS } from "./install-targets.js";

export interface PluginSkillResult {
  skillName: string;
  dest: string;
  status: "installed" | "skipped" | "dry-run";
  reason?: string;
}

export interface SelfInstallPluginSkillsData {
  status: "installed" | "dry-run" | "partial" | "nothing";
  from: string;
  namespace: string;
  target: InstallTarget;
  skills: PluginSkillResult[];
  summary: string;
}

const VALID_TARGETS: readonly InstallTarget[] = INSTALL_TARGETS;

export async function selfInstallPluginSkills(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfInstallPluginSkillsData>> {
  const fromDir = args.values.get("from");
  const targetArg = (args.values.get("target") ?? "warp") as InstallTarget;
  const namespace = args.values.get("namespace") ?? "";
  const force = args.flags.has("--force");
  const dryRun = args.flags.has("--dry-run");

  if (!fromDir) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "--from <skills-dir> es obligatorio." },
      exitCode: 1,
    };
  }

  if (!VALID_TARGETS.includes(targetArg)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `--target debe ser uno de: ${VALID_TARGETS.join(", ")}. Recibido: '${targetArg}'`,
      },
      exitCode: 1,
    };
  }

  if (!(await dirExists(fromDir))) {
    return {
      ok: false,
      error: { code: "SOURCE_NOT_FOUND", message: `El directorio --from '${fromDir}' no existe.` },
      exitCode: 1,
    };
  }

  const skillDirs = await scanSkillDirs(fromDir);
  if (skillDirs.length === 0) {
    return {
      ok: true,
      data: {
        status: "nothing",
        from: fromDir,
        namespace,
        target: targetArg,
        skills: [],
        summary: `No se encontraron skills válidos en '${fromDir}'.`,
      },
      exitCode: 0,
    };
  }

  const destRoot = join(ctx.env.homeDir(), ...TARGET_ROOTS[targetArg]);
  const results: PluginSkillResult[] = [];

  for (const { name: dirName, path: skillSrcDir } of skillDirs) {
    const finalName = namespace ? `${namespace}-${dirName}` : dirName;
    const dest = join(destRoot, finalName);
    const result = await processSkill({
      finalName,
      skillSrcDir,
      dest,
      namespace,
      force,
      dryRun,
    });
    results.push(result);
  }

  return buildInstallResult({ results, dryRun, destRoot, fromDir, namespace, target: targetArg });
}

interface ProcessSkillOpts {
  finalName: string;
  skillSrcDir: string;
  dest: string;
  namespace: string;
  force: boolean;
  dryRun: boolean;
}

async function processSkill(opts: ProcessSkillOpts): Promise<PluginSkillResult> {
  const { finalName, skillSrcDir, dest, namespace, force, dryRun } = opts;

  if (dryRun) {
    return { skillName: finalName, dest, status: "dry-run" };
  }

  if (!force && (await dirExists(dest))) {
    return {
      skillName: finalName,
      dest,
      status: "skipped",
      reason: "ya existe (usa --force para sobreescribir)",
    };
  }

  try {
    if (force) {
      await rm(dest, { recursive: true, force: true });
    }
    await copyDir(skillSrcDir, dest);

    if (namespace) {
      await patchFrontmatterName(join(dest, "SKILL.md"), finalName);
    }

    return { skillName: finalName, dest, status: "installed" };
  } catch (err) {
    return {
      skillName: finalName,
      dest,
      status: "skipped",
      reason: `error: ${(err as Error).message}`,
    };
  }
}

// Exported: skills-manager reuses the same scan to register/install standalone
// skills (a valid skill dir = subdir with SKILL.md + name/description frontmatter).
export async function scanSkillDirs(fromDir: string): Promise<{ name: string; path: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(fromDir);
  } catch {
    return [];
  }

  const results: { name: string; path: string }[] = [];
  for (const entry of entries) {
    const full = join(fromDir, entry);
    const skillMd = join(full, "SKILL.md");
    try {
      const s = await stat(full);
      if (!s.isDirectory()) continue;
      await stat(skillMd);
      const content = await readFile(skillMd, "utf8");
      if (hasValidFrontmatter(content)) {
        results.push({ name: entry, path: full });
      }
    } catch {
      // not a valid skill dir — skip
    }
  }
  return results;
}

async function patchFrontmatterName(skillMdPath: string, newName: string): Promise<void> {
  const content = await readFile(skillMdPath, "utf8");
  // [^\r\n]* stops before \r on Windows CRLF files so the line ending is preserved.
  const patched = content.replace(
    /^(---\s*\r?\n[\s\S]*?)name:\s*\S[^\r\n]*/m,
    `$1name: ${newName}`,
  );
  if (patched !== content) {
    await writeFile(skillMdPath, patched, "utf8");
  }
}

// Exported: shared with skills-manager (materializes canonical copies) and
// install-skill (bundle copy). Returns the number of files copied.
export async function copyDir(src: string, dest: string): Promise<number> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    // Never follow symlinks: a hostile repo can commit a link to a user file
    // (e.g. ~/.ssh) and copyFile would dereference it when materializing.
    if (entry.isSymbolicLink()) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
      count += 1;
    }
  }
  return count;
}

// Exported: skills-manager applies the same rule for what counts as a skill
// (SKILL.md with name+description frontmatter) when registering single-dir sources.
export function hasValidFrontmatter(content: string): boolean {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  const block = match[1] ?? "";
  return /^name:\s*\S/m.test(block) && /^description:\s*\S/m.test(block);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function buildInstallResult(opts: {
  results: PluginSkillResult[];
  dryRun: boolean;
  destRoot: string;
  fromDir: string;
  namespace: string;
  target: InstallTarget;
}): CommandResult<SelfInstallPluginSkillsData> {
  const { results, dryRun, destRoot, fromDir, namespace, target } = opts;
  const installed = results.filter((r) => r.status === "installed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const hasErrors = results.some((r) => r.reason?.startsWith("error:"));

  const status = dryRun ? "dry-run" : installed === 0 && skipped > 0 ? "partial" : "installed";
  const summary = dryRun
    ? `[dry-run] ${results.length} skills se copiarían a ${destRoot}.`
    : `${installed} skills instalados, ${skipped} omitidos en ${destRoot}.`;

  return {
    ok: !hasErrors,
    data: { status, from: fromDir, namespace, target, skills: results, summary },
    ...(hasErrors
      ? {
          error: {
            code: "INSTALL_PARTIAL",
            message: "Algunos skills fallaron. Ver data.skills para detalles.",
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
  };
}
