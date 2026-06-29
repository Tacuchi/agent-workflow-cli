import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runWorkspaceInit } from "../../src/application/workspace-init-service.js";
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

const DOCS_FOLDERS = ["specs", "plans", "manuals", "scripts", "diagrams", "reports"];

describe("runWorkspaceInit", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ws-init-svc-"));
    env = new FakeEnv(workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("single source EXTERNA: scaffold + skills.toml + bloque SIN Mode + visibilidad", async () => {
    const result = await runWorkspaceInit(fs, env, paths, {
      proyecto: "Solo",
      sources: [{ alias: "app", path: "/tmp/app-fake" }],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.ok).toBe(true);
    expect(result.sources).toBe(1);

    // scaffold: .workflow/sessions + docs/*
    expect(existsSync(join(workspace, ".workflow", "sessions"))).toBe(true);
    for (const f of DOCS_FOLDERS) {
      expect(existsSync(join(workspace, "docs", f))).toBe(true);
      expect(existsSync(join(workspace, "docs", f, ".gitkeep"))).toBe(true);
    }
    // docs/tools NO se scaffoldea: lo crea on-demand la skill creating-tools (marketplace),
    // el workflow es indiferente a esa capacidad extraída.
    expect(existsSync(join(workspace, "docs", "tools"))).toBe(false);

    // skills.toml seeded
    expect(result.skills_toml).toBe("created");
    expect(existsSync(join(workspace, ".workflow", "skills.toml"))).toBe(true);
    const toml = readFileSync(join(workspace, ".workflow", "skills.toml"), "utf-8");
    expect(toml).toContain("[skills]");
    expect(toml).toContain('# ui-design = "ui-spec"');
    expect(toml).toContain('# overview = "workflow"');

    // block written, no Mode line, has the source
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("## Fuentes");
    expect(claude).toContain("app");
    expect(claude).not.toContain("Mode: hub");
    expect(claude).not.toMatch(/^Mode:/m);

    // fuente externa (la carpeta del workspace ≠ la fuente) → SÍ configura visibilidad
    expect(existsSync(join(workspace, ".claude", "settings.local.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(workspace, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions.additionalDirectories).toContain("/tmp/app-fake");
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".claude/settings.local.json");
    // Source-launch runtime artifacts are always gitignored.
    expect(gitignore).toContain(".workflow/processes.json");
    expect(gitignore).toContain(".workflow/launch/");
    expect(gitignore).toContain("docs/logs/");
  });

  it("runtime gitignore se agrega incluso para fuente única dentro del workspace", async () => {
    await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "self", path: workspace }],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".workflow/processes.json");
    expect(gitignore).toContain("docs/logs/");
  });

  it("fuente única DENTRO del workspace: omite visibilidad (la fuente ES el workspace)", async () => {
    const result = await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "self", path: workspace }],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.attach_multiroot).toEqual({ skipped: true, reason: "no_external_sources" });
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
  });

  it("detecta el stack desde la ruta de la fuente, no desde la carpeta del workspace", async () => {
    const source = mkdtempSync(join(tmpdir(), "ws-init-src-"));
    try {
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({ dependencies: { react: "^18" }, devDependencies: { typescript: "^5" } }),
      );
      const result = await runWorkspaceInit(fs, env, paths, {
        sources: [{ alias: "app", path: source }],
        workspace,
        lastActivity: "2026-01-01 00:00",
      });
      if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
      const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
      expect(claude).toContain("## Stack");
      expect(claude).toContain("Lenguaje: TypeScript");
      expect(claude).toContain("Framework: React");
      expect(claude).not.toContain("Stack sin detectar");
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("genera launch.json + run.sh/run.ps1 por source y scaffolda docs/logs", async () => {
    const source = mkdtempSync(join(tmpdir(), "ws-init-src-"));
    try {
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { typescript: "^5" } }),
      );
      const result = await runWorkspaceInit(fs, env, paths, {
        sources: [{ alias: "app", path: source }],
        workspace,
        lastActivity: "2026-01-01 00:00",
      });
      if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

      // docs/logs scaffolded (gitignored, no .gitkeep).
      expect(existsSync(join(workspace, "docs", "logs"))).toBe(true);

      // descriptor + per-OS scripts emitted under .workflow/launch/<alias>/
      const toolDir = join(workspace, ".workflow", "launch", "app");
      expect(existsSync(join(toolDir, "launch.json"))).toBe(true);
      expect(existsSync(join(toolDir, "run.sh"))).toBe(true);
      expect(existsSync(join(toolDir, "run.ps1"))).toBe(true);
      const desc = JSON.parse(readFileSync(join(toolDir, "launch.json"), "utf-8"));
      expect(desc.command).toBe("npm");
      expect(desc.args).toEqual(["run", "dev"]);

      expect(result.launch_artifacts.generated.map((g) => g.alias)).toEqual(["app"]);
      expect(result.launch_artifacts.generated[0]?.launchable).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("migra carpetas legacy docs/tools/<alias> de launch a .workflow/launch (preserva tools)", async () => {
    const source = mkdtempSync(join(tmpdir(), "ws-init-src-"));
    try {
      writeFileSync(join(source, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      // Legacy launch folder (generated marker) con run.sh editado + una tool no-launch.
      mkdirSync(join(workspace, "docs", "tools", "app"), { recursive: true });
      writeFileSync(
        join(workspace, "docs", "tools", "app", "launch.json"),
        JSON.stringify({ version: 1, source: "app", _generated: { sha256: "stale" } }),
      );
      writeFileSync(join(workspace, "docs", "tools", "app", "run.sh"), "echo legacy-edit\n");
      mkdirSync(join(workspace, "docs", "tools", "keepme"), { recursive: true });
      writeFileSync(join(workspace, "docs", "tools", "keepme", "README.md"), "# keepme tool\n");

      const result = await runWorkspaceInit(fs, env, paths, {
        sources: [{ alias: "app", path: source }],
        workspace,
        lastActivity: "2026-01-01 00:00",
      });
      if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

      // la carpeta legacy se reubica y se elimina
      expect(existsSync(join(workspace, "docs", "tools", "app"))).toBe(false);
      expect(existsSync(join(workspace, ".workflow", "launch", "app", "launch.json"))).toBe(true);
      // el run.sh editado (sin marker) sobrevive a la mudanza (no se regenera)
      expect(
        readFileSync(join(workspace, ".workflow", "launch", "app", "run.sh"), "utf-8"),
      ).toContain("legacy-edit");
      // una tool no-launch (README, sin launch.json) queda intacta
      expect(existsSync(join(workspace, "docs", "tools", "keepme", "README.md"))).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("qaBranches: renderiza la sección 'Ramas QA actuales' en el bloque", async () => {
    const result = await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "app", path: "/tmp/app-fake" }],
      workingBranches: { app: "feature/x" },
      qaBranches: { app: "desarrollo" },
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("- Ramas de trabajo actuales:");
    expect(claude).toContain("  - app: feature/x");
    expect(claude).toContain("- Ramas QA actuales:");
    expect(claude).toContain("  - app: desarrollo");
  });

  it("multi source: configura visibilidad multi-root + .gitignore", async () => {
    const result = await runWorkspaceInit(fs, env, paths, {
      proyecto: "Multi",
      sources: [
        { alias: "a", path: "/tmp/a-fake" },
        { alias: "b", path: "/tmp/b-fake" },
      ],
      workspace,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.ok).toBe(true);
    expect(result.sources).toBe(2);
    expect(existsSync(join(workspace, ".claude", "settings.local.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(workspace, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions.additionalDirectories).toEqual(
      expect.arrayContaining(["/tmp/a-fake", "/tmp/b-fake"]),
    );
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".claude/settings.local.json");
    expect(gitignore).toContain(".codex/config.toml");
  });

  it("proyecto por defecto = basename del workspace", async () => {
    const result = await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "app", path: "/tmp/app" }],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in result) throw new Error("unexpected error");
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain(join(workspace).split("/").pop() as string);
  });

  it("idempotente: re-correr no duplica scaffold y respeta skills.toml existente", async () => {
    await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "app", path: "/tmp/app" }],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    const second = await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "app", path: "/tmp/app" }],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in second) throw new Error("unexpected error");
    // second run: dirs already exist, skills.toml preserved
    expect(second.scaffold.created).toHaveLength(0);
    expect(second.scaffold.existing.length).toBeGreaterThan(0);
    expect(second.skills_toml).toBe("exists");
  });

  it("reconcile multi-source: re-correr con una fuente removida la detachea", async () => {
    await runWorkspaceInit(fs, env, paths, {
      sources: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workspace,
    });
    const second = await runWorkspaceInit(fs, env, paths, {
      sources: [
        { alias: "a", path: "/tmp/a" },
        { alias: "c", path: "/tmp/c" },
      ],
      workspace,
    });
    if ("error" in second) throw new Error("unexpected error");
    const settings = JSON.parse(
      readFileSync(join(workspace, ".claude", "settings.local.json"), "utf-8"),
    );
    const dirs = settings.permissions.additionalDirectories;
    expect(dirs).toContain("/tmp/a");
    expect(dirs).toContain("/tmp/c");
    expect(dirs).not.toContain("/tmp/b");
    expect(second.detached_removed).toBeDefined();
  });

  it("reconcile SIN --source: preserva las fuentes y la descripción existentes", async () => {
    await runWorkspaceInit(fs, env, paths, {
      proyecto: "Mi Proyecto",
      sources: [
        { alias: "app", path: "/tmp/app-fake" },
        { alias: "lib", path: "/tmp/lib-fake" },
      ],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    // Re-correr para reconciliar el schema, sin re-pasar fuentes ni descripción.
    const second = await runWorkspaceInit(fs, env, paths, {
      sources: [],
      workspace,
      lastActivity: "2026-01-02 00:00",
    });
    if ("error" in second) throw new Error(`unexpected error: ${second.error}`);
    expect(second.sources).toBe(2); // preservadas, no error no_sources
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("Mi Proyecto"); // descripción preservada (no basename)
    expect(claude).toContain("/tmp/app-fake"); // fuentes preservadas
    expect(claude).toContain("/tmp/lib-fake");
  });

  it("--dry-run no escribe nada y devuelve preview", async () => {
    const result = await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "app", path: "/tmp/app" }],
      workspace,
      dryRun: true,
    });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.dry_run).toBe(true);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(workspace, ".workflow"))).toBe(false);
    expect(existsSync(join(workspace, "docs"))).toBe(false);
    expect(result.scaffold.created.length).toBeGreaterThan(0);
  });

  it("--workspace ≠ env.cwd() escribe en workspace, no en cwd", async () => {
    const callerCwd = mkdtempSync(join(tmpdir(), "caller-cwd-"));
    const target = mkdtempSync(join(tmpdir(), "target-ws-"));
    const callerEnv = new FakeEnv(callerCwd);
    const callerPaths = new PathsService(normalizeNamespace("workflow"), callerCwd, callerCwd);
    try {
      const result = await runWorkspaceInit(fs, callerEnv, callerPaths, {
        sources: [{ alias: "app", path: "/tmp/app" }],
        workspace: target,
        lastActivity: "2026-01-01 00:00",
      });
      if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
      expect(existsSync(join(target, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(target, ".workflow", "skills.toml"))).toBe(true);
      expect(existsSync(join(target, "docs", "specs"))).toBe(true);
      expect(existsSync(join(callerCwd, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(callerCwd, ".workflow"))).toBe(false);
    } finally {
      rmSync(callerCwd, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("rechaza si 0 fuentes", async () => {
    const result = await runWorkspaceInit(fs, env, paths, { sources: [], workspace });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toBe("no_sources");
  });

  it("rechaza si alias duplicado", async () => {
    const result = await runWorkspaceInit(fs, env, paths, {
      sources: [
        { alias: "a", path: "/tmp/a" },
        { alias: "a", path: "/tmp/b" },
      ],
      workspace,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toBe("duplicate_alias");
  });
});
