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

const ns = normalizeNamespace("qtc");
const paths = new PathsService(ns, "/home/u", "/cwd");
const runtime: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

describe("selfDoctor", () => {
  it("reports skill installed when ~/.claude/skills/agent-workflow-manager exists", async () => {
    const fs = new FakeFs(new Set(["/home/u/.claude/skills/agent-workflow-manager"]));
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
      expect(result.data.skill.path).toBe("/home/u/.claude/skills/agent-workflow-manager");
      expect(result.data.namespace.value).toBe("qtc");
      expect(result.data.paths.user_root).toBe("/home/u/.qtc");
    }
  });

  it("reports skill not installed when path absent", async () => {
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
    }
  });
});
