import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { readWorkspaceBlock } from "../../src/application/parsers/project-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { addSource } from "../../src/application/source-add-service.js";
import { addSourceCommand } from "../../src/cli/commands/add-source.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("add-source agrega una fuente sin podar las existentes y escribe la ruta en local.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-add-source-"));
  roots.push(root);
  const repoA = join(root, "a");
  const repoB = join(root, "b");
  await mkdir(repoA);
  await mkdir(repoB);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  const fs = new NodeFileSystem();
  const env = new FakeEnv(root);
  const git = { isGitRepo: async () => true, currentBranch: async () => "main" } as GitPort;
  expect(
    "error" in
      (await addSource(fs, env, git, paths, { alias: "a", path: repoA, mainBranch: "main" })),
  ).toBe(false);
  expect(
    "error" in
      (await addSource(fs, env, git, paths, { alias: "b", path: repoB, mainBranch: "main" })),
  ).toBe(false);
  const block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
  expect(block?.fuentes.map((f) => f.alias)).toEqual(["a", "b"]);
  expect((await readFile(join(root, "CLAUDE.md"), "utf8")).includes("| a | a | main |")).toBe(true);
  const local = JSON.parse(await readFile(paths.cwdLocalConfigFile(), "utf8"));
  expect(local.sources).toEqual({ a: repoA, b: repoB });
});

it("registra una rama de trabajo explícita cuando ya existe en el repositorio", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-add-source-branch-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  const git = {
    isGitRepo: async () => true,
    currentBranch: async () => "main",
    localBranches: async () => ["main", "feature/x"],
  } as GitPort;
  const result = await addSource(new NodeFileSystem(), new FakeEnv(root), git, paths, {
    alias: "repo",
    path: repo,
    mainBranch: "main",
    workingBranch: "feature/x",
  });
  expect(result).toMatchObject({ alias: "repo", working_branch: "feature/x" });
  const block = await readWorkspaceBlock(new NodeFileSystem(), root, paths.blockMarkers());
  expect(block?.working_branches.repo).toBe("feature/x");
});

it("actualizar la ruta de un alias existente reemplaza sólo su coordenada local", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-add-source-update-"));
  roots.push(root);
  const previous = join(root, "previous");
  const next = join(root, "next");
  await mkdir(previous);
  await mkdir(next);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  const fs = new NodeFileSystem();
  const env = new FakeEnv(root);
  const git = { isGitRepo: async () => true, currentBranch: async () => "main" } as GitPort;
  await addSource(fs, env, git, paths, { alias: "core", path: previous, mainBranch: "main" });
  const updateGit = {
    isGitRepo: async () => true,
    currentBranch: async () => "feature/x",
  } as GitPort;
  const updated = await addSource(fs, env, updateGit, paths, { alias: "core", path: next });
  expect(updated).toMatchObject({ alias: "core", path: next });
  const block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
  expect(block?.fuentes).toHaveLength(1);
  expect(block?.fuentes[0]?.path).toBe(next);
  expect(block?.working_branches.core).toBeUndefined();
  expect(JSON.parse(await readFile(paths.cwdLocalConfigFile(), "utf8")).sources.core).toBe(next);
});

it("cambiar una fuente externa quita su visibilidad anterior sin alterar las demás", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-add-source-visibility-"));
  const oldRepo = await mkdtemp(join(tmpdir(), "aw-add-old-"));
  const newRepo = await mkdtemp(join(tmpdir(), "aw-add-new-"));
  const otherRepo = await mkdtemp(join(tmpdir(), "aw-add-other-"));
  roots.push(root, oldRepo, newRepo, otherRepo);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  const fs = new NodeFileSystem();
  const env = new FakeEnv(root);
  const git = { isGitRepo: async () => true, currentBranch: async () => "main" } as GitPort;
  await addSource(fs, env, git, paths, { alias: "core", path: oldRepo, mainBranch: "main" });
  await addSource(fs, env, git, paths, { alias: "other", path: otherRepo, mainBranch: "main" });
  await addSource(fs, env, git, paths, { alias: "core", path: newRepo });
  const settings = JSON.parse(await readFile(join(root, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.additionalDirectories).toContain(newRepo);
  expect(settings.permissions.additionalDirectories).toContain(otherRepo);
  expect(settings.permissions.additionalDirectories).not.toContain(oldRepo);
});

it("rechaza un alta cuya ruta no existe antes de escribir bloque, local.json o consultar git", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-add-source-missing-"));
  roots.push(root);
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  const fs = new NodeFileSystem();
  const missing = join(root, "no-existe");
  const git = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("git no debe correr");
      },
    },
  ) as GitPort;
  const args: ParsedArgs = {
    rest: [`repo:${missing}:main`],
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
  };
  const result = await addSourceCommand.execute(args, {
    fs,
    env: new FakeEnv(root),
    git,
    paths,
  } as CliContext);
  expect(result.ok).toBe(false);
  expect(result.error?.message).toContain("la ruta de la fuente repo no existe en este host");
  expect(await fs.exists(join(root, "CLAUDE.md"))).toBe(false);
  expect(await fs.exists(paths.cwdLocalConfigFile())).toBe(false);
});
