import { spawn } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import type { SelfInstallPluginSkillsData } from "./install-plugin-skills.js";
import { selfInstallPluginSkills } from "./install-plugin-skills.js";
import { INSTALL_TARGETS, type InstallTarget } from "./install-skill.js";

const VALID_TARGETS: readonly InstallTarget[] = INSTALL_TARGETS;

export async function installPluginSkillsFromGit(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfInstallPluginSkillsData>> {
  const rawUrl = args.values.get("url");
  const targetArg = (args.values.get("target") ?? "warp") as InstallTarget;
  const namespace = args.values.get("namespace") ?? "";
  const force = args.flags.has("--force");

  if (!rawUrl) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "--url <git-url> es obligatorio." },
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

  // Split URL#ref (e.g. "https://...git#feature/last")
  const hashIdx = rawUrl.indexOf("#");
  const url = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
  const ref = args.values.get("ref") ?? (hashIdx >= 0 ? rawUrl.slice(hashIdx + 1) : undefined);

  const tempDir = await mkdtemp(join(tmpdir(), "aw-git-install-"));
  try {
    try {
      await gitClone(url, tempDir, ref);
    } catch (err) {
      return {
        ok: false,
        error: { code: "GIT_CLONE_FAILED", message: (err as Error).message },
        exitCode: 1,
      };
    }

    const resolvedDir = await resolvePluginDir(tempDir, namespace);
    if (!resolvedDir) {
      return {
        ok: false,
        error: {
          code: "SOURCE_NOT_FOUND",
          message: `No se encontró directorio de skills válido en '${url}'.`,
        },
        exitCode: 1,
      };
    }

    const innerValues = new Map<string, string>(args.values);
    innerValues.set("from", resolvedDir);
    innerValues.set("target", targetArg);
    if (namespace) innerValues.set("namespace", namespace);
    const innerArgs: ParsedArgs = {
      ...args,
      flags: new Set(force ? ["--force"] : []),
      values: innerValues,
    };
    return selfInstallPluginSkills(innerArgs, ctx);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Exported: skills-manager reuses the same shallow clone for register/update.
export async function gitClone(url: string, dest: string, ref?: string): Promise<void> {
  const gitArgs = ["clone", "--depth=1"];
  if (ref) gitArgs.push("--branch", ref);
  gitArgs.push(url, dest);

  await new Promise<void>((resolve, reject) => {
    // Nunca prompts interactivos: bajo la TUI (alt-screen + raw mode) git
    // preguntaría credenciales/host-key por /dev/tty invisible y colgaría el
    // busy-lock para siempre (mismo fix que GitCliAdapter). Fallar rápido.
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
    };
    const proc = spawn("git", gitArgs, { stdio: "pipe", env });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone falló (exit ${code}): ${stderr.trim()}`));
    });
    proc.on("error", reject);
  });
}

async function resolvePluginDir(cloneDir: string, namespace: string): Promise<string | null> {
  // Case 1: marketplace manifest — clone the actual plugin repo
  const manifestPath = join(cloneDir, "marketplace-codex.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as MarketplaceManifest;
    const plugin = namespace
      ? manifest.plugins?.find((p) => p.name === namespace)
      : manifest.plugins?.[0];
    if (plugin?.source?.url) {
      const pluginTempDir = await mkdtemp(join(tmpdir(), "aw-git-plugin-"));
      try {
        const pluginRef = plugin.source.ref;
        await gitClone(plugin.source.url, pluginTempDir, pluginRef);
        return await findSkillsRoot(pluginTempDir);
      } catch {
        await rm(pluginTempDir, { recursive: true, force: true }).catch(() => {});
        return null;
      }
    }
  } catch {
    // Not a marketplace — continue
  }

  // Case 2: direct plugin repo
  return findSkillsRoot(cloneDir);
}

async function findSkillsRoot(dir: string): Promise<string | null> {
  // Prefer explicit skills/ subdir
  const skillsSubdir = join(dir, "skills");
  if (await hasValidSkillDirs(skillsSubdir)) return skillsSubdir;
  // Fallback: root has skill dirs directly
  if (await hasValidSkillDirs(dir)) return dir;
  return null;
}

async function hasValidSkillDirs(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const s = await stat(full);
        if (!s.isDirectory()) continue;
        const skillMdContent = await readFile(join(full, "SKILL.md"), "utf8");
        if (/^---[ \t]*\r?\n[\s\S]*?name:\s*\S/m.test(skillMdContent)) return true;
      } catch {
        // not a skill dir
      }
    }
    return false;
  } catch {
    return false;
  }
}

interface MarketplaceManifest {
  plugins?: Array<{
    name: string;
    source?: { url: string; ref?: string };
  }>;
}
