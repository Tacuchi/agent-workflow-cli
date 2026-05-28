import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHubInit } from "../../src/application/hub-init-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

class FakeEnv implements EnvPort {
  constructor(private readonly _cwd: string) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this._cwd;
  }
  cwd() {
    return this._cwd;
  }
}

function claudeDirs(workspace: string): string[] {
  const settings = JSON.parse(
    readFileSync(join(workspace, ".claude", "settings.local.json"), "utf-8"),
  );
  return settings.permissions.additionalDirectories;
}

describe("runHubInit", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "hub-init-svc-"));
    env = new FakeEnv(workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("siempre crea CLAUDE.md/AGENTS.md (mode=hub) + .claude/settings.local.json con paths", async () => {
    const result = await runHubInit(fs, env, paths, {
      proyecto: "Test workspace",
      fuentes: [
        { alias: "a", path: "/tmp/a-fake" },
        { alias: "b", path: "/tmp/b-fake" },
      ],
      workingBranches: { a: "dev", b: "dev" },
      workspace,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    // Visibilidad siempre, en settings.local.json (no settings.json).
    expect(existsSync(join(workspace, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(join(workspace, ".claude", "settings.json"))).toBe(false);
    expect(claudeDirs(workspace)).toEqual(expect.arrayContaining(["/tmp/a-fake", "/tmp/b-fake"]));
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).toContain("Mode: hub");
  });

  it("asegura .gitignore con los archivos de visibilidad", async () => {
    await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workingBranches: {},
      workspace,
    });
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".claude/settings.local.json");
    expect(gitignore).toContain(".codex/config.toml");
  });

  it("reconcile: al re-correr con una fuente removida, la detachea de settings.local.json", async () => {
    await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workingBranches: {},
      workspace,
    });
    // Re-init: b removida, c agregada.
    const second = await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "c", path: "/tmp/c" },
      ],
      workingBranches: {},
      workspace,
    });
    if ("error" in second) throw new Error("unexpected error");
    const dirs = claudeDirs(workspace);
    expect(dirs).toContain("/tmp/a");
    expect(dirs).toContain("/tmp/c");
    expect(dirs).not.toContain("/tmp/b");
    expect(second.detached_removed).toBeDefined();
  });

  it("--dry-run no escribe ningún archivo y devuelve preview", async () => {
    const result = await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workingBranches: {},
      workspace,
      dryRun: true,
    });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
    expect(result.project_md).toEqual({ dry_run_preview: { fuentes: 2, mode: "hub" } });
    expect(result.attach_multiroot).toMatchObject({
      dry_run_preview: { paths: ["/tmp/a", "/tmp/b"] },
    });
  });

  it("idempotencia: re-ejecutar deja attach con added=[] y already_present=2", async () => {
    await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workingBranches: {},
      workspace,
    });
    const second = await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workingBranches: {},
      workspace,
    });
    if ("error" in second) throw new Error("unexpected error");
    if ("dry_run_preview" in second.attach_multiroot) throw new Error("not preview");
    if ("skipped" in second.attach_multiroot) throw new Error("not skipped");
    if ("error" in second.attach_multiroot) throw new Error("not error");
    expect(second.attach_multiroot.claude).toMatchObject({
      already_present: ["/tmp/a", "/tmp/b"],
      written: false,
    });
  });

  it("rechaza si <2 fuentes", async () => {
    const result = await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [{ alias: "a", path: "/tmp/a" }],
      workingBranches: {},
      workspace,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toBe("insufficient_fuentes");
  });

  it("rechaza si --proyecto vacío", async () => {
    const result = await runHubInit(fs, env, paths, {
      proyecto: "",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workingBranches: {},
      workspace,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toBe("missing_proyecto");
  });

  it("regresión: --workspace ≠ env.cwd() persiste en workspace, no en cwd", async () => {
    const callerCwd = mkdtempSync(join(tmpdir(), "caller-cwd-"));
    const targetWorkspace = mkdtempSync(join(tmpdir(), "target-ws-"));
    const callerEnv = new FakeEnv(callerCwd);
    const callerPaths = new PathsService(normalizeNamespace("workflow"), callerCwd, callerCwd);
    try {
      const result = await runHubInit(fs, callerEnv, callerPaths, {
        proyecto: "Test",
        fuentes: [
          { alias: "a", path: "/tmp/a-iso" },
          { alias: "b", path: "/tmp/b-iso" },
        ],
        workingBranches: {},
        workspace: targetWorkspace,
      });
      if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
      expect(result.ok).toBe(true);
      expect(existsSync(join(targetWorkspace, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(targetWorkspace, ".claude", "settings.local.json"))).toBe(true);
      expect(existsSync(join(callerCwd, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(callerCwd, ".claude"))).toBe(false);
    } finally {
      rmSync(callerCwd, { recursive: true, force: true });
      rmSync(targetWorkspace, { recursive: true, force: true });
    }
  });

  it("rechaza si alias duplicado", async () => {
    const result = await runHubInit(fs, env, paths, {
      proyecto: "Test",
      fuentes: [
        { alias: "a", path: "/tmp/a" },
        { alias: "a", path: "/tmp/b" },
      ],
      workingBranches: {},
      workspace,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toBe("duplicate_alias");
  });
});
