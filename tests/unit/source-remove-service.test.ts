import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runProjectMdUpsertWrite } from "../../src/application/project-md-upsert-service.js";
import { removeSource } from "../../src/application/source-remove-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const FIXED_TS = "2026-05-07 12:00";

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
        { alias: "core", path: "../repo/core", mainBranch: "main" },
        { alias: "plugin", path: "../repo/plugin", mainBranch: "main" },
      ],
      workingBranches: { plugin: "feature/x" },
      qaBranches: { plugin: "desarrollo" },
      pipeline: { core: { build: "npm run build" }, plugin: { test: "npm test" } },
      lastActivity: FIXED_TS,
    });
  }

  it("quita la fuente sin leer ni alterar lanzadores, registro o logs previos", async () => {
    const env = new FakeEnv(cwd);
    const paths = makePaths(cwd);
    await seedBlock(env, paths);

    const launchDir = join(cwd, ".agent-workflow", "launch", "plugin");
    await mkdir(launchDir, { recursive: true });
    const launchFile = join(launchDir, "launch.json");
    const processFile = join(cwd, ".agent-workflow", "processes.json");
    const logFile = join(cwd, "docs", "logs", "plugin.log");
    await writeFile(launchFile, "{legacy: edited}\n");
    await writeFile(processFile, "registro legacy ilegible\n");
    await mkdir(join(cwd, "docs", "logs"), { recursive: true });
    await writeFile(logFile, "log anterior\n");

    const result = await removeSource({ fs, env, paths }, "plugin");

    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("| core | ../repo/core | main |");
    expect(claude).not.toContain("../repo/plugin");
    expect(claude).not.toContain("feature/x");
    expect(claude).not.toContain("- plugin: desarrollo");
    expect(claude).not.toContain("- plugin: test `npm test`");
    expect(claude).toContain("- core: build `npm run build`");
    expect(await readFile(launchFile, "utf8")).toBe("{legacy: edited}\n");
    expect(await readFile(processFile, "utf8")).toBe("registro legacy ilegible\n");
    expect(await readFile(logFile, "utf8")).toBe("log anterior\n");
  });

  it("returns an error for an unknown alias", async () => {
    const env = new FakeEnv(cwd);
    const paths = makePaths(cwd);
    await seedBlock(env, paths);
    const result = await removeSource({ fs, env, paths }, "ghost");
    expect("error" in result).toBe(true);
  });

  it("quita una fuente sin artefactos legacy", async () => {
    const env = new FakeEnv(cwd);
    const paths = makePaths(cwd);
    await seedBlock(env, paths);
    const result = await removeSource({ fs, env, paths }, "core");
    expect("error" in result).toBe(false);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("../repo/core");
    expect(claude).toContain("../repo/plugin");
  });

  it("elimina la entrada local aunque la ruta no exista en este host", async () => {
    const env = new FakeEnv(cwd);
    const paths = makePaths(cwd);
    await seedBlock(env, paths);
    await writeFile(
      paths.cwdLocalConfigFile(),
      JSON.stringify({ version: 1, sources: { core: "/ruta/ausente" }, otra_clave: true }),
    );
    const result = await removeSource({ fs, env, paths }, "core");
    expect("error" in result).toBe(false);
    const local = JSON.parse(await readFile(paths.cwdLocalConfigFile(), "utf8"));
    expect(local.sources.core).toBeUndefined();
    expect(local.otra_clave).toBe(true);
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).not.toContain("| core |");
  });

  it("al quitar la única fuente Java recalcula el Stack sin conservar Java", async () => {
    const env = new FakeEnv(cwd);
    const paths = makePaths(cwd);
    const java = join(cwd, "java");
    const angular = join(cwd, "angular");
    await mkdir(java);
    await mkdir(angular);
    await writeFile(join(java, "pom.xml"), "<project/>");
    await writeFile(join(angular, "angular.json"), "{}");
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [
        { alias: "java", path: java, mainBranch: "main" },
        { alias: "angular", path: angular, mainBranch: "main" },
      ],
    });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toContain(
      "- Lenguaje: Java, TypeScript",
    );
    const removed = await removeSource({ fs, env, paths }, "java");
    expect("error" in removed).toBe(false);
    const block = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(block).toContain("- Lenguaje: TypeScript");
    expect(block).not.toContain("Java");
    expect(block).toContain("- Framework: Angular");
  });
});
