import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runProjectMdUpsertWrite } from "../../src/application/project-md-upsert-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const FIXED_TS = "2026-05-07 12:00";

function makePaths(home: string): PathsService {
  const ns = normalizeNamespace("agent-workflow");
  return new PathsService(ns, home, home);
}

describe("project-md-upsert --init with --fuente / --main-branch", () => {
  const fs = new NodeFileSystem();
  let cwd: string;
  let env: FakeEnv;
  let paths: PathsService;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-pmu-fuentes-"));
    env = new FakeEnv(cwd);
    paths = makePaths(cwd);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("renders 1 fuente from --fuente alias:path:rama", async () => {
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/core | main |");
  });

  it("writes defaultBranches and merges them per role across calls", async () => {
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core", mainBranch: "main" }],
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
      lastActivity: FIXED_TS,
    });
    // Second call touches ONE role: the other two must survive (field merge).
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      defaultBranches: { qa: "release/qa" },
      lastActivity: FIXED_TS,
    });

    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("  - principal: main");
    expect(claude).toContain("  - desarrollo: development");
    expect(claude).toContain("  - qa: release/qa");
    expect(claude).not.toContain("  - qa: qa\n");
  });

  it("leaves the block without a defaults entry when none is given", async () => {
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("Ramas por defecto");
  });

  it("renders 2 fuentes with shared --main-branch fallback", async () => {
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

  it("removeAliases prunes a source from fuentes + working + qa branches", async () => {
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "/repo/core", mainBranch: "main" },
        { alias: "plugin", path: "/repo/plugin", mainBranch: "main" },
      ],
      workingBranches: { core: "feature/a", plugin: "feature/b" },
      qaBranches: { core: "desarrollo", plugin: "qa/plugin" },
      lastActivity: FIXED_TS,
    });
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      removeAliases: ["plugin"],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | /repo/core | main |");
    expect(claude).not.toContain("/repo/plugin");
    expect(claude).toContain("- core: feature/a");
    expect(claude).not.toContain("plugin: feature/b");
    expect(claude).toContain("  - core: desarrollo");
    expect(claude).not.toContain("qa/plugin");
  });

  it("removeAliases of the last source leaves an empty fuentes table", async () => {
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    const result = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      removeAliases: ["core"],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("/repo/core");
    expect(claude).toContain("Sin fuentes declaradas");
  });
});
