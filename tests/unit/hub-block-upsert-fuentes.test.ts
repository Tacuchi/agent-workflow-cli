import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { resolveSourceBranches } from "../../src/application/branch-resolver.js";
import { runHubBlockUpsertWrite } from "../../src/application/hub-block-upsert-service.js";
import { parseHubBlock } from "../../src/application/parsers/hub-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const FIXED_TS = "2026-05-07 12:00";

function makePaths(home: string): PathsService {
  const ns = normalizeNamespace("agent-workflow");
  return new PathsService(ns, home, home);
}

describe("project-md-upsert --init with --fuente / --main-branch", () => {
  // These source paths represent repos on the other host, not paths on this test host.
  // Relative declarations stay portable and need no filesystem fixture.
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

  it("recalcula Stack sobre todas las fuentes, conserva faltantes y quita Java tras la baja", async () => {
    const java = join(cwd, "java");
    const angular = join(cwd, "angular");
    await fs.mkdirp(java);
    await fs.mkdirp(angular);
    await fs.writeText(join(java, "pom.xml"), "<project/>");
    await fs.writeText(join(angular, "angular.json"), "{}");
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "java", path: java, mainBranch: "main" },
        { alias: "angular", path: angular, mainBranch: "main" },
      ],
    });
    const agentsMd = join(cwd, "AGENTS.md");
    expect(await readFile(agentsMd, "utf8")).toContain("- Lenguaje: Java, TypeScript");
    expect(await readFile(agentsMd, "utf8")).toContain("- Framework: Spring Boot, Angular");

    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "ausente", path: "../fuente-de-otro-host", mainBranch: "main" }],
    });
    await fs.remove(java);
    await runHubBlockUpsertWrite(fs, env, paths, { op: "init" });
    expect(await readFile(agentsMd, "utf8")).toContain("- Lenguaje: TypeScript, Java");

    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      removeAliases: ["java", "ausente"],
    });
    const remaining = await readFile(agentsMd, "utf8");
    expect(remaining).toContain("- Lenguaje: TypeScript");
    expect(remaining).not.toContain("Java");
    expect(remaining).toContain("- Framework: Angular");
  });

  it("renders 1 fuente from --fuente alias:path:rama", async () => {
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("| core | ../repo/core | main |");
  });

  it("writes defaultBranches and merges them per role across calls", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
      lastActivity: FIXED_TS,
    });
    // Second call touches ONE role: the other two must survive (field merge).
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      defaultBranches: { qa: "release/qa" },
      lastActivity: FIXED_TS,
    });

    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("  - principal: main");
    expect(agentsMd).toContain("  - desarrollo: development");
    expect(agentsMd).toContain("  - qa: release/qa");
    expect(agentsMd).not.toContain("  - qa: qa\n");
  });

  it("leaves the block without a defaults entry when none is given", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("Ramas por defecto");
  });

  it("renders 2 fuentes with shared --main-branch fallback", async () => {
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "../repo/core" },
        { alias: "plugin", path: "../repo/plugin" },
      ],
      mainBranch: "certificacion",
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("| core | ../repo/core | certificacion |");
    expect(agentsMd).toContain("| plugin | ../repo/plugin | certificacion |");
  });

  it("renders 3 fuentes with mixed per-fuente rama and --main-branch fallback", async () => {
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "../repo/core", mainBranch: "main" },
        { alias: "plugin", path: "../repo/plugin" },
        { alias: "marketplace", path: "../repo/marketplace", mainBranch: "stable" },
      ],
      mainBranch: "certificacion",
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("| core | ../repo/core | main |");
    expect(agentsMd).toContain("| plugin | ../repo/plugin | certificacion |");
    expect(agentsMd).toContain("| marketplace | ../repo/marketplace | stable |");
  });

  it("deja la celda VACÍA cuando no hay ni rama por fuente ni --main-branch", async () => {
    // Una celda vacía significa «resuélveme por el default `principal` del
    // workspace». Estampar un literal aquí (antes `certificacion`) volvía
    // inalcanzable ese default y pisaba lo que el usuario fija en [Config].
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core" }],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("| core | ../repo/core |  |");
    expect(agentsMd).not.toContain("certificacion");

    // Y la fuente resuelve entonces por el default del workspace.
    const parsed = parseHubBlock(agentsMd, paths.blockMarkers());
    const fuente = parsed?.fuentes[0];
    if (!fuente || !parsed) throw new Error("expected a parsed fuente");
    expect(fuente.main_branch).toBeNull();
    expect(
      resolveSourceBranches(fuente, { ...parsed, default_branches: { principal: "trunk" } }).prod,
    ).toBe("trunk");
  });

  it("merges --working-branch entries (multi-flag) into Status", async () => {
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "../repo/core" },
        { alias: "plugin", path: "../repo/plugin" },
      ],
      mainBranch: "certificacion",
      workingBranches: { core: "feature/upgrade", plugin: "feature/upgrade" },
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    // No `Mode:` line is ever emitted (the project/hub mode concept is gone).
    expect(agentsMd).not.toMatch(/^Mode:/m);
    expect(agentsMd).toContain("- core: feature/upgrade");
    expect(agentsMd).toContain("- plugin: feature/upgrade");
  });

  it("merges --qa-branch entries (multi-flag) into Status", async () => {
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "../repo/core" },
        { alias: "plugin", path: "../repo/plugin" },
      ],
      mainBranch: "certificacion",
      qaBranches: { core: "desarrollo", plugin: "desarrollo" },
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("- Ramas QA actuales:");
    expect(agentsMd).toContain("  - core: desarrollo");
    expect(agentsMd).toContain("  - plugin: desarrollo");
  });

  it("preserves existing qa_branches and merges new ones on re-init", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core" }],
      qaBranches: { core: "desarrollo" },
      lastActivity: FIXED_TS,
    });
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      qaBranches: { plugin: "qa/plugin" },
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("  - core: desarrollo");
    expect(agentsMd).toContain("  - plugin: qa/plugin");
  });

  it("preserves existing fuentes and overrides matching alias on re-init", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "../repo/old-core", mainBranch: "main" },
        { alias: "extra", path: "../repo/extra", mainBranch: "main" },
      ],
      lastActivity: FIXED_TS,
    });
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/new-core", mainBranch: "stable" }],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("| core | ../repo/new-core | stable |");
    expect(agentsMd).toContain("| extra | ../repo/extra | main |");
    expect(agentsMd).not.toContain("../repo/old-core");
  });

  it("removeAliases prunes a source from fuentes + working + qa branches", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "../repo/core", mainBranch: "main" },
        { alias: "plugin", path: "../repo/plugin", mainBranch: "main" },
      ],
      workingBranches: { core: "feature/a", plugin: "feature/b" },
      qaBranches: { core: "desarrollo", plugin: "qa/plugin" },
      lastActivity: FIXED_TS,
    });
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      removeAliases: ["plugin"],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("| core | ../repo/core | main |");
    expect(agentsMd).not.toContain("../repo/plugin");
    expect(agentsMd).toContain("- core: feature/a");
    expect(agentsMd).not.toContain("plugin: feature/b");
    expect(agentsMd).toContain("  - core: desarrollo");
    expect(agentsMd).not.toContain("qa/plugin");
  });

  it("una nota humana dentro del bloque sobrevive al re-init en LOS DOS archivos", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      workingBranches: { core: "feature/x" },
      lastActivity: FIXED_TS,
    });
    // Una persona anota dentro del bloque, en el archivo que lee su host.
    const nota = "- Nota: la ruta de core es local a esta máquina";
    const agentsMd = join(cwd, "AGENTS.md");
    await fs.writeText(
      agentsMd,
      (await readFile(agentsMd, "utf8")).replace(
        "- Ramas de trabajo actuales:",
        `${nota}\n- Ramas de trabajo actuales:`,
      ),
    );

    await runHubBlockUpsertWrite(fs, env, paths, { op: "init", lastActivity: FIXED_TS });

    const text = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(text).toContain(`${nota}\n- Ramas de trabajo actuales:`);
    // Y no se adoptó como rama: no aparece anidada bajo el encabezado.
    expect(text).not.toContain(`  ${nota}`);
  });

  it("la primera escritura en un hub heredado lleva a AGENTS.md el bloque y las notas de CLAUDE.md, sin tocarlo", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    const nota = "- Recordatorio: pedir acceso al repo de plugins";
    const legacy = join(cwd, "CLAUDE.md");
    const block = await readFile(join(cwd, "AGENTS.md"), "utf8");
    await fs.writeText(legacy, block.replace("## Status\n\n", `## Status\n\n${nota}\n`));
    await fs.remove(join(cwd, "AGENTS.md"));
    const legacyBefore = await readFile(legacy, "utf8");

    await runHubBlockUpsertWrite(fs, env, paths, { op: "init", lastActivity: FIXED_TS });

    const written = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(written).toContain(nota);
    expect(written).toContain("| core |");
    expect(await readFile(legacy, "utf8")).toBe(legacyBefore);
  });

  it("--proyecto renombra el workspace y PRESERVA su descripción", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      proyecto: "Nombre viejo\n\nDescripción larga escrita a mano.\n\n- Un detalle importante.",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });

    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      proyecto: "Nombre nuevo",
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("Nombre nuevo");
    expect(agentsMd).not.toContain("Nombre viejo");
    expect(agentsMd).toContain("Descripción larga escrita a mano.");
    expect(agentsMd).toContain("- Un detalle importante.");
  });

  it("replaceFuentes poda las ramas de una fuente que ya no se declara y lo DECLARA", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "core", path: "../repo/core", mainBranch: "main" },
        { alias: "plugin", path: "../repo/plugin", mainBranch: "main" },
      ],
      workingBranches: { core: "feature/a", plugin: "feature/b" },
      qaBranches: { core: "desarrollo", plugin: "qa/plugin" },
      pipeline: { core: { test: "npm test" }, plugin: { build: "ninguno" } },
      lastActivity: FIXED_TS,
    });

    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      replaceFuentes: true,
      verbose: true,
      lastActivity: FIXED_TS,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.working_branches).toEqual({ core: "feature/a" });
    expect(result.qa_branches).toEqual({ core: "desarrollo" });
    expect(result.dropped_lines).toEqual([
      "  - plugin: feature/b",
      "  - plugin: qa/plugin",
      "- plugin: build ninguno",
    ]);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("plugin");
    expect(agentsMd).toContain("- core: test `npm test`");
  });

  it("removeAliases of the last source leaves an empty fuentes table", async () => {
    await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "../repo/core", mainBranch: "main" }],
      lastActivity: FIXED_TS,
    });
    const result = await runHubBlockUpsertWrite(fs, env, paths, {
      op: "init",
      removeAliases: ["core"],
      lastActivity: FIXED_TS,
    });
    expect("error" in result).toBe(false);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("../repo/core");
    expect(agentsMd).toContain("Sin fuentes declaradas");
  });
});
