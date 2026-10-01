import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { registerHub } from "../../src/application/hub-registry.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { recordUnitTaken } from "../../src/application/session-custody-recorder.js";
import { type WorktreeDeps, runWorktree } from "../../src/application/worktree-service.js";
import { hubKey } from "../../src/domain/isolation-unit.js";
import { resolveHubDirectory } from "../../src/runtime/hub-resolution.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}
let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

it("recupera una rama aw antigua ya liberada con commits en vez de recortarla a su base", async () => {
  root = mkdtempSync(join(tmpdir(), "aw-legacy-branch-"));
  const source = join(root, "source");
  const hub = join(root, "hub");
  const home = join(root, "home");
  mkdirSync(source);
  mkdirSync(hub);
  mkdirSync(home);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.email", "t@example.com");
  git(source, "config", "user.name", "T");
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "base");
  writeFileSync(
    join(hub, "AGENTS.md"),
    `<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| src | ${source} | main |\n## Status\n- Ramas de trabajo actuales:\n  - src: main\n<!-- WORKFLOW-HUB-END -->`,
  );
  const paths = new PathsService(normalizeNamespace("workflow"), home, hub);
  const deps = {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, hub),
    git: new GitCliAdapter(new NodeProcess()),
    paths,
  };
  const born = await runSessionCreate(deps.fs, paths, {
    type: "exec",
    name: "viejo-plan-exec",
    objetivo: "rama vieja",
  });
  if ("error" in born) throw Error(born.error);
  const folder = born.sessionCreate.folder;
  const branch = `aw/${folder}`;
  mkdirSync(paths.userUnitsDir(), { recursive: true });
  const unit = join(realpathSync(paths.userUnitsDir()), hubKey(hub), "src", folder);
  mkdirSync(join(unit, ".."), { recursive: true });
  git(source, "worktree", "add", "-b", branch, unit);
  const recorded = await recordUnitTaken(deps, folder, {
    alias: "src",
    sourcePath: source,
    unitPath: unit,
    unitBranch: branch,
    base: "main",
  });
  expect(recorded.status).toBe("updated");
  writeFileSync(join(unit, "pendiente.txt"), "commit propio\n");
  git(unit, "add", "pendiente.txt");
  git(unit, "commit", "-m", "pendiente");
  const originalHead = git(unit, "rev-parse", "HEAD");
  const released = await runWorktree(deps, {
    action: "release",
    alias: "src",
    sessionCode: folder,
  });
  if ("error" in released) throw Error(JSON.stringify(released));
  const recovered = await runWorktree(deps, {
    action: "ensure",
    alias: "src",
    sessionCode: folder,
  });
  if ("error" in recovered || !("path" in recovered) || !("branch" in recovered))
    throw Error(JSON.stringify(recovered));
  expect(recovered.branch).toBe(branch);
  expect(git(recovered.path, "rev-parse", "HEAD")).toBe(originalHead);
  expect(readFileSync(join(recovered.path, "pendiente.txt"), "utf8")).toBe("commit propio\n");
});

it("dos hubs con el mismo checkout y número de sesión conservan unidades y ramas distintas", async () => {
  root = mkdtempSync(join(tmpdir(), "aw-shared-wt-"));
  const source = join(root, "source");
  const home = join(root, "home");
  const folder = "001-mismo-plan-exec";
  mkdirSync(source);
  mkdirSync(home);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.email", "t@example.com");
  git(source, "config", "user.name", "T");
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "base");
  const units = [];
  const contexts: WorktreeDeps[] = [];
  async function createHubUnit(hub: string) {
    mkdirSync(hub);
    writeFileSync(
      join(hub, "AGENTS.md"),
      `<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| src | ${source} | main |\n## Status\n- Ramas de trabajo actuales:\n  - src: main\n<!-- WORKFLOW-HUB-END -->`,
    );
    const paths = new PathsService(normalizeNamespace("workflow"), home, hub);
    const born = await runSessionCreate(new NodeFileSystem(), paths, {
      type: "exec",
      name: "mismo-plan-exec",
      objetivo: "prueba",
    });
    if ("error" in born) throw Error(born.error);
    expect(born.sessionCreate.folder).toBe(folder);
    const deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, hub),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
    contexts.push(deps);
    await registerHub(deps.fs, paths, hub);
    const result = await runWorktree(deps, { action: "ensure", alias: "src", sessionCode: "001" });
    if ("error" in result || !("branch" in result)) throw Error(JSON.stringify(result));
    const hash = createHash("sha256").update(hub.replaceAll("\\", "/")).digest("hex").slice(0, 8);
    expect(result.branch).toBe(`aw/${hash}/${folder}`);
    expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("base\n");
    return result;
  }
  for (const name of ["hub-a", "hub-b"]) {
    units.push(await createHubUnit(join(root, name)));
  }
  expect(units[0]?.branch).not.toBe(units[1]?.branch);
  expect(units[0]?.path).not.toBe(units[1]?.path);
  expect(git(source, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(3);
  for (let i = 0; i < contexts.length; i += 1) {
    const unit = units[i];
    const owner = contexts[i];
    if (!unit || !owner) throw Error("unidad sin dueño");
    const directory = {
      namespace: normalizeNamespace("workflow"),
      root: home,
      materialized: false,
      namespaceSource: "default" as const,
    };
    const selected = await resolveHubDirectory(owner.fs, directory, unit.path, home);
    expect(selected.root).toBe(await owner.fs.realPath(owner.paths.hubDir()));
  }
  const [firstContext, secondContext] = contexts;
  if (!firstContext || !secondContext) throw Error("faltan hubs");
  const firstUnit = units[0];
  if (!firstUnit) throw Error("falta la primera unidad");
  writeFileSync(join(firstUnit.path, "retenido.txt"), "commit del hub-a\n");
  git(firstUnit.path, "add", "retenido.txt");
  git(firstUnit.path, "commit", "-m", "retenido");
  const released = await runWorktree(firstContext, {
    action: "release",
    alias: "src",
    sessionCode: "001",
  });
  if ("error" in released) throw Error(JSON.stringify(released));
  const recovered = await runWorktree(firstContext, {
    action: "ensure",
    alias: "src",
    sessionCode: "001",
  });
  if ("error" in recovered || !("path" in recovered)) throw Error(JSON.stringify(recovered));
  expect(readFileSync(join(recovered.path, "retenido.txt"), "utf8")).toBe("commit del hub-a\n");
  const again = await runWorktree(secondContext, {
    action: "ensure",
    alias: "src",
    sessionCode: "001",
  });
  if ("error" in again || !("branch" in again)) throw Error(JSON.stringify(again));
  expect(again.branch).toBe(units[1]?.branch);
  expect(again.path).toBe(units[1]?.path);
});
