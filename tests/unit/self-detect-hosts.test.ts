import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfDetectHosts } from "../../src/application/self/detect-hosts.js";
import { SKILL_DIR_NAME } from "../../src/application/self/install-skill.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort } from "../../src/ports/process.js";
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
  async readText(): Promise<string> {
    throw new Error("nyi");
  }
  async writeText(): Promise<void> {}
  async writeTextExclusive(): Promise<{ created: boolean }> {
    return { created: true };
  }
  async remove(): Promise<void> {}
  async exists(path: string): Promise<boolean> {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async list(): Promise<DirEntry[]> {
    return [];
  }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> {
    throw new Error("nyi");
  }
}

class FakeProcess implements ProcessPort {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async which() {
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }
}

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new RealFs(),
    env: new FakeEnv(home),
    process: new FakeProcess(),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("selfDetectHosts", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "self-detect-hosts-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns 5 hosts, all undetected when no config dirs exist", async () => {
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.hosts).toHaveLength(5);
      expect(result.data.detected_count).toBe(0);
      expect(result.data.installed_count).toBe(0);
      expect(result.data.summary).toContain("No host config");
    }
  });

  it("detects ~/.claude/ when present", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.hosts.find((h) => h.target === "claude");
      expect(claude?.config_dir_present).toBe(true);
      expect(claude?.skill_installed).toBe(false);
      expect(result.data.detected_count).toBe(1);
    }
  });

  it("detects skill installed under ~/.claude/skills/agent-workflow/", async () => {
    await mkdir(join(home, ".claude", "skills", SKILL_DIR_NAME), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.hosts.find((h) => h.target === "claude");
      expect(claude?.skill_installed).toBe(true);
      expect(result.data.installed_count).toBe(1);
    }
  });

  it("reports multiple hosts independently", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".warp", "skills", SKILL_DIR_NAME), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.detected_count).toBe(3);
      expect(result.data.installed_count).toBe(1);
      expect(result.data.summary).toContain("Detected 3");
      expect(result.data.summary).toContain("installed in 1");
    }
  });
});
