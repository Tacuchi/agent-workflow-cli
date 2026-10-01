import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSources } from "../../src/application/sources-service.js";
import { runWorktree } from "../../src/application/worktree-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

describe("unidad sin rama de trabajo", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let repo: string;
  let deps: {
    fs: NodeFileSystem;
    env: FakeEnv;
    git: GitCliAdapter;
    paths: PathsService;
  };

  function declare(work: string | null): void {
    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `<!-- WORKFLOW-HUB-START -->
## Hub
Prueba.
## Fuentes
| Alias | Path | Rama principal |
|---|---|---|
| acme | ${repo} | main |
## Status
- Ramas por defecto: desarrollo=develop
${work === null ? "" : `- Ramas de trabajo actuales:\n  - acme: ${work}\n`}- Última actividad: 2026-08-07
<!-- WORKFLOW-HUB-END -->`,
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-no-work-"));
    home = join(root, "home");
    workspace = join(root, "ws");
    repo = join(root, "repo");
    for (const dir of [home, workspace, repo]) mkdirSync(dir);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "initial\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    git(repo, "branch", "develop");
    declare(null);
    const session = join(workspace, ".workflow", "sessions", "101-test-plan-exec");
    mkdirSync(session, { recursive: true });
    writeFileSync(
      join(session, "SESSION.md"),
      "# SESSION — 101-test-plan-exec\n\n## Objective\nTest\n",
    );
    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("workflow"), home, workspace),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("does not create a worktree on the development default and reports the remedy", async () => {
    const refused = await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "101",
    });
    expect(refused).toMatchObject({
      error: "working_branch_undeclared",
      hint: expect.stringContaining("aw set-working-branch acme <rama>"),
    });
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("aw/");
    const sources = await runSources(deps.fs, deps.env, deps.git, deps.paths, { skipGit: true });
    expect(sources.sources[0]).toMatchObject({
      expected_work_branch: null,
      expected_origin: "none",
      working_branch_notice: expect.stringContaining("aw set-working-branch acme <rama>"),
    });
  });

  it("distinguishes a missing base from a worktree add failure", async () => {
    declare("missing");
    const absent = await runWorktree(deps, { action: "ensure", alias: "acme", sessionCode: "101" });
    expect(absent).toMatchObject({
      error: "base_missing",
      message: expect.stringContaining("missing"),
    });
    declare("main");
    const created = await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "101",
    });
    expect(created).toMatchObject({ created: true, base: "main" });
    if (!("path" in created)) throw new Error("no unit");
    const released = await runWorktree(deps, {
      action: "release",
      alias: "acme",
      sessionCode: "101",
    });
    expect(released).toMatchObject({ released: true });
    mkdirSync(created.path);
    writeFileSync(join(created.path, "owned.txt"), "not from git\n");
    const blocked = await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "101",
    });
    expect(blocked).toMatchObject({
      error: "worktree_add_failed",
      message: expect.stringMatching(/already exists|not empty/),
    });
    expect(blocked).not.toHaveProperty("hint");
  });

  it("releases without a work branch and retains unintegrated commits on reclaim", async () => {
    declare("main");
    const created = await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "101",
    });
    if (!("path" in created)) throw new Error("no unit");
    writeFileSync(join(created.path, "own.txt"), "work\n");
    git(created.path, "add", "-A");
    git(created.path, "commit", "-m", "work");
    declare(null);
    const integrated = await runWorktree(deps, {
      action: "integrate",
      alias: "acme",
      sessionCode: "101",
    });
    expect(integrated).toMatchObject({ error: "working_branch_undeclared" });
    const reclaimed = await runWorktree(deps, {
      action: "reclaim",
      alias: "acme",
      sessionCode: "101",
    });
    expect(reclaimed).toMatchObject({
      retained: [expect.objectContaining({ reason: "unreadable" })],
    });
    const released = await runWorktree(deps, {
      action: "release",
      alias: "acme",
      sessionCode: "101",
    });
    expect(released).toMatchObject({ released: true });
    expect(git(repo, "branch", "--list", "aw/*")).toContain("aw/");
  });
});
