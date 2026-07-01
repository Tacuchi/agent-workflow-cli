import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfCleanLegacy } from "../../src/application/self/clean-legacy.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileSystemPort } from "../../src/ports/file-system.js";
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

// Only exists()+list() are exercised by clean-legacy (removal uses node:fs rm directly).
class RealFs implements FileSystemPort {
  async readText(path: string): Promise<string> {
    return (await import("node:fs/promises")).readFile(path, "utf8");
  }
  async writeText(): Promise<void> {}
  async appendText(): Promise<void> {}
  async writeTextExclusive(): Promise<{ created: boolean }> {
    return { created: true };
  }
  async remove(): Promise<void> {}
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async list(path: string): Promise<DirEntry[]> {
    const ents = await readdir(path, { withFileTypes: true });
    return ents.map((e) => ({
      name: e.name,
      path: join(path, e.name),
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
    }));
  }
  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async stat(): Promise<never> {
    throw new Error("nyi");
  }
}

class FakeProcess implements ProcessPort {
  async run(_c: string, _a: string[], _o?: RunOptions): Promise<RunResult> {
    return { code: 1, stdout: "", stderr: "" };
  }
  async which(): Promise<string | undefined> {
    return undefined;
  }
  async spawnDetached(): Promise<never> {
    throw new Error("nyi");
  }
  async spawnInTerminal(): Promise<never> {
    throw new Error("nyi");
  }
  async killTree(): Promise<void> {}
  async isAlive(): Promise<boolean> {
    return false;
  }
}

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: ["clean-legacy"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const paths = new PathsService(ns, home, home);
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
    paths,
  };
}

// Seed a legacy `qtc-*` skill dir under <home>/<root>/skills/.
async function seedLegacy(
  home: string,
  root: string,
  skillName = "qtc-old-skill",
): Promise<string> {
  const path = join(home, root, "skills", skillName);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf8");
  return path;
}

describe("selfCleanLegacy — multi-host coverage", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-clean-legacy-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  for (const target of ["gemini", "opencode", "crush"] as const) {
    it(`--target=${target} is accepted (not INVALID_TARGET)`, async () => {
      const result = await selfCleanLegacy(buildArgs({ target }), buildCtx(home));
      expect(result.ok).toBe(true);
    });
  }

  it("--target=gemini removes a legacy skill under .gemini/skills", async () => {
    const legacy = await seedLegacy(home, ".gemini");
    const result = await selfCleanLegacy(buildArgs({ target: "gemini" }), buildCtx(home));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.removed.map((r) => r.path)).toContain(legacy);
    }
  });

  it("--target=all sweeps the new hosts' native skill dirs (.gemini/.opencode/.crush)", async () => {
    const g = await seedLegacy(home, ".gemini");
    const o = await seedLegacy(home, ".opencode");
    const c = await seedLegacy(home, ".crush");

    const result = await selfCleanLegacy(buildArgs({ target: "all" }), buildCtx(home));

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const removedPaths = result.data.removed.map((r) => r.path);
      expect(removedPaths).toContain(g);
      expect(removedPaths).toContain(o);
      expect(removedPaths).toContain(c);
    }
    const fs = new RealFs();
    expect(await fs.exists(g)).toBe(false);
    expect(await fs.exists(o)).toBe(false);
    expect(await fs.exists(c)).toBe(false);
  });
});
