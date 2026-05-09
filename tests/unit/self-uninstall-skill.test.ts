import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfUninstallSkill } from "../../src/application/self/uninstall-skill.js";
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
  async run(_cmd: string, _args: string[], _opts?: RunOptions): Promise<RunResult> {
    return { code: 1, stdout: "", stderr: "" };
  }
  async which(_cmd: string): Promise<string | undefined> {
    return undefined;
  }
}

function buildArgs(values: Record<string, string>, flags: string[]): ParsedArgs {
  return {
    rest: ["uninstall-skill"],
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

async function seedTarget(
  home: string,
  target: "claude" | "codex" | "agents",
  skillName: string,
): Promise<string> {
  const root = target === "claude" ? ".claude" : target === "codex" ? ".codex" : ".agents";
  const path = join(home, root, "skills", skillName);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${skillName}\n---\nbody\n`, "utf8");
  return path;
}

async function seedAgentsLock(home: string, skills: Record<string, unknown>): Promise<string> {
  const lockPath = join(home, ".agents", ".skill-lock.json");
  await mkdir(join(home, ".agents"), { recursive: true });
  const content = {
    version: 3,
    skills,
    dismissed: { findSkillsPrompt: true },
    lastSelectedAgents: ["codex", "claude-code"],
  };
  await writeFile(lockPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return lockPath;
}

describe("selfUninstallSkill", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-uninstall-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("--target=all (default) removes canonical from claude+codex (no legacy unless --legacy)", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const claudeCanonical = await seedTarget(home, "claude", "agent-workflow");
    const codexCanonical = await seedTarget(home, "codex", "agent-workflow");
    const claudeLegacy = await seedTarget(home, "claude", "agent-workflow-manager");

    const result = await selfUninstallSkill(buildArgs({}, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("removed");
      const paths = result.data.removed.map((r) => r.path);
      expect(paths).toContain(claudeCanonical);
      expect(paths).toContain(codexCanonical);
      expect(paths).not.toContain(claudeLegacy);
    }
    expect(await fs.exists(claudeCanonical)).toBe(false);
    expect(await fs.exists(codexCanonical)).toBe(false);
    expect(await fs.exists(claudeLegacy)).toBe(true); // preserved without --legacy
  });

  it("--target=claude --legacy removes both canonical and legacy in claude only", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const claudeCanonical = await seedTarget(home, "claude", "agent-workflow");
    const claudeLegacy = await seedTarget(home, "claude", "agent-workflow-manager");
    const codexCanonical = await seedTarget(home, "codex", "agent-workflow");

    const result = await selfUninstallSkill(buildArgs({ target: "claude" }, ["--legacy"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const kinds = result.data.removed.map((r) => `${r.target}:${r.kind}`);
      expect(kinds).toContain("claude:canonical");
      expect(kinds).toContain("claude:legacy");
      expect(kinds.every((k) => k.startsWith("claude:"))).toBe(true);
    }
    expect(await fs.exists(claudeCanonical)).toBe(false);
    expect(await fs.exists(claudeLegacy)).toBe(false);
    expect(await fs.exists(codexCanonical)).toBe(true); // codex untouched
  });

  it("--target=agents --legacy updates .skill-lock.json removing both entries", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const agentsCanonical = await seedTarget(home, "agents", "agent-workflow");
    const agentsLegacy = await seedTarget(home, "agents", "agent-workflow-manager");
    const lockPath = await seedAgentsLock(home, {
      "agent-workflow": { source: "x", sourceUrl: "y" },
      "agent-workflow-manager": { source: "z", sourceUrl: "w" },
    });

    const result = await selfUninstallSkill(buildArgs({ target: "agents" }, ["--legacy"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.lock_updated).toBe(true);
      expect(result.data.lock_path).toBe(lockPath);
    }
    expect(await fs.exists(agentsCanonical)).toBe(false);
    expect(await fs.exists(agentsLegacy)).toBe(false);

    const updatedLock = JSON.parse(await fs.readText(lockPath));
    expect(updatedLock.skills).toEqual({});
    // Preserved fields:
    expect(updatedLock.dismissed.findSkillsPrompt).toBe(true);
    expect(updatedLock.lastSelectedAgents).toContain("codex");
  });

  it("--dry-run reports what would be removed but doesn't touch fs or lock", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const claudeCanonical = await seedTarget(home, "claude", "agent-workflow");
    const lockPath = await seedAgentsLock(home, {
      "agent-workflow": { source: "x", sourceUrl: "y" },
    });

    const result = await selfUninstallSkill(buildArgs({}, ["--dry-run"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
      expect(result.data.removed.every((r) => r.status === "dry-run")).toBe(true);
    }
    expect(await fs.exists(claudeCanonical)).toBe(true); // preserved
    const lockAfter = JSON.parse(await fs.readText(lockPath));
    expect(lockAfter.skills["agent-workflow"]).toBeDefined(); // preserved
  });

  it("--target=invalid is rejected with INVALID_TARGET", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const result = await selfUninstallSkill(buildArgs({ target: "vscode" }, []), ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("INVALID_TARGET");
    }
  });

  it("noop when nothing exists", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const result = await selfUninstallSkill(buildArgs({}, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("noop");
      expect(result.data.removed).toEqual([]);
    }
  });

  it("malformed .skill-lock.json emits warning and leaves lock untouched", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const lockPath = join(home, ".agents", ".skill-lock.json");
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(lockPath, "{ not json", "utf8");

    const result = await selfUninstallSkill(buildArgs({ target: "agents" }, ["--legacy"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.lock_updated).toBe(false);
      expect(result.data.lock_warning).toContain("Could not parse");
    }
    // Malformed lock left untouched.
    expect(await fs.readText(lockPath)).toBe("{ not json");
  });
});
