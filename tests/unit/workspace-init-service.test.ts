import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  DOCS_FOLDERS,
  type WorkspaceInitInput,
  pruneReleasedLock,
  runWorkspaceInit,
} from "../../src/application/workspace-init-service.js";
import { workspaceInitCommand } from "../../src/cli/commands/workspace-init.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

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

    // Workspace nuevo: celda vacía; la reconciliación declarada conserva la
    // fuente y no inventa una rama principal.
    rmSync(join(workspace, "CLAUDE.md"), { force: true });
    await init();
    await runWorkspaceInit(fs, env, paths, {
      sources: [{ alias: "app", path: "/tmp/app" }],
      workspace,
      lastActivity: "2026-01-01 00:00",
    });
    const after = readFileSync(join(workspace, "CLAUDE.md"), "utf8");
    expect(after).toContain("| app | /tmp/app |  |");
    expect(after).not.toContain("| app | /tmp/app | main |");
  });

  it("single source EXTERNA: runtime + bloque SIN Mode + visibilidad, sin template de skills", async () => {
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

    expect(result.skills_toml).toBe("skipped");
    expect(existsSync(join(workspace, ".workflow", "skills.toml"))).toBe(false);

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
    // Runtime ignores are added only when this directory belongs to Git.
    expect(gitignore).not.toContain(".workflow/sessions/");
  });

  it("runtime gitignore se agrega para una raíz Workline que pertenece a Git", async () => {
    mkdirSync(join(workspace, ".git"));
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

  it("configurar fuentes no migra ni crea launch artifacts legacy", async () => {
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

      // Source configuration owns metadata, not launch migration. Existing
      // artifacts are preserved exactly until an explicit launch action owns
      // them.
      expect(existsSync(join(workspace, "docs", "tools", "app", "launch.json"))).toBe(true);
      expect(readFileSync(join(workspace, "docs", "tools", "app", "run.sh"), "utf-8")).toContain(
        "legacy-edit",
      );
      expect(existsSync(join(workspace, ".workflow", "launch", "app"))).toBe(false);
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

  it("idempotente: re-correr no duplica el runtime ni crea skills.toml vacío", async () => {
    await init();
    const second = await init();
    // second run: marker already exists; no empty skill override is seeded.
    expect(second.scaffold.created).toHaveLength(0);
    expect(second.scaffold.existing.length).toBeGreaterThan(0);
    expect(second.skills_toml).toBe("skipped");
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

  it("sin fuentes no reconcilia metadata: materializa solamente y rechaza opciones de configuración", async () => {
    await init({
      proyecto: "Mi Proyecto",
      sources: [
        { alias: "app", path: "/tmp/app-fake" },
        { alias: "lib", path: "/tmp/lib-fake" },
      ],
    });
    const before = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    const second = await runWorkspaceInit(fs, env, paths, {
      sources: [],
      workspace,
      lastActivity: "2026-01-02 00:00",
    });
    expect(second).toMatchObject({ error: "no_sources" });
    const claude = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(claude).toBe(before);
    expect(claude).toContain("Mi Proyecto");
    expect(claude).toContain("/tmp/app-fake");
    expect(claude).toContain("/tmp/lib-fake");
  });

  it("reconcile sin una fuente: no deja su rama de trabajo ni la de QA huérfanas", async () => {
    await init({
      sources: [
        { alias: "a", path: "/tmp/a" },
        { alias: "b", path: "/tmp/b" },
      ],
      workingBranches: { a: "feature/a", b: "feature/b" },
      qaBranches: { a: "desarrollo", b: "qa/b" },
    });

    const second = await init({ sources: [{ alias: "a", path: "/tmp/a" }] });

    // Ni en el bloque (los dos archivos) ni en el JSON que devuelve el comando.
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const text = readFileSync(join(workspace, file), "utf-8");
      expect(text).toContain("  - a: feature/a");
      expect(text).not.toContain("feature/b");
      expect(text).not.toContain("qa/b");
    }
    const projectMd = second.project_md;
    if ("error" in projectMd) throw new Error(projectMd.error);
    expect(projectMd.working_branches).toEqual({ a: "feature/a" });
    expect(projectMd.qa_branches).toEqual({ a: "desarrollo" });
    expect(projectMd.dropped_lines).toEqual(["  - b: feature/b", "  - b: qa/b"]);
  });

  it("--proyecto sobre un workspace descrito: renombra y PRESERVA la descripción", async () => {
    await init({ proyecto: "Nombre viejo" });
    const claude = join(workspace, "CLAUDE.md");
    writeFileSync(
      claude,
      readFileSync(claude, "utf-8").replace(
        "Nombre viejo",
        "Nombre viejo\n\nEste workspace coordina dos repos.\n\n- Regla: nunca pushear desde acá.",
      ),
    );

    await init({ proyecto: "Nombre nuevo" });

    const after = readFileSync(claude, "utf-8");
    expect(after).toContain("Nombre nuevo");
    expect(after).not.toContain("Nombre viejo");
    expect(after).toContain("Este workspace coordina dos repos.");
    expect(after).toContain("- Regla: nunca pushear desde acá.");
  });

  it("una nota humana en el bloque sobrevive al reconcile y la 2a corrida no cambia nada", async () => {
    await init({ workingBranches: { app: "feature/x" } });
    const nota = "- Nota: la ruta de app apunta a mi clon local";
    const claude = join(workspace, "CLAUDE.md");
    writeFileSync(
      claude,
      readFileSync(claude, "utf-8").replace(
        "- Ramas de trabajo actuales:",
        `${nota}\n- Ramas de trabajo actuales:`,
      ),
    );

    await init();
    const first = readFileSync(claude, "utf-8");
    await init();
    const second = readFileSync(claude, "utf-8");

    expect(first).toContain(`${nota}\n- Ramas de trabajo actuales:`);
    expect(first).not.toContain(`  ${nota}`);
    expect(second).toBe(first);
  });

  it("--dry-run no escribe nada y devuelve preview", async () => {
    const result = await init({ dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(workspace, ".workflow"))).toBe(false);
    expect(existsSync(join(workspace, "docs"))).toBe(false);
    expect(result.scaffold.created.length).toBeGreaterThan(0);
  });

  it("--dry-run deriva el informe del FS: distingue un workspace virgen de uno inicializado", async () => {
    const sessionsDir = join(workspace, ".workflow", "sessions");

    const virgin = await init({ dryRun: true });
    expect(virgin.scaffold.created).toEqual([sessionsDir]);
    expect(virgin.scaffold.existing).toEqual([]);
    expect(virgin.skills_toml).toBe("skipped");
    const virginMd = virgin.project_md;
    if ("error" in virginMd) throw new Error(virginMd.error);
    expect(virginMd.results?.map((r) => r.action)).toEqual(["created", "created"]);

    await init();
    const initialized = await init({ dryRun: true });
    expect(initialized.scaffold.created).toEqual([]);
    expect(initialized.scaffold.existing).toEqual([sessionsDir]);
    expect(initialized.skills_toml).toBe("skipped");
    const initializedMd = initialized.project_md;
    if ("error" in initializedMd) throw new Error(initializedMd.error);
    // Mismo input → el bloque ya está escrito: la vista previa no lo llama creación.
    expect(initializedMd.results?.map((r) => r.action)).toEqual(["unchanged", "unchanged"]);
  });

  it("--dry-run anuncia 'updated' cuando el bloque existe pero cambiaría", async () => {
    await init();
    const preview = await init({ dryRun: true, proyecto: "Otro nombre" });
    const projectMd = preview.project_md;
    if ("error" in projectMd) throw new Error(projectMd.error);
    expect(projectMd.results?.map((r) => r.action)).toEqual(["updated", "updated"]);
    // Sigue siendo una vista previa: el nombre no llegó al disco.
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).not.toContain("Otro nombre");
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
      expect(existsSync(join(target, ".workflow", "skills.toml"))).toBe(false);
      expect(existsSync(join(target, ".workflow", "sessions"))).toBe(true);
      expect(existsSync(join(callerCwd, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(callerCwd, ".workflow"))).toBe(false);
    } finally {
      rmSync(callerCwd, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("normaliza una fuente relativa contra la raíz Workline resuelta, no contra el cwd del invocador", async () => {
    const source = join(workspace, "repo");
    const nestedCwd = join(workspace, "nested", "caller");
    mkdirSync(source, { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });
    const nestedEnv = new FakeEnv(workspace, nestedCwd);

    const result = await runWorkspaceInit(fs, nestedEnv, paths, {
      sources: [{ alias: "app", path: "repo" }],
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).toContain(`| app | ${source} |  |`);
    expect(result.attach_multiroot).toEqual({ skipped: true, reason: "no_external_sources" });
    expect(existsSync(join(nestedCwd, "repo"))).toBe(false);
  });

  it("sin fuentes sólo materializa el runtime", async () => {
    const result = await runWorkspaceInit(fs, env, paths, { sources: [], workspace });
    if ("error" in result) throw new Error(result.error);
    expect(result.sources).toBe(0);
    expect(result.project_md).toEqual({ skipped: true, reason: "materialization_only" });
    expect(existsSync(join(workspace, ".workflow", "sessions"))).toBe(true);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
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

  it("configurar fuentes preserva scaffold legacy; no poda docs, sesiones ni locks", async () => {
    // Workspace from the upfront-scaffold era: empty taxonomy with .gitkeep + one folder with content.
    for (const f of ["manuals", "diagrams", "scripts", "designs"]) {
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

    // The materialization/configuration split is non-destructive: legacy
    // folders remain until an explicit migration owns their removal.
    for (const f of ["manuals", "diagrams", "scripts", "designs"]) {
      expect(existsSync(join(workspace, "docs", f, ".gitkeep"))).toBe(true);
    }
    expect(existsSync(join(workspace, "docs", "specs", "001-spec.md"))).toBe(true);
    expect(existsSync(join(workspace, "docs", "specs", ".gitkeep"))).toBe(true);
    expect(existsSync(join(workspace, "docs", "logs"))).toBe(true);
    expect(existsSync(join(workspace, ".workflow", "sessions", ".gitkeep"))).toBe(true);
    expect(existsSync(join(workspace, ".workflow", ".lock"))).toBe(true);
    expect(result.scaffold.pruned).toEqual([]);
  });

  it("prune reconcile: NO toca un .lock vigente (pid vivo, no expirado)", async () => {
    mkdirSync(join(workspace, ".workflow", "sessions"), { recursive: true });
    // Genuinely held lock: current {pid, ISO ts} (a numeric ts parses to null = corrupt, stealable).
    writeFileSync(
      join(workspace, ".workflow", ".lock"),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    const result = await init();
    // The block upsert fails because the lock is held (by someone else) and init does NOT delete the live lock.
    expect(result.ok).toBe(false);
    expect(existsSync(join(workspace, ".workflow", ".lock"))).toBe(true);
  });

  it("gitignore block-aware: entradas nuevas se insertan bajo el header existente, sin duplicarlo", async () => {
    mkdirSync(join(workspace, ".git"));
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
    mkdirSync(join(workspace, ".git"));
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
    mkdirSync(join(workspace, ".git"));
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

  it("--dry-run no propone poda implícita y conserva el scaffold legacy", async () => {
    mkdirSync(join(workspace, "docs", "manuals"), { recursive: true });
    writeFileSync(join(workspace, "docs", "manuals", ".gitkeep"), "");
    mkdirSync(join(workspace, "docs", "logs"), { recursive: true });
    const result = await init({ dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.scaffold.pruned).toEqual([]);
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

describe("lo que la reescritura no pudo conservar llega al humano", () => {
  // Declararlo sólo en un campo del JSON no es declararlo: `workspace-init`
  // tiene proyección humana, así que en el modo por defecto el JSON no se
  // imprime y la pérdida se la comía la superficie que la persona realmente lee.
  const humanOf = (data: unknown, detail: boolean): string =>
    workspaceInitCommand.renderHuman?.(
      { ok: true, data, exitCode: 0 } as never,
      { detail } as never,
    ) ?? "";

  const withDropped = {
    ok: true,
    dry_run: false,
    workspace: "/w",
    sources: 1,
    skills_toml: "exists",
    scaffold: {},
    attach_multiroot: {},
    project_md: { dropped_lines: ["  - b: feature/b"] },
  };

  it("las nombra sin --detail, que es el modo por defecto", () => {
    const text = humanOf(withDropped, false);
    expect(text).toContain("- b: feature/b");
    expect(text).toMatch(/retiraron 1 línea/);
  });

  it("y no inventa la sección cuando no se retiró nada", () => {
    const text = humanOf({ ...withDropped, project_md: {} }, false);
    expect(text).not.toMatch(/retiraron/);
  });
});
