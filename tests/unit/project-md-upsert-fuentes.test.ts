import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runProjectMdUpsertWrite } from "../../src/application/project-md-upsert-service.js";
import type { EnvPort } from "../../src/ports/env.js";
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

function makePaths(home: string): PathsService {
  const ns = normalizeNamespace("agent-workflow");
  return new PathsService(ns, home, home);
}

describe("project-md-upsert --init with --fuente / --main-branch", () => {
  const fs = new NodeFileSystem();
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-pmu-fuentes-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("renders 1 fuente from --fuente alias:path:rama", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/core | main |");
  });

  it("renders 2 fuentes with shared --main-branch fallback", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "/repo/core" },
        { alias: "plugin", path: "/repo/plugin" },
      ],
      mainBranch: "certificacion",
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/core | certificacion |");
    expect(claude).toContain("| plugin | /repo/plugin | certificacion |");
  });

  it("renders 3 fuentes with mixed per-fuente rama and --main-branch fallback", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "/repo/core", mainBranch: "main" },
        { alias: "plugin", path: "/repo/plugin" },
        { alias: "marketplace", path: "/repo/marketplace", mainBranch: "stable" },
      ],
      mainBranch: "certificacion",
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/core | main |");
    expect(claude).toContain("| plugin | /repo/plugin | certificacion |");
    expect(claude).toContain("| marketplace | /repo/marketplace | stable |");
  });

  it("falls back to 'certificacion' when neither per-fuente rama nor --main-branch are given", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core" }],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/core | certificacion |");
  });

  it("merges --working-branch entries (multi-flag) into Status", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "/repo/core" },
        { alias: "plugin", path: "/repo/plugin" },
      ],
      mainBranch: "certificacion",
      workingBranches: { core: "feature/upgrade", plugin: "feature/upgrade" },
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    // No `Mode:` line is ever emitted (the project/hub mode concept is gone).
    expect(claude).not.toMatch(/^Mode:/m);
    expect(claude).toContain("- core: feature/upgrade");
    expect(claude).toContain("- plugin: feature/upgrade");
  });

  it("merges --qa-branch entries (multi-flag) into Status", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "/repo/core" },
        { alias: "plugin", path: "/repo/plugin" },
      ],
      mainBranch: "certificacion",
      qaBranches: { core: "desarrollo", plugin: "desarrollo" },
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("- Ramas QA actuales:");
    expect(claude).toContain("  - core: desarrollo");
    expect(claude).toContain("  - plugin: desarrollo");
  });

  it("preserves existing qa_branches and merges new ones on re-init", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core" }],
      qaBranches: { core: "desarrollo" },
      lastActivity: FIXED_TS,
    });
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      qaBranches: { plugin: "qa/plugin" },
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("  - core: desarrollo");
    expect(claude).toContain("  - plugin: qa/plugin");
  });

  it("preserves existing fuentes and overrides matching alias on re-init", async () => {
    const env = new TestEnv(cwd);
    const paths = makePaths(cwd);
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "/repo/old-core", mainBranch: "main" },
        { alias: "extra", path: "/repo/extra", mainBranch: "main" },
      ],
      lastActivity: FIXED_TS,
    });
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/new-core", mainBranch: "stable" }],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/new-core | stable |");
    expect(claude).toContain("| extra | /repo/extra | main |");
    expect(claude).not.toContain("/repo/old-core");
  });
});
