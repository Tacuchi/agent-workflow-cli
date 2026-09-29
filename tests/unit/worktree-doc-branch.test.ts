import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { appendDocBranch } from "../../src/application/doc-branch-ledger.js";
import { PathsService } from "../../src/application/paths-service.js";
import { readCustody } from "../../src/application/session-custody-service.js";
import {
  type WorktreeDeps,
  type WorktreeEnsureOutput,
  runWorktree,
} from "../../src/application/worktree-service.js";
import { sealCustody } from "../../src/domain/session/custody.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repo: string, file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-qm", file);
  return git(repo, "rev-parse", "HEAD");
}

describe("unidad con rama propia del documento", () => {
  let root: string;
  let repo: string;
  let deps: WorktreeDeps;
  const session = "103-plan-plan-exec";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "worktree-doc-"));
    repo = join(root, "repo");
    const workspace = join(root, "workspace");
    mkdirSync(repo);
    mkdirSync(workspace);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "fixture@example.com");
    git(repo, "config", "user.name", "Fixture");
    commit(repo, "base.txt", "base\n");
    const main = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-qb", "feature/plan");
    commit(repo, "plan.txt", "plan\n");
    git(repo, "checkout", "-q", "main");
    expect(git(repo, "rev-parse", "main")).toBe(main);
    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `<!-- WORKFLOW-PROJECT-START -->
## Proyecto
Test.
## Fuentes
| Alias | Path | Rama principal |
|---|---|---|
| acme | ${repo} | main |
## Stack
_Stack sin detectar._
## Status
- Ramas de trabajo actuales:
  - acme: main
- Última actividad: 2026-09-27
<!-- WORKFLOW-PROJECT-END -->\n`,
    );
    const paths = new PathsService(normalizeNamespace("workflow"), root, workspace);
    const folder = join(paths.cwdSessionsDir(), session);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SESSION.md"), `# SESSION — ${session}\n`);
    writeFileSync(
      join(folder, ".custody.json"),
      JSON.stringify(
        sealCustody({
          subject: { kind: "session", key: session },
          subjectPath: folder,
          created: "2026-09-27",
          parents: [{ kind: "plan", key: "067" }],
        }),
      ),
    );
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    writeFileSync(join(workspace, "docs", "plans", "067-plan-rama.md"), "# Plan 067\n");
    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(root, workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
    await appendDocBranch(deps.fs, paths, {
      version: 1,
      at: "2026-09-27T00:00:00Z",
      doc: { kind: "plan", key: "067" },
      source: "acme",
      branch: "feature/plan",
      by: session,
      outcome: "existing",
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function ensure(): Promise<WorktreeEnsureOutput> {
    return (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;
  }
  async function integrate() {
    return runWorktree(deps, { action: "integrate", alias: "acme", sessionCode: "103" });
  }

  it("sella la base y avanza sólo esa rama, con checkout en otra rama y cambios intactos", async () => {
    const base = git(repo, "rev-parse", "feature/plan");
    const main = git(repo, "rev-parse", "main");
    const unit = await ensure();
    expect(unit.base).toBe("feature/plan");
    expect(git(unit.path, "rev-parse", "HEAD")).toBe(base);
    await appendDocBranch(deps.fs, deps.paths, {
      version: 1,
      at: "2026-09-27T01:00:00Z",
      doc: { kind: "plan", key: "067" },
      source: "acme",
      branch: "feature/cambiada",
      by: session,
      outcome: "existing",
    });
    const own = commit(unit.path, "work.txt", "unidad\n");
    git(repo, "checkout", "-qb", "feature/quick");
    const checkoutHead = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "uncommitted.txt"), "no tocar\n");
    const result = await integrate();
    expect(result).toMatchObject({ integrated: true, into: "feature/plan", released: true });
    expect(git(repo, "rev-parse", "feature/plan")).toBe(own);
    expect(git(repo, "rev-parse", "main")).toBe(main);
    expect(git(repo, "rev-parse", "HEAD")).toBe(checkoutHead);
    expect(git(repo, "branch", "--show-current")).toBe("feature/quick");
    expect(readFileSync(join(repo, "uncommitted.txt"), "utf8")).toBe("no tocar\n");
    expect(existsSync(unit.path)).toBe(false);
    const custody = await readCustody(deps.fs, join(deps.paths.cwdSessionsDir(), session));
    expect(custody.status).toBe("present");
    if (custody.status === "present") {
      expect(custody.custody.sources[0]?.base_branch).toBe("feature/plan");
      expect(
        custody.custody.effects.find((effect) => effect.kind === "unit_integrated"),
      ).toMatchObject({ before: base, after: own, ref: "refs/heads/feature/plan" });
    }
  });

  it("si la base avanza, la mezcla en la unidad antes del CAS y conserva ambas historias", async () => {
    const unit = await ensure();
    const own = commit(unit.path, "work.txt", "unidad\n");
    git(repo, "checkout", "-q", "feature/plan");
    const other = commit(repo, "other.txt", "otro\n");
    git(repo, "checkout", "-q", "main");
    const result = await integrate();
    expect(result).toMatchObject({ integrated: true, into: "feature/plan" });
    const tip = git(repo, "rev-parse", "feature/plan");
    expect(git(repo, "merge-base", "--is-ancestor", own, tip)).toBe("");
    expect(git(repo, "merge-base", "--is-ancestor", other, tip)).toBe("");
    expect(git(repo, "rev-parse", "main")).not.toBe(tip);
  });

  it("el conflicto de la base queda en la unidad, con el remedio sobre su ruta", async () => {
    const unit = await ensure();
    commit(unit.path, "plan.txt", "unidad\n");
    git(repo, "checkout", "-q", "feature/plan");
    const base = commit(repo, "plan.txt", "otra versión\n");
    git(repo, "checkout", "-q", "main");
    const result = await integrate();
    expect(result).toMatchObject({
      integrated: false,
      released: false,
      into: "feature/plan",
      conflicted: ["plan.txt"],
      unit_path: unit.path,
      merge_path: unit.path,
    });
    if (!("next" in result)) throw new Error("sin reintento");
    expect(result.next).toContain("resolvé externamente");
    expect(result.next).toContain("aw worktree integrate --source acme");
    expect(git(repo, "rev-parse", "feature/plan")).toBe(base);
    expect(existsSync(unit.path)).toBe(true);
  });

  it("rehúsa destino ausente, ocupado y carrera CAS sin soltar la unidad", async () => {
    const unit = await ensure();
    commit(unit.path, "work.txt", "unidad\n");
    git(repo, "branch", "-D", "feature/plan");
    expect(await integrate()).toMatchObject({ error: "target_missing" });
    git(repo, "branch", "feature/plan", git(repo, "rev-parse", "main"));
    const occupiedPath = join(root, "occupied");
    git(repo, "worktree", "add", "-q", occupiedPath, "feature/plan");
    expect(await integrate()).toMatchObject({ error: "target_occupied" });
    git(repo, "worktree", "remove", occupiedPath);
    const original = deps.git;
    deps.git = Object.assign(Object.create(original) as GitCliAdapter, {
      updateRefCas: async () => ({ ok: false, why: "raced" }),
    });
    expect(await integrate()).toMatchObject({ error: "integration_raced" });
    expect(existsSync(unit.path)).toBe(true);
  });

  it("recoge una unidad ya contenida en su base sellada aunque main no la contenga", async () => {
    const unit = await ensure();
    const own = commit(unit.path, "work.txt", "unidad\n");
    const main = git(repo, "rev-parse", "main");
    git(repo, "branch", "-f", "feature/plan", own);
    writeFileSync(join(deps.paths.cwdSessionsDir(), session, ".closed"), "");
    const swept = await runWorktree(deps, { action: "reclaim", alias: "acme" });
    expect(swept).toMatchObject({
      reclaimed: [{ session, reason: "session_closed" }],
      retained: [],
    });
    expect(existsSync(unit.path)).toBe(false);
    expect(git(repo, "rev-parse", "main")).toBe(main);
    expect(git(repo, "rev-parse", "feature/plan")).toBe(own);
  });

  it("si la unidad ya está contenida, integrar no registra un segundo efecto", async () => {
    const unit = await ensure();
    git(repo, "checkout", "-qb", "feature/quick");
    const result = await integrate();
    expect(result).toMatchObject({ integrated: true, released: true, into: "feature/plan" });
    const custody = await readCustody(deps.fs, join(deps.paths.cwdSessionsDir(), session));
    if (custody.status !== "present") throw new Error("custodia ausente");
    expect(custody.custody.effects.filter((effect) => effect.kind === "unit_integrated")).toEqual(
      [],
    );
    expect(existsSync(unit.path)).toBe(false);
  });

  it("en dos fuentes sólo la que declaró rama propia nace de ella", async () => {
    const second = join(root, "second");
    mkdirSync(second);
    git(second, "init", "-q", "-b", "main");
    git(second, "config", "user.email", "fixture@example.com");
    git(second, "config", "user.name", "Fixture");
    const secondHead = commit(second, "base.txt", "segundo\n");
    const workspace = deps.paths.workspaceDir();
    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `<!-- WORKFLOW-PROJECT-START -->
## Proyecto
Test.
## Fuentes
| Alias | Path | Rama principal |
|---|---|---|
| acme | ${repo} | main |
| beta | ${second} | main |
## Stack
_Stack sin detectar._
## Status
- Ramas de trabajo actuales:
  - acme: main
  - beta: main
- Última actividad: 2026-09-27
<!-- WORKFLOW-PROJECT-END -->\n`,
    );
    const own = await ensure();
    const defaultUnit = (await runWorktree(deps, {
      action: "ensure",
      alias: "beta",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;
    expect(own.base).toBe("feature/plan");
    expect(defaultUnit.base).toBe("main");
    expect(git(defaultUnit.path, "rev-parse", "HEAD")).toBe(secondHead);
  });
});
