import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { SKILL_DIR_NAME, selfInstallSkill } from "../../src/application/self/install-skill.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort, RunOptions, RunResult } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

class FakeEnv implements EnvPort {
  constructor(private home: string) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this.home;
  }
  cwd() {
    return this.home;
  }
}

class RealFs implements FileSystemPort {
  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
  async writeText(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
  }
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async list(_path: string): Promise<DirEntry[]> {
    return [];
  }
  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async stat(_path: string): Promise<FileStat> {
    throw new Error("nyi");
  }
}

class FakeProcess implements ProcessPort {
  public lastInvocation: { cmd: string; args: string[] } | undefined;
  async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
    this.lastInvocation = { cmd, args };
    return { code: 1, stdout: "", stderr: `unexpected: ${cmd} ${args.join(" ")}` };
  }
  async which(_cmd: string): Promise<string | undefined> {
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal() {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }
}

function buildArgs(values: Record<string, string>, flags: string[]): ParsedArgs {
  return {
    rest: ["install-skill"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string, fs: FileSystemPort, process: ProcessPort): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const paths = new PathsService(ns, home, home);
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs,
    env: new FakeEnv(home),
    process,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

const validSkillContent = `---
name: agent-workflow
description: Universal skill for the agent-workflow CLI.
version: 1.1.0
---

# agent-workflow
Body.
`;

async function makeFakeRepo(root: string, withFrontmatter = true): Promise<void> {
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    withFrontmatter ? validSkillContent : "# no frontmatter\n",
    "utf8",
  );
  await writeFile(join(root, "README.md"), "# readme\n", "utf8");
  await writeFile(join(root, "references/session-mgmt.md"), "# session-mgmt\n", "utf8");
  await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
}

// Fixture para el flatten de hosts top-level (warp/oz): un sub-skill bajo
// loops/ + docs .md hermanos compartidos a nivel de loops/ (como el
// loops/CHASSIS.md real). README.md del parentDir NO debe copiarse y un
// homónimo propio del sub-skill NO debe pisarse.
async function seedFlattenFixture(root: string): Promise<void> {
  await mkdir(join(root, "loops/quick-loop"), { recursive: true });
  await writeFile(join(root, "loops/CHASSIS.md"), "# CHASSIS compartido\n", "utf8");
  await writeFile(join(root, "loops/README.md"), "# loops readme\n", "utf8");
  await writeFile(join(root, "loops/NOTES.md"), "# notes compartido\n", "utf8");
  await writeFile(
    join(root, "loops/quick-loop/SKILL.md"),
    "---\nname: quick-loop\ndescription: Quick loop.\n---\n\n# quick-loop\n",
    "utf8",
  );
  await writeFile(join(root, "loops/quick-loop/NOTES.md"), "# notes propio\n", "utf8");
}

describe("selfInstallSkill", () => {
  let workdir: string;
  let home: string;
  let source: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-skill-test-"));
    home = join(workdir, "home");
    source = join(workdir, "source");
    await mkdir(home, { recursive: true });
    await makeFakeRepo(source);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("default --target=all installs into all 7 hosts (claude/codex/warp/oz + gemini/opencode/crush)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const args = buildArgs({ from: source, target: "all" }, ["--confirm-all"]);

    const result = await selfInstallSkill(args, ctx);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.source_kind).toBe("path");
      expect(result.data.dests).toHaveLength(7);
      const claudeDest = result.data.dests.find((d) => d.target === "claude");
      const codexDest = result.data.dests.find((d) => d.target === "codex");
      const opencodeDest = result.data.dests.find((d) => d.target === "opencode");
      const geminiDest = result.data.dests.find((d) => d.target === "gemini");
      const crushDest = result.data.dests.find((d) => d.target === "crush");
      expect(claudeDest?.dest).toBe(join(home, ".claude/skills", SKILL_DIR_NAME));
      expect(codexDest?.dest).toBe(join(home, ".codex/skills", SKILL_DIR_NAME));
      expect(opencodeDest?.dest).toBe(join(home, ".opencode/skills", SKILL_DIR_NAME));
      expect(geminiDest?.dest).toBe(join(home, ".gemini/skills", SKILL_DIR_NAME));
      expect(crushDest?.dest).toBe(join(home, ".crush/skills", SKILL_DIR_NAME));
      expect(claudeDest?.overwrote_existing).toBe(false);
      expect(codexDest?.overwrote_existing).toBe(false);
      expect(claudeDest?.files_copied).toBeGreaterThan(0);
      expect(codexDest?.files_copied).toBeGreaterThan(0);
      expect(opencodeDest?.files_copied).toBeGreaterThan(0);
    }

    const claudeSkill = await readFile(
      join(home, ".claude/skills", SKILL_DIR_NAME, "SKILL.md"),
      "utf8",
    );
    const codexSkill = await readFile(
      join(home, ".codex/skills", SKILL_DIR_NAME, "SKILL.md"),
      "utf8",
    );
    expect(claudeSkill).toContain("name: agent-workflow");
    expect(codexSkill).toContain("name: agent-workflow");

    // .git should NOT be copied (in either target)
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME, ".git"))).toBe(false);
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME, ".git"))).toBe(false);
  });

  it("--target=claude installs only to ~/.claude/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "claude" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("claude");
    }
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("--target=codex installs only to ~/.codex/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "codex" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("codex");
    }
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("--target=warp installs only to ~/.warp/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "warp" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("warp");
      expect(result.data.dests[0]?.dest).toBe(join(home, ".warp/skills", SKILL_DIR_NAME));
    }
    expect(await fs.exists(join(home, ".warp/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("flatten (warp): w-quick-loop/ recibe los .md hermanos compartidos (CHASSIS.md) sin pisar homónimos", async () => {
    await seedFlattenFixture(source);
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const result = await selfInstallSkill(buildArgs({ from: source, target: "warp" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      // Solo el sub-skill directorio se aplana; CHASSIS.md (archivo) no cuenta.
      expect(result.data.dests[0]?.flattened_subskills).toBe(1);
      expect(result.data.dests[0]?.flattened_warnings).toBeUndefined();
    }

    const flatDir = join(home, ".warp/skills", "w-quick-loop");
    const skill = await readFile(join(flatDir, "SKILL.md"), "utf8");
    expect(skill).toContain("name: quick-loop");
    // Doc compartido copiado junto al SKILL.md — la referencia tolerante
    // "CHASSIS.md junto a este archivo" resuelve en la instalación aplanada.
    const chassis = await readFile(join(flatDir, "CHASSIS.md"), "utf8");
    expect(chassis).toBe("# CHASSIS compartido\n");
    // Homónimo del sub-skill NO se pisa con el hermano compartido.
    const notes = await readFile(join(flatDir, "NOTES.md"), "utf8");
    expect(notes).toBe("# notes propio\n");
    // README.md del parentDir queda excluido.
    expect(await fs.exists(join(flatDir, "README.md"))).toBe(false);
  });

  it("flatten (oz): mismo comportamiento — CHASSIS.md junto al sub-skill aplanado", async () => {
    await seedFlattenFixture(source);
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const result = await selfInstallSkill(buildArgs({ from: source, target: "oz" }, []), ctx);

    expect(result.ok).toBe(true);
    const flatDir = join(home, ".agents/skills", "w-quick-loop");
    expect(await fs.exists(join(flatDir, "SKILL.md"))).toBe(true);
    expect(await fs.exists(join(flatDir, "CHASSIS.md"))).toBe(true);
  });

  it("--target=oz installs only to ~/.agents/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "oz" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("oz");
      expect(result.data.dests[0]?.dest).toBe(join(home, ".agents/skills", SKILL_DIR_NAME));
    }
    expect(await fs.exists(join(home, ".agents/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".warp/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("--target=invalid is rejected with INVALID_TARGET", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "vscode" }, []), ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TARGET");
    }
  });

  it("rejects when destination exists without --force (any target with conflict)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const claudeDest = join(home, ".claude/skills", SKILL_DIR_NAME);
    await mkdir(claudeDest, { recursive: true });
    await writeFile(join(claudeDest, "SKILL.md"), "old\n", "utf8");

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DEST_EXISTS");
      expect(result.error.message).toContain("--force");
    }

    // Old content preserved; codex not created either.
    const old = await readFile(join(claudeDest, "SKILL.md"), "utf8");
    expect(old).toBe("old\n");
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("overwrites existing dest with --force; reports overwrote_existing per target", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const claudeDest = join(home, ".claude/skills", SKILL_DIR_NAME);
    await mkdir(claudeDest, { recursive: true });
    await writeFile(join(claudeDest, "SKILL.md"), "old\n", "utf8");

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--confirm-all", "--force"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.dests.find((d) => d.target === "claude");
      const codex = result.data.dests.find((d) => d.target === "codex");
      expect(claude?.overwrote_existing).toBe(true);
      expect(codex?.overwrote_existing).toBe(false);
    }

    const fresh = await readFile(join(claudeDest, "SKILL.md"), "utf8");
    expect(fresh).toContain("name: agent-workflow");
  });

  it("--dry-run does not write anything; dests reports preview per target", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--dry-run"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
      expect(result.data.dests).toHaveLength(7);
      expect(result.data.dests.every((d) => d.status === "dry-run")).toBe(true);
    }

    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(false);
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("rejects local source missing SKILL.md", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const badSource = join(workdir, "bad");
    await mkdir(badSource, { recursive: true });

    const result = await selfInstallSkill(
      buildArgs({ from: badSource, target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SKILL_REPO");
    }
  });

  it("rejects local source with invalid SKILL.md frontmatter", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const invalidSource = join(workdir, "invalid");
    await makeFakeRepo(invalidSource, false);

    const result = await selfInstallSkill(
      buildArgs({ from: invalidSource, target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SKILL_FRONTMATTER");
    }
  });

  it("rejects nonexistent local path", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: join(workdir, "does-not-exist"), target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOURCE_NOT_FOUND");
    }
  });

  it("rejects --from <https URL> with INVALID_SOURCE (bundled-only since v3.0.2)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: "https://github.com/Tacuchi/agent-workflow-manager.git", target: "all" }, [
        "--confirm-all",
      ]),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SOURCE");
      expect(result.error.message).toContain("bundled");
    }
    expect(proc.lastInvocation).toBeUndefined();
  });

  it("rejects --from git@... ssh URL with INVALID_SOURCE", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: "git@github.com:Tacuchi/agent-workflow-cli.git", target: "all" }, [
        "--confirm-all",
      ]),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SOURCE");
    }
  });

  it("uses bundled skill when --from is not provided", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ target: "all" }, ["--confirm-all"]),
      ctx,
      async () => source,
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    if (result.ok && result.data) {
      expect(result.data.source_kind).toBe("bundled");
      expect(result.data.source).toBe(source);
      expect(result.data.status).toBe("installed");
    }

    const installed = await readFile(
      join(home, ".claude/skills", SKILL_DIR_NAME, "SKILL.md"),
      "utf8",
    );
    expect(installed).toContain("name: agent-workflow");

    expect(proc.lastInvocation).toBeUndefined();
  });

  it("returns BUNDLED_NOT_FOUND when bundled is missing and --from omitted", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ target: "all" }, ["--confirm-all"]),
      ctx,
      async () => null,
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    if (!result.ok) {
      expect(result.error.code).toBe("BUNDLED_NOT_FOUND");
      expect(result.error.message).toContain("--from");
      expect(result.error.message).not.toContain("http");
    }
    expect(proc.lastInvocation).toBeUndefined();
  });

  it("SKILL_DIR_NAME points to the bundled skill name", () => {
    expect(SKILL_DIR_NAME).toBe("w");
  });

  it("install removes legacy agent-workflow skill + commands dirs (cleaned_legacy)", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    // Seed a pre-`w`-rename install on claude.
    const legacySkill = join(home, ".claude/skills/agent-workflow");
    const legacyCmds = join(home, ".claude/commands/agent-workflow");
    await mkdir(legacySkill, { recursive: true });
    await writeFile(join(legacySkill, "SKILL.md"), "---\nname: agent-workflow\n---\n", "utf8");
    await mkdir(legacyCmds, { recursive: true });
    await writeFile(join(legacyCmds, "session.md"), "# session\n", "utf8");

    const result = await selfInstallSkill(buildArgs({ from: source, target: "claude" }, []), ctx);

    expect(result.ok).toBe(true);
    // Legacy artifacts gone, new install present.
    expect(await fs.exists(legacySkill)).toBe(false);
    expect(await fs.exists(legacyCmds)).toBe(false);
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.dests.find((d) => d.target === "claude");
      expect(claude?.cleaned_legacy).toEqual(expect.arrayContaining([legacySkill, legacyCmds]));
    }
  });

  it("--keep-legacy preserves the old agent-workflow dirs", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const legacySkill = join(home, ".claude/skills/agent-workflow");
    await mkdir(legacySkill, { recursive: true });
    await writeFile(join(legacySkill, "SKILL.md"), "---\nname: agent-workflow\n---\n", "utf8");

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "claude" }, ["--keep-legacy"]),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(await fs.exists(legacySkill)).toBe(true); // preserved
    if (result.ok && result.data) {
      const claude = result.data.dests.find((d) => d.target === "claude");
      expect(claude?.cleaned_legacy).toBeUndefined();
    }
  });

  it("--target missing → TARGET_REQUIRED", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(buildArgs({ from: source }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TARGET_REQUIRED");
      expect(result.error.message).toContain("--target");
    }
  });

  it("--target all without --confirm-all → CONFIRM_ALL_REQUIRED", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(buildArgs({ from: source, target: "all" }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIRM_ALL_REQUIRED");
      expect(result.error.message).toContain("--confirm-all");
    }
  });

  it("--target all with --dry-run does NOT require --confirm-all", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--dry-run"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
    }
  });

  it("--target claude without --keep-cache reports cache_cleared", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(buildArgs({ from: source, target: "claude" }, []), ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claudeDest = result.data.dests.find((d) => d.target === "claude");
      expect(claudeDest?.cache_cleared).toBe(true);
    }
  });

  it("--keep-cache skips pre-clear (cache_cleared=false)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "claude" }, ["--keep-cache"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claudeDest = result.data.dests.find((d) => d.target === "claude");
      expect(claudeDest?.cache_cleared).toBe(false);
    }
  });
});
