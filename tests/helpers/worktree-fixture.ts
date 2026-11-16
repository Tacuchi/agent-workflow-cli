import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { attachClaude } from "../../src/application/multiroot/claude.js";
import { attachCodex } from "../../src/application/multiroot/codex.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ensureUnit, planUnit } from "../../src/application/plan-run/units.js";
import { hubKey, unitsRoot } from "../../src/domain/isolation-unit.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "./fake-env.js";

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

export function worktreeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aw-unit-lifecycle-")));
  const home = join(root, "home");
  const hub = join(root, "ws");
  const repo = join(root, "repo");
  for (const dir of [home, hub, repo]) mkdirSync(dir);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, ".gitignore"), "target/\nnode_modules/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, "package.json"), '{"name":"unit-test","version":"1.0.0"}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  const block = `<!-- WORKFLOW-HUB-START -->
## Hub
Prueba.
## Fuentes
| Alias | Path | Rama principal |
|---|---|---|
| acme | ${repo} | main |
## Status
- Ramas de trabajo actuales:
  - acme: main
<!-- WORKFLOW-HUB-END -->`;
  writeFileSync(join(hub, "CLAUDE.md"), block);
  const deps = {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, hub),
    git: new GitCliAdapter(new NodeProcess()),
    paths: new PathsService(normalizeNamespace("workflow"), home, hub),
  };
  /** Takes a plan unit of `acme` the way `aw flow unit` does, and registers it in both hosts. */
  const ensure = async () => {
    const root = await deps.fs
      .realPath(unitsRoot(deps.paths.userRoot()))
      .catch(() => unitsRoot(deps.paths.userRoot()));
    const unit = planUnit({
      worktreesRoot: root,
      hubKey: hubKey(hub),
      alias: "acme",
      plan: "101",
      batch: "B1",
    });
    const ensured = await ensureUnit(deps.fs, deps.git, repo, unit, "main");
    attachClaude([repo, ensured.unit.path], hub);
    attachCodex([repo, ensured.unit.path], hub);
    return ensured.unit;
  };
  return {
    root,
    home,
    hub,
    repo,
    deps,
    ensure,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
