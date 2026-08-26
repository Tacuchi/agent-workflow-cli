import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type WorktreeEnsureOutput,
  type WorktreeListOutput,
  type WorktreeReleaseOutput,
  runWorktree,
} from "../../src/application/worktree-service.js";
import { workspaceKey } from "../../src/domain/isolation-unit.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * Real git on purpose.
 *
 * The whole design rests on properties git itself enforces — a branch cannot be
 * checked out in two worktrees, a tree with uncommitted work is not removed —
 * and a fake that "returns an error" for those would be asserting our own
 * assumption back at us instead of the behaviour we are relying on.
 */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function block(sourcePath: string): string {
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

Test.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| acme | ${sourcePath} | main |

## Stack

_Stack sin detectar._

## Status

- Ramas de trabajo actuales:
  - acme: main
- Última actividad: 2026-08-07
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-PROJECT-END -->
`;
}

describe("runWorktree — the isolation unit of a flow", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let source: string;
  let deps: Parameters<typeof runWorktree>[0];
  let paths: PathsService;

  function session(folder: string, closed = false): void {
    const dir = join(workspace, ".workflow", "sessions", folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SESSION.md"), `# SESSION — ${folder}\n`);
    if (closed) writeFileSync(join(dir, ".closed"), "");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worktree-svc-"));
    home = join(root, "home");
    workspace = join(root, "ws");
    source = join(root, "acme");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(source, { recursive: true });

    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.email", "t@example.com");
    git(source, "config", "user.name", "T");
    writeFileSync(join(source, "README.md"), "hola\n");
    git(source, "add", "-A");
    git(source, "commit", "-m", "inicial");

    writeFileSync(join(workspace, "CLAUDE.md"), block(source));
    session("103-uno-plan-exec");

    const env = new FakeEnv(home, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), home, workspace);
    deps = { fs: new NodeFileSystem(), env, git: new GitCliAdapter(new NodeProcess()), paths };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates the unit at its conventional path, on its own branch, leaving the checkout untouched", async () => {
    const unit = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;

    expect(unit.created).toBe(true);
    expect(unit.branch).toBe("aw/103-uno-plan-exec");
    expect(unit.path).toBe(
      join(
        realpathSync(join(home, ".workflow", "worktrees")),
        workspaceKey(workspace),
        "acme",
        "103-uno-plan-exec",
      ),
    );
    // git's own view is the registry: the unit is there, on its branch.
    expect(git(source, "worktree", "list", "--porcelain")).toContain(
      "branch refs/heads/aw/103-uno-plan-exec",
    );
    // The main checkout never moved.
    expect(git(source, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(readFileSync(join(unit.path, "README.md"), "utf-8")).toBe("hola\n");
  });

  it("is idempotent: a second ensure returns the same unit and creates no second tree", async () => {
    const first = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;
    const second = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;

    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    const trees = git(source, "worktree", "list", "--porcelain").match(/^worktree /gm) ?? [];
    expect(trees).toHaveLength(2); // the checkout + one unit
  });

  it("rejects an occupied unit naming its occupant, before touching anything", async () => {
    await runWorktree(deps, { action: "ensure", alias: "acme", sessionCode: "103" });
    // Another flow whose branch is already checked out somewhere else: git holds
    // the invariant, we only have to report it.
    const stolen = join(root, "otro-arbol");
    git(source, "worktree", "add", "--detach", stolen);
    git(source, "worktree", "remove", stolen);

    session("104-dos-plan-exec");
    git(source, "branch", "aw/104-dos-plan-exec");
    git(source, "worktree", "add", join(root, "ocupado"), "aw/104-dos-plan-exec");

    const rejected = await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "104",
    });

    expect(rejected).toMatchObject({ error: "unit_occupied" });
    expect((rejected as { occupant: { path: string } }).occupant.path).toContain("ocupado");
  });

  it("lists this workspace's units and reports the ones whose session no longer lives", async () => {
    await runWorktree(deps, { action: "ensure", alias: "acme", sessionCode: "103" });
    session("104-dos-plan-exec");
    await runWorktree(deps, { action: "ensure", alias: "acme", sessionCode: "104" });
    writeFileSync(join(workspace, ".workflow", "sessions", "104-dos-plan-exec", ".closed"), "");

    const listed = (await runWorktree(deps, { action: "list" })) as WorktreeListOutput;

    expect(listed.units.map((u) => u.session)).toEqual(["103-uno-plan-exec"]);
    expect(listed.orphans).toHaveLength(1);
    expect(listed.orphans[0]).toMatchObject({
      session: "104-dos-plan-exec",
      reason: "session_closed",
    });
    expect(listed.orphans[0]?.release).toContain("aw worktree release");
  });

  it("lists without creating the user worktree root", async () => {
    const unitsRoot = join(home, ".workflow", "worktrees");
    expect(existsSync(unitsRoot)).toBe(false);

    const listed = (await runWorktree(deps, { action: "list" })) as WorktreeListOutput;

    expect(listed.units).toEqual([]);
    expect(existsSync(unitsRoot)).toBe(false);
  });

  it("releases a clean unit and refuses one with uncommitted work", async () => {
    const unit = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;
    writeFileSync(join(unit.path, "nuevo.txt"), "sin commitear\n");

    const refused = await runWorktree(deps, {
      action: "release",
      alias: "acme",
      sessionCode: "103",
    });
    expect(refused).toMatchObject({ error: "unit_not_clean" });
    expect(readFileSync(join(unit.path, "nuevo.txt"), "utf-8")).toBe("sin commitear\n");

    git(unit.path, "add", "-A");
    git(unit.path, "commit", "-m", "trabajo del flujo");
    const released = (await runWorktree(deps, {
      action: "release",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeReleaseOutput;

    expect(released.released).toBe(true);
    expect(git(source, "worktree", "list", "--porcelain")).not.toContain("aw/103-uno-plan-exec");
  });

  it("gives the unit multi-root visibility on ensure and takes it back on release", async () => {
    const settings = join(workspace, ".claude", "settings.local.json");

    const unit = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;
    expect(unit.visibility).toBe("attached");
    expect(readFileSync(settings, "utf-8")).toContain(unit.path);

    const released = (await runWorktree(deps, {
      action: "release",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeReleaseOutput;
    expect(released.visibility).toBe("detached");
    expect(readFileSync(settings, "utf-8")).not.toContain(unit.path);
  });

  it("returns to the flow's own branch when it asks again after releasing", async () => {
    const first = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;
    writeFileSync(join(first.path, "hecho.txt"), "trabajo previo\n");
    git(first.path, "add", "-A");
    git(first.path, "commit", "-m", "trabajo previo");
    await runWorktree(deps, { action: "release", alias: "acme", sessionCode: "103" });

    const again = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;

    // The commits are still there: a re-ensure checks the branch out, it does not
    // recreate it from the base and silently drop the flow's work.
    expect(readFileSync(join(again.path, "hecho.txt"), "utf-8")).toBe("trabajo previo\n");
  });
});
