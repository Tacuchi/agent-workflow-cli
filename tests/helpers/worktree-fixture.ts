import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { type WorktreeDeps, runWorktree } from "../../src/application/worktree-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "./fake-env.js";

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

export function worktreeFixture() {
  const root = mkdtempSync(join(tmpdir(), "aw-unit-lifecycle-"));
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
  const session = join(hub, ".workflow", "sessions", "101-test-plan-exec");
  mkdirSync(session, { recursive: true });
  writeFileSync(
    join(session, "SESSION.md"),
    "# SESSION — 101-test-plan-exec\n\n## Objective\nPrueba\n",
  );
  const deps: WorktreeDeps = {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, hub),
    git: new GitCliAdapter(new NodeProcess()),
    paths: new PathsService(normalizeNamespace("workflow"), home, hub),
  };
  const run = (action: "ensure" | "release" | "integrate" | "reclaim") =>
    runWorktree(deps, { action, alias: "acme", sessionCode: "101" });
  return {
    root,
    home,
    hub,
    repo,
    session,
    deps,
    run,
    close: () => writeFileSync(join(session, ".closed"), ""),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
