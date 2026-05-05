import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  DEFAULT_SOURCE,
  SKILL_DIR_NAME,
  selfInstallSkill,
} from "../../src/application/self/install-skill.js";
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
  constructor(private cloneImpl: (dest: string) => Promise<RunResult>) {}
  async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
    this.lastInvocation = { cmd, args };
    if (cmd === "git" && args[0] === "clone") {
      const dest = args[args.length - 1] ?? "";
      return this.cloneImpl(dest);
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${cmd} ${args.join(" ")}` };
  }
  async which(_cmd: string): Promise<string | undefined> {
    return undefined;
  }
}

function buildArgs(values: Record<string, string>, flags: string[]): ParsedArgs {
  return {
    rest: ["install-skill"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
  };
}

function buildCtx(home: string, fs: FileSystemPort, process: ProcessPort): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const paths = new PathsService(ns, home, home);
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow",
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
name: agent-workflow-manager
description: Universal skill for the agent-workflow CLI.
version: 1.0.0
---

# agent-workflow-manager
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

  it("installs from a local path into ~/.claude/skills/agent-workflow-manager/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = buildCtx(home, fs, proc);
    const args = buildArgs({ from: source }, []);

    const result = await selfInstallSkill(args, ctx);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.source_kind).toBe("path");
      expect(result.data.dest).toBe(join(home, ".claude/skills", SKILL_DIR_NAME));
      expect(result.data.overwrote_existing).toBe(false);
      expect(result.data.files_copied).toBeGreaterThan(0);
    }

    const installedSkill = await readFile(
      join(home, ".claude/skills", SKILL_DIR_NAME, "SKILL.md"),
      "utf8",
    );
    expect(installedSkill).toContain("name: agent-workflow-manager");

    // .git should NOT be copied
    const gitExists = await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME, ".git"));
    expect(gitExists).toBe(false);

    // References preserved
    const ref = await readFile(
      join(home, ".claude/skills", SKILL_DIR_NAME, "references/session-mgmt.md"),
      "utf8",
    );
    expect(ref).toContain("session-mgmt");
  });

  it("rejects when destination exists without --force", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = buildCtx(home, fs, proc);
    const dest = join(home, ".claude/skills", SKILL_DIR_NAME);
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "SKILL.md"), "old\n", "utf8");

    const result = await selfInstallSkill(buildArgs({ from: source }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DEST_EXISTS");
    }

    // Old content preserved
    const old = await readFile(join(dest, "SKILL.md"), "utf8");
    expect(old).toBe("old\n");
  });

  it("overwrites destination with --force", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = buildCtx(home, fs, proc);
    const dest = join(home, ".claude/skills", SKILL_DIR_NAME);
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "SKILL.md"), "old\n", "utf8");

    const result = await selfInstallSkill(buildArgs({ from: source }, ["--force"]), ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.overwrote_existing).toBe(true);
    }

    const fresh = await readFile(join(dest, "SKILL.md"), "utf8");
    expect(fresh).toContain("name: agent-workflow-manager");
  });

  it("--dry-run does not write anything", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = buildCtx(home, fs, proc);
    const dest = join(home, ".claude/skills", SKILL_DIR_NAME);

    const result = await selfInstallSkill(buildArgs({ from: source }, ["--dry-run"]), ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
    }

    expect(await fs.exists(dest)).toBe(false);
  });

  it("rejects local source missing SKILL.md", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = buildCtx(home, fs, proc);
    const badSource = join(workdir, "bad");
    await mkdir(badSource, { recursive: true });

    const result = await selfInstallSkill(buildArgs({ from: badSource }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SKILL_REPO");
    }
  });

  it("rejects local source with invalid SKILL.md frontmatter", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = buildCtx(home, fs, proc);
    const invalidSource = join(workdir, "invalid");
    await makeFakeRepo(invalidSource, false);

    const result = await selfInstallSkill(buildArgs({ from: invalidSource }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SKILL_FRONTMATTER");
    }
  });

  it("rejects nonexistent local path", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: join(workdir, "does-not-exist") }, []),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOURCE_NOT_FOUND");
    }
  });

  it("clones when source is a URL", async () => {
    const fs = new RealFs();
    let clonedTo: string | undefined;
    const proc = new FakeProcess(async (dest) => {
      clonedTo = dest;
      // Simulate git clone by populating the dest dir
      await makeFakeRepo(dest);
      return { code: 0, stdout: "", stderr: "" };
    });
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: "https://github.com/Tacuchi/agent-workflow-manager.git" }, []),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.source_kind).toBe("url");
      expect(result.data.status).toBe("installed");
    }
    expect(clonedTo).toBeDefined();
    expect(proc.lastInvocation?.cmd).toBe("git");
    expect(proc.lastInvocation?.args.slice(0, 3)).toEqual(["clone", "--depth", "1"]);
  });

  it("fails gracefully when git clone exits non-zero", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess(async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: repository not found",
    }));
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: "https://github.com/missing/repo.git" }, []),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CLONE_FAILED");
      expect(result.error.message).toContain("128");
    }
  });

  it("default source is the canonical GitHub URL", () => {
    expect(DEFAULT_SOURCE).toBe("https://github.com/Tacuchi/agent-workflow-manager.git");
  });
});
