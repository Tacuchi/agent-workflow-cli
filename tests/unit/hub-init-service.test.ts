import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import {
  DOCS_FOLDERS,
  type HubInitInput,
  pruneReleasedLock,
  runHubInit,
} from "../../src/application/hub-init-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { hubInitCommand } from "../../src/cli/commands/hub-init.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("runWorkspaceInit", () => {
  let hub: string;
  let sourceRoot: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    hub = mkdtempSync(join(tmpdir(), "ws-init-svc-"));
    sourceRoot = mkdtempSync(join(tmpdir(), "ws-init-source-"));
    for (const name of ["app", "app-fake", "lib-fake", "a", "b", "c"])
      mkdirSync(join(sourceRoot, name));
    env = new FakeEnv(hub);
    paths = new PathsService(normalizeNamespace("workflow"), hub, hub);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(hub, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });
  const source = (name: string) => join(sourceRoot, name);

  // Default happy-path arrange (one source + fixed timestamp); `over` layers
  // option deltas on top. Throws if init returns an error result, so callers
  // get the narrowed success type. The 2 error-expecting tests and the
  // custom-env test below call runHubInit directly instead.
  async function init(over: Partial<HubInitInput> = {}) {
    const result = await runHubInit(fs, env, paths, {
      sources: [{ alias: "app", path: source("app") }],
      hub,
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
    const claude = readFileSync(join(hub, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| app | (local) |  |");
    expect(claude).not.toMatch(/\| app \| \(local\) \| \S+ \|/);
  });

  it("--main-branch explícito SÍ se escribe, y un re-init conserva la rama desde el espejo restante", async () => {
    await init({ mainBranch: "trunk" });
    expect(readFileSync(join(hub, "CLAUDE.md"), "utf8")).toContain("| app | (local) | trunk |");

    // La otra copia del bloque todavía declara trunk: reescribir no la pierde.
    rmSync(join(hub, "CLAUDE.md"), { force: true });
    await init();
    await runHubInit(fs, env, paths, {
      sources: [{ alias: "app", path: source("app") }],
      hub,
      lastActivity: "2026-01-01 00:00",
    });
    const after = readFileSync(join(hub, "CLAUDE.md"), "utf8");
    expect(after).toContain("| app | (local) | trunk |");
    expect(after).not.toContain("| app | (local) | main |");
  });

  it("single source EXTERNA: runtime + bloque SIN Mode + visibilidad, sin template de skills", async () => {
    const result = await init({
      proyecto: "Solo",
      sources: [{ alias: "app", path: source("app-fake") }],
    });
    expect(result.ok).toBe(true);
    expect(result.sources).toBe(1);

    // MINIMAL scaffold: only .workflow/sessions (activation marker), no .gitkeep.
    expect(existsSync(join(hub, ".workflow", "sessions"))).toBe(true);
    expect(existsSync(join(hub, ".workflow", "sessions", ".gitkeep"))).toBe(false);
    // docs/* is NOT scaffolded: each category is born on demand via `aw next-number docs/<cat>`.
    for (const f of DOCS_FOLDERS) {
      expect(existsSync(join(hub, "docs", f))).toBe(false);
    }
    expect(existsSync(join(hub, "docs", "tools"))).toBe(false);

    expect(result.skills_toml).toBe("skipped");
    expect(existsSync(join(hub, ".workflow", "skills.toml"))).toBe(false);

    // block written, no Mode line, has the source
    const claude = readFileSync(join(hub, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("## Fuentes");
    expect(claude).toContain("app");
    expect(claude).not.toContain("Mode: hub");
    expect(claude).not.toMatch(/^Mode:/m);

    // external source (workspace folder ≠ the source) → DOES configure visibility
    expect(existsSync(join(hub, ".claude", "settings.local.json"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(hub, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.additionalDirectories).toContain(source("app-fake"));
    const gitignore = readFileSync(join(hub, ".gitignore"), "utf-8");
    // Visibility uses a pattern: also covers the .bak.<epoch> backups.
    expect(gitignore).toContain(".claude/settings.local.json*");
    expect(gitignore).toContain(".codex/config.toml*");
    // Runtime ignores are added only when this directory belongs to Git.
    expect(gitignore).not.toContain(".workflow/sessions/");
  });

  it("runtime gitignore se agrega para una raíz Workline que pertenece a Git", async () => {
    mkdirSync(join(hub, ".git"));
    await init({ sources: [{ alias: "self", path: hub }] });
    const gitignore = readFileSync(join(hub, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".workflow/processes.json");
    expect(gitignore).toContain("docs/logs/");
  });

  it("reinstala la política en un workspace existente y --untrack sólo desindexa lo propio", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: hub, encoding: "utf8" });
    git("init", "--quiet", "--initial-branch=main");
    mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
    writeFileSync(join(hub, ".workflow", "processes.json"), "[]\n");
    writeFileSync(join(hub, ".workflow", "sessions", "saved.txt"), "sesión\n");
    writeFileSync(join(hub, "keep.txt"), "quedate\n");
    git("add", ".workflow/processes.json", ".workflow/sessions/saved.txt", "keep.txt");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "base");
    const process = new NodeProcess();
    const preview = await runHubInit(fs, env, paths, { sources: [], dryRun: true }, process);
    if ("error" in preview) throw new Error(preview.error);
    expect(preview.untrack?.paths).toEqual([
      ".workflow/processes.json",
      ".workflow/sessions/saved.txt",
    ]);
    expect(existsSync(join(hub, ".gitignore"))).toBe(false);
    const installed = await runHubInit(fs, env, paths, { sources: [] }, process);
    if ("error" in installed) throw new Error(installed.error);
    expect(installed.materialization.effects).toContainEqual({
      kind: "gitignore",
      path: join(hub, ".gitignore"),
      status: "created",
    });
    expect(readFileSync(join(hub, ".gitignore"), "utf8")).not.toContain(".workflow/archive/");
    expect(git("ls-files")).toContain(".workflow/processes.json");
    const applied = await runHubInit(fs, env, paths, { sources: [], untrack: true }, process);
    if ("error" in applied) throw new Error(applied.error);
    expect(applied.untrack?.paths).toEqual(preview.untrack?.paths);
    expect(git("ls-files")).toBe("keep.txt\n");
    expect(readFileSync(join(hub, ".workflow", "processes.json"), "utf8")).toBe("[]\n");
    expect(
      await runHubInit(fs, env, paths, { sources: [], untrack: true }, process),
    ).toHaveProperty("untrack.paths", []);
  });

  it("fuente única DENTRO del workspace: omite visibilidad (la fuente ES el workspace)", async () => {
    const result = await init({ sources: [{ alias: "self", path: hub }] });
    expect(result.attach_multiroot).toEqual({ skipped: true, reason: "no_external_sources" });
    expect(existsSync(join(hub, ".claude"))).toBe(false);
  });

  it("detecta el stack desde la ruta de la fuente, no desde la carpeta del workspace", async () => {
    const source = mkdtempSync(join(tmpdir(), "ws-init-src-"));
    try {
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({ dependencies: { react: "^18" }, devDependencies: { typescript: "^5" } }),
      );
      await init({ sources: [{ alias: "app", path: source }] });
      const claude = readFileSync(join(hub, "CLAUDE.md"), "utf-8");
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

      expect(existsSync(join(hub, "docs", "logs"))).toBe(false);
      expect(existsSync(join(hub, ".workflow", "launch"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("configurar fuentes no migra ni crea launch artifacts legacy", async () => {
    const source = mkdtempSync(join(tmpdir(), "ws-init-src-"));
    try {
      writeFileSync(join(source, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      // Legacy launch folder (generated marker) with an edited run.sh + one non-launch tool.
      mkdirSync(join(hub, "docs", "tools", "app"), { recursive: true });
      writeFileSync(
        join(hub, "docs", "tools", "app", "launch.json"),
        JSON.stringify({ version: 1, source: "app", _generated: { sha256: "stale" } }),
      );
      writeFileSync(join(hub, "docs", "tools", "app", "run.sh"), "echo legacy-edit\n");
      mkdirSync(join(hub, "docs", "tools", "keepme"), { recursive: true });
      writeFileSync(join(hub, "docs", "tools", "keepme", "README.md"), "# keepme tool\n");

      await init({ sources: [{ alias: "app", path: source }] });

      // Source configuration owns metadata, not launch migration. Existing
      // artifacts are preserved exactly until an explicit launch action owns
      // them.
      expect(existsSync(join(hub, "docs", "tools", "app", "launch.json"))).toBe(true);
      expect(readFileSync(join(hub, "docs", "tools", "app", "run.sh"), "utf-8")).toContain(
        "legacy-edit",
      );
      expect(existsSync(join(hub, ".workflow", "launch", "app"))).toBe(false);
      expect(existsSync(join(hub, "docs", "tools", "keepme", "README.md"))).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("qaBranches: renderiza la sección 'Ramas QA actuales' en el bloque", async () => {
    await init({
      sources: [{ alias: "app", path: source("app-fake") }],
      workingBranches: { app: "feature/x" },
      qaBranches: { app: "desarrollo" },
    });
    const claude = readFileSync(join(hub, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("- Ramas de trabajo actuales:");
    expect(claude).toContain("  - app: feature/x");
    expect(claude).toContain("- Ramas QA actuales:");
    expect(claude).toContain("  - app: desarrollo");
  });

  it("multi source: configura visibilidad multi-root + .gitignore", async () => {
    const result = await init({
      proyecto: "Multi",
      sources: [
        { alias: "a", path: source("a") },
        { alias: "b", path: source("b") },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.sources).toBe(2);
    expect(existsSync(join(hub, ".claude", "settings.local.json"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(hub, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.additionalDirectories).toEqual(
      expect.arrayContaining([source("a"), source("b")]),
    );
    const gitignore = readFileSync(join(hub, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".claude/settings.local.json");
    expect(gitignore).toContain(".codex/config.toml");
  });

  it("proyecto por defecto = basename del workspace", async () => {
    await init();
    const claude = readFileSync(join(hub, "CLAUDE.md"), "utf-8");
    expect(claude).toContain(join(hub).split("/").pop() as string);
  });

  it("idempotente: re-correr no duplica el runtime ni crea skills.toml vacío", async () => {
    await init();
    const second = await init();
    // second run: marker already exists; no empty skill override is seeded.
    expect(second.scaffold.created).toHaveLength(0);
    expect(second.scaffold.existing.length).toBeGreaterThan(0);
    expect(second.skills_toml).toBe("skipped");
  });

  it("reconcile multi-source: re-correr conserva una fuente omitida y vincula la nueva", async () => {
    await init({
      sources: [
        { alias: "a", path: source("a") },
        { alias: "b", path: source("b") },
      ],
    });
    const second = await init({
      sources: [
        { alias: "a", path: source("a") },
        { alias: "c", path: source("c") },
      ],
    });
    const settings = JSON.parse(readFileSync(join(hub, ".claude", "settings.local.json"), "utf-8"));
    const dirs = settings.permissions.additionalDirectories;
    expect(dirs).toContain(source("a"));
    expect(dirs).toContain(source("b"));
    expect(dirs).toContain(source("c"));
    expect(second.detached_removed).toBeUndefined();
  });

  it("re-correr con una sola fuente de ocho conserva las ocho y su visibilidad", async () => {
    const eight = Array.from({ length: 8 }, (_, index) => {
      const alias = `p${index}`;
      mkdirSync(source(alias));
      return { alias, path: source(alias) };
    });
    await init({ sources: eight });
    const selected = eight[3];
    if (!selected) throw new Error("faltó la cuarta fuente");
    await init({ sources: [selected], proyecto: "Proyecto renombrado" });
    const block = readFileSync(join(hub, "CLAUDE.md"), "utf8");
    expect(block).toContain("Proyecto renombrado");
    for (const item of eight) expect(block).toContain(`| ${item.alias} | (local) |`);
    const settings = JSON.parse(readFileSync(join(hub, ".claude", "settings.local.json"), "utf8"));
    expect(settings.permissions.additionalDirectories).toEqual(
      expect.arrayContaining(eight.map((item) => item.path)),
    );
  });

  it("una ruta explícita nueva actualiza la entrada local sin tocar la otra fuente", async () => {
    await init({
      sources: [
        { alias: "a", path: source("a") },
        { alias: "b", path: source("b") },
      ],
    });
    await init({ sources: [{ alias: "a", path: source("c") }] });
    const local = JSON.parse(readFileSync(paths.cwdLocalConfigFile(), "utf8"));
    expect(local.sources.a).toBe(source("c"));
    expect(local.sources.b).toBe(source("b"));
    const block = readFileSync(join(hub, "CLAUDE.md"), "utf8");
    expect(block).toContain("| a | (local) |");
    expect(block).toContain("| b | (local) |");
  });

  it("sin fuentes no reconcilia metadata: materializa solamente y rechaza opciones de configuración", async () => {
    await init({
      proyecto: "Mi Proyecto",
      sources: [
        { alias: "app", path: source("app-fake") },
        { alias: "lib", path: source("lib-fake") },
      ],
    });
    const before = readFileSync(join(hub, "CLAUDE.md"), "utf-8");
    const second = await runHubInit(fs, env, paths, {
      sources: [],
      hub,
      lastActivity: "2026-01-02 00:00",
    });
    expect(second).toMatchObject({ error: "no_sources" });
    const claude = readFileSync(join(hub, "CLAUDE.md"), "utf-8");
    expect(claude).toBe(before);
    expect(claude).toContain("Mi Proyecto");
    expect(claude).toContain("| app | (local) |");
    expect(claude).toContain("| lib | (local) |");
  });

  it("reconcile con una fuente: conserva la rama de trabajo y QA de la omitida", async () => {
    await init({
      sources: [
        { alias: "a", path: source("a") },
        { alias: "b", path: source("b") },
      ],
      workingBranches: { a: "feature/a", b: "feature/b" },
      qaBranches: { a: "desarrollo", b: "qa/b" },
    });

    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const path = join(hub, file);
      writeFileSync(
        path,
        readFileSync(path, "utf-8").replace(
          "<!-- WORKFLOW-HUB-END -->",
          "## Pipeline\n\n- a: build `npm run build`\n- b: test `npm test`\n<!-- WORKFLOW-HUB-END -->",
        ),
      );
    }

    const second = await init({ sources: [{ alias: "a", path: source("a") }] });

    // Ni en el bloque (los dos archivos) ni en el JSON que devuelve el comando.
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const text = readFileSync(join(hub, file), "utf-8");
      expect(text).toContain("  - a: feature/a");
      expect(text).toContain("feature/b");
      expect(text).toContain("qa/b");
      expect(text).toContain("- a: build `npm run build`");
      expect(text).toContain("- b: test `npm test`");
    }
    const hubBlock = second.hub_block_files;
    if ("error" in hubBlock) throw new Error(hubBlock.error);
    expect(hubBlock.working_branches).toEqual({ a: "feature/a", b: "feature/b" });
    expect(hubBlock.qa_branches).toEqual({ a: "desarrollo", b: "qa/b" });
    expect(hubBlock.dropped_lines).toBeUndefined();
  });

  it("--proyecto sobre un workspace descrito: renombra y PRESERVA la descripción", async () => {
    await init({ proyecto: "Nombre viejo" });
    const claude = join(hub, "CLAUDE.md");
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
    const claude = join(hub, "CLAUDE.md");
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
    expect(existsSync(join(hub, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(hub, ".workflow"))).toBe(false);
    expect(existsSync(join(hub, "docs"))).toBe(false);
    expect(result.scaffold.created.length).toBeGreaterThan(0);
  });

  it("--dry-run deriva el informe del FS: distingue un workspace virgen de uno inicializado", async () => {
    const sessionsDir = join(hub, ".workflow", "sessions");

    const virgin = await init({ dryRun: true });
    expect(virgin.scaffold.created).toEqual([sessionsDir]);
    expect(virgin.scaffold.existing).toEqual([]);
    expect(virgin.skills_toml).toBe("skipped");
    const virginMd = virgin.hub_block_files;
    if ("error" in virginMd) throw new Error(virginMd.error);
    expect(virginMd.results?.map((r) => r.action)).toEqual(["created", "created"]);

    await init();
    const initialized = await init({ dryRun: true });
    expect(initialized.scaffold.created).toEqual([]);
    expect(initialized.scaffold.existing).toEqual([sessionsDir]);
    expect(initialized.skills_toml).toBe("skipped");
    const initializedMd = initialized.hub_block_files;
    if ("error" in initializedMd) throw new Error(initializedMd.error);
    // Mismo input → el bloque ya está escrito: la vista previa no lo llama creación.
    expect(initializedMd.results?.map((r) => r.action)).toEqual(["unchanged", "unchanged"]);
  });

  it("--dry-run anuncia 'updated' cuando el bloque existe pero cambiaría", async () => {
    await init();
    const preview = await init({ dryRun: true, proyecto: "Otro nombre" });
    const hubBlock = preview.hub_block_files;
    if ("error" in hubBlock) throw new Error(hubBlock.error);
    expect(hubBlock.results?.map((r) => r.action)).toEqual(["updated", "updated"]);
    // Sigue siendo una vista previa: el nombre no llegó al disco.
    expect(readFileSync(join(hub, "CLAUDE.md"), "utf-8")).not.toContain("Otro nombre");
  });

  it("--workspace ≠ env.cwd() escribe en workspace, no en cwd", async () => {
    const callerCwd = mkdtempSync(join(tmpdir(), "caller-cwd-"));
    const target = mkdtempSync(join(tmpdir(), "target-ws-"));
    const callerEnv = new FakeEnv(callerCwd);
    const callerPaths = new PathsService(normalizeNamespace("workflow"), callerCwd, callerCwd);
    try {
      const result = await runHubInit(fs, callerEnv, callerPaths, {
        sources: [{ alias: "app", path: source("app") }],
        hub: target,
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
    const source = join(hub, "repo");
    const nestedCwd = join(hub, "nested", "caller");
    mkdirSync(source, { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });
    const nestedEnv = new FakeEnv(hub, nestedCwd);

    const result = await runHubInit(fs, nestedEnv, paths, {
      sources: [{ alias: "app", path: "repo" }],
      lastActivity: "2026-01-01 00:00",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

    expect(readFileSync(join(hub, "CLAUDE.md"), "utf-8")).toContain("| app | repo |  |");
    expect(result.attach_multiroot).toEqual({ skipped: true, reason: "no_external_sources" });
    expect(existsSync(join(nestedCwd, "repo"))).toBe(false);
  });

  it("sin fuentes sólo materializa el runtime", async () => {
    const result = await runHubInit(fs, env, paths, { sources: [], hub });
    if ("error" in result) throw new Error(result.error);
    expect(result.sources).toBe(0);
    expect(result.hub_block_files).toEqual({ skipped: true, reason: "materialization_only" });
    expect(existsSync(join(hub, ".workflow", "sessions"))).toBe(true);
    expect(existsSync(join(hub, "CLAUDE.md"))).toBe(false);
  });

  it("--proyecto configura un workspace sin fuentes y no fabrica filas", async () => {
    const result = await runHubInit(fs, env, paths, { sources: [], proyecto: "Sin fuentes" });
    if ("error" in result) throw new Error(result.error);
    expect(result.ok).toBe(true);
    const claude = readFileSync(join(hub, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Sin fuentes");
    expect(claude).toContain("Sin fuentes declaradas");
  });

  it("rechaza si alias duplicado", async () => {
    const result = await runHubInit(fs, env, paths, {
      sources: [
        { alias: "a", path: source("a") },
        { alias: "a", path: source("b") },
      ],
      hub,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error).toBe("duplicate_alias");
  });

  it("configurar fuentes preserva scaffold legacy; no poda docs ni sesiones y consume el marker legacy", async () => {
    // Workspace from the upfront-scaffold era: empty taxonomy with .gitkeep + one folder with content.
    for (const f of ["manuals", "diagrams", "scripts", "designs"]) {
      mkdirSync(join(hub, "docs", f), { recursive: true });
      writeFileSync(join(hub, "docs", f, ".gitkeep"), "");
    }
    mkdirSync(join(hub, "docs", "specs"), { recursive: true });
    writeFileSync(join(hub, "docs", "specs", ".gitkeep"), "");
    writeFileSync(join(hub, "docs", "specs", "001-spec.md"), "# spec");
    mkdirSync(join(hub, "docs", "logs"), { recursive: true });
    mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
    writeFileSync(join(hub, ".workflow", "sessions", ".gitkeep"), "");
    // Estado de una versión anterior: el acquire consume este marker liberado.
    writeFileSync(join(hub, ".workflow", ".lock"), "");

    const result = await init();

    // The materialization/configuration split is non-destructive: legacy
    // folders remain until an explicit migration owns their removal.
    for (const f of ["manuals", "diagrams", "scripts", "designs"]) {
      expect(existsSync(join(hub, "docs", f, ".gitkeep"))).toBe(true);
    }
    expect(existsSync(join(hub, "docs", "specs", "001-spec.md"))).toBe(true);
    expect(existsSync(join(hub, "docs", "specs", ".gitkeep"))).toBe(true);
    expect(existsSync(join(hub, "docs", "logs"))).toBe(true);
    expect(existsSync(join(hub, ".workflow", "sessions", ".gitkeep"))).toBe(true);
    // La release actual usa unlink; el marcador vacío histórico no sobrevive al
    // acquire. No es una poda del scaffold, sino una limpieza del protocolo lock.
    expect(existsSync(join(hub, ".workflow", ".lock"))).toBe(false);
    expect(result.scaffold.pruned).toEqual([]);
  });

  it("prune reconcile: NO toca un .lock vigente (pid vivo, no expirado)", async () => {
    mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
    // Genuinely held lock: current {pid, ISO ts} (a numeric ts parses to null = corrupt, stealable).
    writeFileSync(
      join(hub, ".workflow", ".lock"),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    const result = await init();
    // The block upsert fails because the lock is held (by someone else) and init does NOT delete the live lock.
    expect(result.ok).toBe(false);
    expect(existsSync(join(hub, ".workflow", ".lock"))).toBe(true);
  });

  it("gitignore block-aware: entradas nuevas se insertan bajo el header existente, sin duplicarlo", async () => {
    mkdirSync(join(hub, ".git"));
    // .gitignore of a workspace initialized by an older CLI (incomplete set).
    writeFileSync(
      join(hub, ".gitignore"),
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
    const gitignore = readFileSync(join(hub, ".gitignore"), "utf-8");
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
    mkdirSync(join(hub, ".git"));
    writeFileSync(
      join(hub, ".gitignore"),
      [".workflow/sessions/", ".workflow/.lock", ""].join("\n"),
    );
    await init();
    const gitignore = readFileSync(join(hub, ".gitignore"), "utf-8");
    const sessionsCount = gitignore
      .split("\n")
      .filter((l) => l.trim() === ".workflow/sessions/").length;
    expect(sessionsCount).toBe(1);
  });

  it("gitignore CRLF: el merge bajo header preserva el EOL (no reescribe el archivo a LF)", async () => {
    mkdirSync(join(hub, ".git"));
    writeFileSync(
      join(hub, ".gitignore"),
      [
        "node_modules/",
        "",
        "# agent-workflow runtime (machine-specific — do not commit)",
        ".workflow/processes.json",
        "",
      ].join("\r\n"),
    );
    await init();
    const gitignore = readFileSync(join(hub, ".gitignore"), "utf-8");
    expect(gitignore).toContain("\r\n");
    expect(gitignore).toContain(".workflow/sessions/");
    // The user's line keeps its original line terminator.
    expect(gitignore).toContain("node_modules/\r\n");
  });

  it("--dry-run no propone poda implícita y conserva el scaffold legacy", async () => {
    mkdirSync(join(hub, "docs", "manuals"), { recursive: true });
    writeFileSync(join(hub, "docs", "manuals", ".gitkeep"), "");
    mkdirSync(join(hub, "docs", "logs"), { recursive: true });
    const result = await init({ dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.scaffold.pruned).toEqual([]);
    // Nothing was actually deleted.
    expect(existsSync(join(hub, "docs", "manuals", ".gitkeep"))).toBe(true);
    expect(existsSync(join(hub, "docs", "logs"))).toBe(true);
  });

  it("pruneReleasedLock directo: vivo intocable · liberado y expirado removibles (guard real)", async () => {
    const lockPath = join(hub, ".workflow", ".lock");
    mkdirSync(join(hub, ".workflow"), { recursive: true });
    const wsPaths = new PathsService(normalizeNamespace("workflow"), hub, hub);

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
    hubInitCommand.renderHuman?.({ ok: true, data, exitCode: 0 } as never, { detail } as never) ??
    "";

  const withDropped = {
    ok: true,
    dry_run: false,
    hub: "/w",
    sources: 1,
    skills_toml: "exists",
    scaffold: {},
    attach_multiroot: {},
    hub_block_files: { dropped_lines: ["  - b: feature/b"] },
  };

  it("las nombra sin --detail, que es el modo por defecto", () => {
    const text = humanOf(withDropped, false);
    expect(text).toContain("- b: feature/b");
    expect(text).toMatch(/retiraron 1 línea/);
  });

  it("y no inventa la sección cuando no se retiró nada", () => {
    const text = humanOf({ ...withDropped, hub_block_files: {} }, false);
    expect(text).not.toMatch(/retiraron/);
  });
});
