import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type WorkspaceInitInput,
  pruneReleasedLock,
  runWorkspaceInit,
} from "../../src/application/workspace-init-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

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

  // Default happy-path arrange (one source + fixed timestamp); `over` layers
  // option deltas on top. Throws if init returns an error result, so callers
  // get the narrowed success type. The 2 error-expecting tests and the
  // custom-env test below call runWorkspaceInit directly instead.
  async function init(over: Partial<WorkspaceInitInput> = {}) {
    const result = await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "app", path: "/tmp/app" }],
      workspace,
      lastActivity: "2026-01-01 00:00",
      ...over,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    return result;
  }

  it("NO estampa rama principal cuando el usuario no la declara (la celda queda vacía)", async () => {
    // Estampar un literal aquí haría que el valor por-source ganase siempre al
    // default `principal` del workspace → el control de [Config] sería inerte,
    // y un re-init pisaría una celda dejada vacía a propósito.
    await init();
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| app | /tmp/app |  |");
    expect(claude).not.toMatch(/\| app \| \/tmp\/app \| \S+ \|/);
  });

  it("--main-branch explícito SÍ se escribe, y un re-init no pisa la celda vacía", async () => {
    await init({ mainBranch: "trunk" });
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toContain(
      "| app | /tmp/app | trunk |",
    );

    // Workspace nuevo: celda vacía, y el reconcile (sin --source) la preserva.
    rmSync(join(workspace, "CLAUDE.md"), { force: true });
    await init();
    await runWorkspaceInit(fs, env, paths, {
      sources: [],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    const after = readFileSync(join(workspace, "CLAUDE.md"), "utf8");
    expect(after).toContain("| app | /tmp/app |  |");
    expect(after).not.toContain("| app | /tmp/app | main |");
  });

  it("single source EXTERNA: scaffold + skills.toml + bloque SIN Mode + visibilidad", async () => {
    const result = await init({
      proyecto: "Solo",
      sources: [{ alias: "app", path: "/tmp/app-fake" }],
    });
    expect(result.ok).toBe(true);
    expect(result.sources).toBe(1);

    // MINIMAL scaffold: only .workflow/sessions (activation marker), no .gitkeep.
    expect(existsSync(join(workspace, ".workflow", "sessions"))).toBe(true);
    expect(existsSync(join(workspace, ".workflow", "sessions", ".gitkeep"))).toBe(false);
    // docs/* is NOT scaffolded: each category is born on demand via `aw next-number docs/<cat>`.
    for (const f of DOCS_FOLDERS) {
      expect(existsSync(join(workspace, "docs", f))).toBe(false);
    }
    expect(existsSync(join(workspace, "docs", "tools"))).toBe(false);

    // skills.toml seeded
    expect(result.skills_toml).toBe("created");
    expect(existsSync(join(workspace, ".workflow", "skills.toml"))).toBe(true);
    const toml = readFileSync(join(workspace, ".workflow", "skills.toml"), "utf-8");
    expect(toml).toContain("[skills]");
    expect(toml).toContain('# ui-design = "ui-spec"');
    expect(toml).toContain('# overview = "w"');
    // commented [compaction] opt-in section: adjacent pair, after the [skills] roles
    // (uncommenting both must land `mode` inside [compaction], never inside [skills])
    expect(toml).toContain('# [compaction]\n# mode = "confirm"');
    expect(toml.indexOf("# [compaction]")).toBeGreaterThan(toml.indexOf("[skills]"));

    // block written, no Mode line, has the source
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("## Fuentes");
    expect(claude).toContain("app");
    expect(claude).not.toContain("Mode: hub");
    expect(claude).not.toMatch(/^Mode:/m);

    // external source (workspace folder ≠ the source) → DOES configure visibility
    expect(existsSync(join(workspace, ".claude", "settings.local.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(workspace, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions.additionalDirectories).toContain("/tmp/app-fake");
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    // Visibility uses a pattern: also covers the .bak.<epoch> backups.
    expect(gitignore).toContain(".claude/settings.local.json*");
    expect(gitignore).toContain(".codex/config.toml*");
    // Full CLI-owned set: sessions + lock + runtime.
    expect(gitignore).toContain(".workflow/sessions/");
    expect(gitignore).toContain(".workflow/.lock");
    expect(gitignore).toContain(".workflow/processes.json");
    expect(gitignore).toContain(".workflow/launch/");
    expect(gitignore).toContain("docs/logs/");
  });

  it("runtime gitignore se agrega incluso para fuente única dentro del workspace", async () => {
    await init({ sources: [{ alias: "self", path: workspace }] });
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".workflow/processes.json");
    expect(gitignore).toContain("docs/logs/");
  });

  it("fuente única DENTRO del workspace: omite visibilidad (la fuente ES el workspace)", async () => {
    const result = await init({ sources: [{ alias: "self", path: workspace }] });
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
      await init({ sources: [{ alias: "app", path: source }] });
      const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
      expect(claude).toContain("## Stack");
      expect(claude).toContain("Lenguaje: TypeScript");
      expect(claude).toContain("Framework: React");
      expect(claude).not.toContain("Stack sin detectar");
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("NO pregenera launch artifacts ni docs/logs (nacen on-demand en el primer launch)", async () => {
    const source = mkdtempSync(join(tmpdir(), "ws-init-src-"));
    try {
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { typescript: "^5" } }),
      );
      await init({ sources: [{ alias: "app", path: source }] });

      expect(existsSync(join(workspace, "docs", "logs"))).toBe(false);
      expect(existsSync(join(workspace, ".workflow", "launch"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("migra carpetas legacy docs/tools/<alias> de launch a .workflow/launch (preserva tools)", async () => {
    const source = mkdtempSync(join(tmpdir(), "ws-init-src-"));
    try {
      writeFileSync(join(source, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      // Legacy launch folder (generated marker) with an edited run.sh + one non-launch tool.
      mkdirSync(join(workspace, "docs", "tools", "app"), { recursive: true });
      writeFileSync(
        join(workspace, "docs", "tools", "app", "launch.json"),
        JSON.stringify({ version: 1, source: "app", _generated: { sha256: "stale" } }),
      );
      writeFileSync(join(workspace, "docs", "tools", "app", "run.sh"), "echo legacy-edit\n");
      mkdirSync(join(workspace, "docs", "tools", "keepme"), { recursive: true });
      writeFileSync(join(workspace, "docs", "tools", "keepme", "README.md"), "# keepme tool\n");

      await init({ sources: [{ alias: "app", path: source }] });

      // the legacy folder is relocated and removed
      expect(existsSync(join(workspace, "docs", "tools", "app"))).toBe(false);
      expect(existsSync(join(workspace, ".workflow", "launch", "app", "launch.json"))).toBe(true);
      // the edited run.sh (no marker) survives the move (not regenerated)
      expect(
        readFileSync(join(workspace, ".workflow", "launch", "app", "run.sh"), "utf-8"),
      ).toContain("legacy-edit");
      // a non-launch tool (README, no launch.json) stays intact
      expect(existsSync(join(workspace, "docs", "tools", "keepme", "README.md"))).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("qaBranches: renderiza la sección 'Ramas QA actuales' en el bloque", async () => {
    await init({
      sources: [{ alias: "app", path: "/tmp/app-fake" }],
      workingBranches: { app: "feature/x" },
      qaBranches: { app: "desarrollo" },
    });
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("- Ramas de trabajo actuales:");
    expect(claude).toContain("  - app: feature/x");
    expect(claude).toContain("- Ramas QA actuales:");
    expect(claude).toContain("  - app: desarrollo");
  });

  it("multi source: configura visibilidad multi-root + .gitignore", async () => {
    const result = await init({
      proyecto: "Multi",
      sources: [
        { alias: "a", path: "/tmp/a-fake" },
        { alias: "b", path: "/tmp/b-fake" },
      ],
    });
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
    await init();
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain(join(workspace).split("/").pop() as string);
  });

  it("idempotente: re-correr no duplica scaffold y respeta skills.toml existente", async () => {
    await init();
    const second = await init();
    // second run: dirs already exist, skills.toml preserved
    expect(second.scaffold.created).toHaveLength(0);
    expect(second.scaffold.existing.length).toBeGreaterThan(0);
    expect(second.skills_toml).toBe("exists");
  });

  it("reconcile multi-source: re-correr con una fuente removida la detachea", async () => {
    await init({
      sources: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
    });
    const second = await init({
      sources: [
        { alias: "a", path: "/tmp/a" },
        { alias: "c", path: "/tmp/c" },
      ],
    });
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
    await init({
      proyecto: "Mi Proyecto",
      sources: [
        { alias: "app", path: "/tmp/app-fake" },
        { alias: "lib", path: "/tmp/lib-fake" },
      ],
    });
    // Re-run to reconcile the schema, without re-passing sources or description.
    const second = await init({ sources: [], lastActivity: "2026-01-02 00:00" });
    expect(second.sources).toBe(2); // preserved, no no_sources error
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("Mi Proyecto"); // description preserved (not the basename)
    expect(claude).toContain("/tmp/app-fake"); // sources preserved
    expect(claude).toContain("/tmp/lib-fake");
  });

  it("--dry-run no escribe nada y devuelve preview", async () => {
    const result = await init({ dryRun: true });
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
      expect(existsSync(join(target, ".workflow", "sessions"))).toBe(true);
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

  it("prune reconcile: poda .gitkeep-only, docs/logs vacía, sessions/.gitkeep y .lock liberado; preserva contenido", async () => {
    // Workspace from the upfront-scaffold era: empty taxonomy with .gitkeep + one folder with content.
    for (const f of ["manuals", "diagrams", "scripts"]) {
      mkdirSync(join(workspace, "docs", f), { recursive: true });
      writeFileSync(join(workspace, "docs", f, ".gitkeep"), "");
    }
    mkdirSync(join(workspace, "docs", "specs"), { recursive: true });
    writeFileSync(join(workspace, "docs", "specs", ".gitkeep"), "");
    writeFileSync(join(workspace, "docs", "specs", "001-spec.md"), "# spec");
    mkdirSync(join(workspace, "docs", "logs"), { recursive: true });
    mkdirSync(join(workspace, ".workflow", "sessions"), { recursive: true });
    writeFileSync(join(workspace, ".workflow", "sessions", ".gitkeep"), "");
    writeFileSync(join(workspace, ".workflow", ".lock"), ""); // released marker (0 bytes)

    const result = await init();

    // .gitkeep-only → folder pruned.
    for (const f of ["manuals", "diagrams", "scripts"]) {
      expect(existsSync(join(workspace, "docs", f))).toBe(false);
    }
    // With content → stays, but without the stray .gitkeep.
    expect(existsSync(join(workspace, "docs", "specs", "001-spec.md"))).toBe(true);
    expect(existsSync(join(workspace, "docs", "specs", ".gitkeep"))).toBe(false);
    // empty docs/logs + sessions/.gitkeep + released .lock → pruned.
    expect(existsSync(join(workspace, "docs", "logs"))).toBe(false);
    expect(existsSync(join(workspace, ".workflow", "sessions", ".gitkeep"))).toBe(false);
    expect(existsSync(join(workspace, ".workflow", ".lock"))).toBe(false);
    expect(result.scaffold.pruned.length).toBeGreaterThanOrEqual(6);
  });

  it("prune reconcile: NO toca un .lock vigente (pid vivo, no expirado)", async () => {
    mkdirSync(join(workspace, ".workflow"), { recursive: true });
    // Genuinely held lock: current {pid, ISO ts} (a numeric ts parses to null = corrupt, stealable).
    writeFileSync(
      join(workspace, ".workflow", ".lock"),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    await init();
    // The block upsert fails because the lock is held (by someone else) and init does NOT delete the live lock.
    expect(existsSync(join(workspace, ".workflow", ".lock"))).toBe(true);
  });

  it("gitignore block-aware: entradas nuevas se insertan bajo el header existente, sin duplicarlo", async () => {
    // .gitignore of a workspace initialized by an older CLI (incomplete set).
    writeFileSync(
      join(workspace, ".gitignore"),
      [
        "node_modules/",
        "",
        "# agent-workflow runtime (machine-specific — do not commit)",
        ".workflow/processes.json",
        "docs/logs/",
        "",
        "# user section",
        "*.tmp",
        "",
      ].join("\n"),
    );
    await init();
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    const headerCount = gitignore
      .split("\n")
      .filter(
        (l) => l.trim() === "# agent-workflow runtime (machine-specific — do not commit)",
      ).length;
    expect(headerCount).toBe(1);
    // The missing entries landed inside the header's block (before "# user section").
    const runtimeBlock = gitignore.split("# user section")[0] as string;
    expect(runtimeBlock).toContain(".workflow/sessions/");
    expect(runtimeBlock).toContain(".workflow/.lock");
    expect(runtimeBlock).toContain(".workflow/launch/");
    // The user's entries stay intact.
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("*.tmp");
  });

  it("gitignore: líneas hand-authored existentes no se duplican (dedupe global por línea)", async () => {
    writeFileSync(
      join(workspace, ".gitignore"),
      [".workflow/sessions/", ".workflow/.lock", ""].join("\n"),
    );
    await init();
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    const sessionsCount = gitignore
      .split("\n")
      .filter((l) => l.trim() === ".workflow/sessions/").length;
    expect(sessionsCount).toBe(1);
  });

  it("gitignore CRLF: el merge bajo header preserva el EOL (no reescribe el archivo a LF)", async () => {
    writeFileSync(
      join(workspace, ".gitignore"),
      [
        "node_modules/",
        "",
        "# agent-workflow runtime (machine-specific — do not commit)",
        ".workflow/processes.json",
        "",
      ].join("\r\n"),
    );
    await init();
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
    expect(gitignore).toContain("\r\n");
    expect(gitignore).toContain(".workflow/sessions/");
    // The user's line keeps its original line terminator.
    expect(gitignore).toContain("node_modules/\r\n");
  });

  it("--dry-run PREVISUALIZA el prune (read-only): reporta qué borraría sin borrar nada", async () => {
    mkdirSync(join(workspace, "docs", "manuals"), { recursive: true });
    writeFileSync(join(workspace, "docs", "manuals", ".gitkeep"), "");
    mkdirSync(join(workspace, "docs", "logs"), { recursive: true });
    const result = await init({ dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.scaffold.pruned).toContain(join(workspace, "docs", "manuals"));
    expect(result.scaffold.pruned).toContain(join(workspace, "docs", "logs"));
    // Nothing was actually deleted.
    expect(existsSync(join(workspace, "docs", "manuals", ".gitkeep"))).toBe(true);
    expect(existsSync(join(workspace, "docs", "logs"))).toBe(true);
  });

  it("pruneReleasedLock directo: vivo intocable · liberado y expirado removibles (guard real)", async () => {
    const lockPath = join(workspace, ".workflow", ".lock");
    mkdirSync(join(workspace, ".workflow"), { recursive: true });
    const wsPaths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);

    // Live (real pid + current ISO ts) → never touched.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    expect(await pruneReleasedLock(fs, wsPaths)).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);

    // Expired (old ts) → removable.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: "2020-01-01T00:00:00.000Z" }));
    expect(await pruneReleasedLock(fs, wsPaths)).toEqual([lockPath]);
    expect(existsSync(lockPath)).toBe(false);

    // Released marker (empty) → removable; with apply=false it only detects.
    writeFileSync(lockPath, "");
    expect(await pruneReleasedLock(fs, wsPaths, false)).toEqual([lockPath]);
    expect(existsSync(lockPath)).toBe(true);
    expect(await pruneReleasedLock(fs, wsPaths)).toEqual([lockPath]);
    expect(existsSync(lockPath)).toBe(false);
  });
});
