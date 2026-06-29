import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ProcessRegistryService } from "../../src/application/process-registry-service.js";
import { runProjectMdUpsertWrite } from "../../src/application/project-md-upsert-service.js";
import { removeSource } from "../../src/application/source-remove-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const FIXED_TS = "2026-05-07 12:00";

class TestEnv implements EnvPort {
  constructor(private readonly cwdValue: string) {}
  get(): undefined {
    return undefined;
  }
  homeDir(): string {
    return this.cwdValue;
  }
  cwd(): string {
    return this.cwdValue;
  }
}

class FakeProc implements ProcessPort {
  killed: number[] = [];
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async which() {
    return undefined;
  }
  async spawnDetached() {
    return { pid: 0 };
  }
  async killTree(pid: number) {
    this.killed.push(pid);
  }
  async isAlive() {
    return true;
  }
}

function makePaths(home: string): PathsService {
  return new PathsService(normalizeNamespace("agent-workflow"), home, home);
}

describe("removeSource", () => {
  const fs = new NodeFileSystem();
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-remove-source-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function seedBlock(env: EnvPort, paths: PathsService) {
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "/repo/core", mainBranch: "main" },
        { alias: "plugin", path: "/repo/plugin", mainBranch: "main" },
      ],
      workingBranches: { plugin: "feature/x" },
      qaBranches: { plugin: "desarrollo" },
      lastActivity: FIXED_TS,
    });
  }

  it("prunes the block, stops its processes, and deletes docs/tools/<alias>", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    const proc = new FakeProc();
    await seedBlock(env, paths);

    const toolsDir = join(cwd, "docs", "tools", "plugin");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(join(toolsDir, "launch.json"), "{}");

    const registry = new ProcessRegistryService(fs, proc, paths.cwdProcessesFile());
    await registry.register({
      sourceAlias: "plugin",
      profile: null,
      command: "npm",
      args: ["start"],
      pid: 4321,
      startedAt: FIXED_TS,
      logPath: join(cwd, "docs", "logs", "plugin.log"),
    });

    const result = await removeSource({ fs, env, proc, paths }, "plugin");

    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/core | main |");
    expect(claude).not.toContain("/repo/plugin");
    expect(claude).not.toContain("feature/x");
    expect(claude).not.toContain("- plugin: desarrollo");
    expect(await fs.exists(toolsDir)).toBe(false);
    expect(proc.killed).toContain(4321);
    if (!("error" in result)) expect(result.processesStopped).toBe(1);
  });

  it("returns an error for an unknown alias", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    await seedBlock(env, paths);
    const result = await removeSource({ fs, env, proc: new FakeProc(), paths }, "ghost");
    expect("error" in result).toBe(true);
  });

  it("is idempotent: no processes and no tools dir still succeeds", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    await seedBlock(env, paths);
    const result = await removeSource({ fs, env, proc: new FakeProc(), paths }, "core");
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("/repo/core");
    expect(claude).toContain("/repo/plugin");
  });
});
