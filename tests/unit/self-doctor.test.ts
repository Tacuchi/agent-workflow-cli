import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfDoctor } from "../../src/application/self/doctor-self.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

class FakeEnv implements EnvPort {
  get() {
    return undefined;
  }
  homeDir() {
    return "/home/u";
  }
  cwd() {
    return "/cwd";
  }
}

class FakeFs implements FileSystemPort {
  constructor(private files: Set<string>) {}
  async readText(): Promise<string> {
    throw new Error("nyi");
  }
  async writeText(): Promise<void> {}
  async exists(p: string) {
    return this.files.has(p);
  }
  async list(): Promise<DirEntry[]> {
    return [];
  }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> {
    throw new Error("nyi");
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const runtime: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

describe("selfDoctor", () => {
  it("reports skill installed when ~/.claude/skills/agent-workflow exists (codex absent)", async () => {
    const fs = new FakeFs(new Set(["/home/u/.claude/skills/agent-workflow"]));
    const ctx = {
      fs,
      env: new FakeEnv(),
      paths,
      namespace: { namespace: ns, source: "env" },
      runtime,
    } as unknown as CliContext;
    const result = await selfDoctor(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.skill.installed).toBe(true);
      const claude = result.data.skill.targets.find((t) => t.target === "claude");
      const codex = result.data.skill.targets.find((t) => t.target === "codex");
      expect(claude?.path).toBe("/home/u/.claude/skills/agent-workflow");
      expect(claude?.installed).toBe(true);
      expect(codex?.path).toBe("/home/u/.codex/skills/agent-workflow");
      expect(codex?.installed).toBe(false);
      expect(result.data.namespace.value).toBe("workflow");
      expect(result.data.paths.user_root).toBe("/home/u/.workflow");
    }
  });

  it("reports both targets installed when claude and codex have it", async () => {
    const fs = new FakeFs(
      new Set(["/home/u/.claude/skills/agent-workflow", "/home/u/.codex/skills/agent-workflow"]),
    );
    const ctx = {
      fs,
      env: new FakeEnv(),
      paths,
      namespace: { namespace: ns, source: "env" },
      runtime,
    } as unknown as CliContext;
    const result = await selfDoctor(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.skill.installed).toBe(true);
      expect(result.data.skill.targets.every((t) => t.installed)).toBe(true);
    }
  });

  it("reports skill not installed when neither path is present", async () => {
    const fs = new FakeFs(new Set());
    const ctx = {
      fs,
      env: new FakeEnv(),
      paths,
      namespace: { namespace: ns, source: "default" },
      runtime,
    } as unknown as CliContext;
    const result = await selfDoctor(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.skill.installed).toBe(false);
      expect(result.data.skill.targets.every((t) => !t.installed)).toBe(true);
      expect(result.data.skill.targets.every((t) => !t.legacy_leftover)).toBe(true);
    }
  });

  it("flags legacy skill leftover in claude target", async () => {
    const fs = new FakeFs(
      new Set([
        "/home/u/.claude/skills/agent-workflow",
        "/home/u/.claude/skills/agent-workflow-manager",
      ]),
    );
    const ctx = {
      fs,
      env: new FakeEnv(),
      paths,
      namespace: { namespace: ns, source: "config" },
      runtime,
    } as unknown as CliContext;
    const result = await selfDoctor(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.skill.targets.find((t) => t.target === "claude");
      const codex = result.data.skill.targets.find((t) => t.target === "codex");
      expect(claude?.installed).toBe(true);
      expect(claude?.legacy_leftover).toBe(true);
      expect(claude?.legacy_leftover_path).toBe("/home/u/.claude/skills/agent-workflow-manager");
      expect(claude?.legacy_leftover_warning).toContain("agent-workflow-manager");
      expect(codex?.legacy_leftover).toBeUndefined();
    }
  });

  it("flags legacy skill leftover in codex target independently", async () => {
    const fs = new FakeFs(new Set(["/home/u/.codex/skills/agent-workflow-manager"]));
    const ctx = {
      fs,
      env: new FakeEnv(),
      paths,
      namespace: { namespace: ns, source: "default" },
      runtime,
    } as unknown as CliContext;
    const result = await selfDoctor(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const codex = result.data.skill.targets.find((t) => t.target === "codex");
      expect(codex?.installed).toBe(false);
      expect(codex?.legacy_leftover).toBe(true);
      expect(codex?.legacy_leftover_path).toBe("/home/u/.codex/skills/agent-workflow-manager");
    }
  });

  it("does not flag leftover when only the new skill is present", async () => {
    const fs = new FakeFs(new Set(["/home/u/.claude/skills/agent-workflow"]));
    const ctx = {
      fs,
      env: new FakeEnv(),
      paths,
      namespace: { namespace: ns, source: "env" },
      runtime,
    } as unknown as CliContext;
    const result = await selfDoctor(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.skill.installed).toBe(true);
      expect(result.data.skill.targets.every((t) => !t.legacy_leftover)).toBe(true);
    }
  });
});
