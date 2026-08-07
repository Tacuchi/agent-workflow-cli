import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import {
  type WorktreeEnsureOutput,
  type WorktreeIntegrateOutput,
  runWorktree,
} from "../../src/application/worktree-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

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

describe("integración al cierre y visibilidad de los flujos concurrentes", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let source: string;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };

  function session(folder: string, closed = false): void {
    const dir = join(workspace, ".workflow", "sessions", folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SESSION.md"), `# SESSION — ${folder}\n\n## Objective\nX\n`);
    if (closed) writeFileSync(join(dir, ".closed"), "");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-integrate-"));
    home = join(root, "home");
    workspace = join(root, "ws");
    source = join(root, "acme");
    for (const d of [home, workspace, source]) mkdirSync(d, { recursive: true });

    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.email", "t@example.com");
    git(source, "config", "user.name", "T");
    writeFileSync(join(source, "README.md"), "base\n");
    git(source, "add", "-A");
    git(source, "commit", "-m", "inicial");

    writeFileSync(join(workspace, "CLAUDE.md"), block(source));
    mkdirSync(join(workspace, ".workflow"), { recursive: true });
    session("103-uno-plan-exec");
    session("104-dos-plan-exec");

    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("workflow"), home, workspace),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function ensure(code: string): Promise<WorktreeEnsureOutput> {
    return (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: code,
    })) as WorktreeEnsureOutput;
  }

  async function integrate(code: string): Promise<WorktreeIntegrateOutput> {
    return (await runWorktree(deps, {
      action: "integrate",
      alias: "acme",
      sessionCode: code,
    })) as WorktreeIntegrateOutput;
  }

  function commitIn(unit: string, file: string, body: string, message: string): void {
    writeFileSync(join(unit, file), body);
    git(unit, "add", "-A");
    git(unit, "commit", "-m", message);
  }

  it("la segunda integración parte del estado que dejó la primera y conserva sus commits", async () => {
    const first = await ensure("103");
    const second = await ensure("104");
    commitIn(first.path, "uno.txt", "flujo uno\n", "trabajo del flujo uno");
    commitIn(second.path, "dos.txt", "flujo dos\n", "trabajo del flujo dos");

    const a = await integrate("103");
    const b = await integrate("104");

    expect(a.integrated).toBe(true);
    expect(b.integrated).toBe(true);
    // Los dos trabajos conviven en la rama de trabajo declarada: la segunda
    // integración partió de la rama viva, no de una foto anterior.
    expect(readFileSync(join(source, "uno.txt"), "utf-8")).toBe("flujo uno\n");
    expect(readFileSync(join(source, "dos.txt"), "utf-8")).toBe("flujo dos\n");
    expect(git(source, "log", "--oneline")).toContain("trabajo del flujo uno");
  });

  it("integra a la rama de TRABAJO declarada y libera la unidad", async () => {
    const unit = await ensure("103");
    commitIn(unit.path, "uno.txt", "x\n", "trabajo");

    const result = await integrate("103");

    expect(result.into).toBe("main");
    expect(result.released).toBe(true);
    expect(git(source, "worktree", "list", "--porcelain")).not.toContain("aw/103-uno-plan-exec");
  });

  it("reporta el conflicto con sus archivos, deja el merge en curso y CONSERVA la unidad", async () => {
    const first = await ensure("103");
    const second = await ensure("104");
    commitIn(first.path, "choque.txt", "version uno\n", "uno toca choque");
    commitIn(second.path, "choque.txt", "version dos\n", "dos toca choque");

    await integrate("103");
    const conflicted = await integrate("104");

    expect(conflicted.integrated).toBe(false);
    expect(conflicted.conflicted).toContain("choque.txt");
    expect(conflicted.next).toContain("aw fix-git --path");
    // La unidad SOBREVIVE: sus commits son la única copia de un lado del merge.
    expect(conflicted.released).toBe(false);
    expect(git(source, "worktree", "list", "--porcelain")).toContain("aw/104-dos-plan-exec");
    // Y el merge queda en curso, para que `aw fix-git` lo encuentre.
    expect(git(source, "status", "--porcelain")).toContain("choque.txt");
    expect(readFileSync(join(second.path, "choque.txt"), "utf-8")).toBe("version dos\n");
  });

  it("rechaza antes de tocar nada si la unidad tiene cambios sin commitear", async () => {
    const unit = await ensure("103");
    writeFileSync(join(unit.path, "suelto.txt"), "sin commitear\n");

    const refused = await runWorktree(deps, {
      action: "integrate",
      alias: "acme",
      sessionCode: "103",
    });

    expect(refused).toMatchObject({ error: "unit_not_committed" });
    expect(git(source, "log", "--oneline")).not.toContain("aw/103");
  });

  it("rechaza antes de tocar nada si el checkout principal está sucio", async () => {
    const unit = await ensure("103");
    commitIn(unit.path, "uno.txt", "x\n", "trabajo");
    writeFileSync(join(source, "local.txt"), "trabajo del usuario\n");

    const refused = await runWorktree(deps, {
      action: "integrate",
      alias: "acme",
      sessionCode: "103",
    });

    expect(refused).toMatchObject({ error: "checkout_dirty" });
    expect(readFileSync(join(source, "local.txt"), "utf-8")).toBe("trabajo del usuario\n");
  });

  it("rechaza —nunca cambia de rama sola— si el checkout está en otra rama", async () => {
    const unit = await ensure("103");
    commitIn(unit.path, "uno.txt", "x\n", "trabajo");
    git(source, "checkout", "-b", "otra-rama");

    const refused = await runWorktree(deps, {
      action: "integrate",
      alias: "acme",
      sessionCode: "103",
    });

    expect(refused).toMatchObject({ error: "checkout_off_branch" });
    expect(git(source, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("otra-rama");
  });

  it("aw status lleva la unidad por sesión activa y las huérfanas con su acción", async () => {
    await ensure("103");
    await ensure("104");
    writeFileSync(join(workspace, ".workflow", "sessions", "104-dos-plan-exec", ".closed"), "");

    const status = await runStatusCommand(deps.fs, deps.env, deps.paths, { git: deps.git });

    const live = status.sessions.active.find((s) => s.folder === "103-uno-plan-exec");
    expect(live?.units).toEqual([
      expect.objectContaining({ alias: "acme", branch: "aw/103-uno-plan-exec" }),
    ]);
    expect(status.orphan_units).toHaveLength(1);
    expect(status.orphan_units[0]).toMatchObject({
      session: "104-dos-plan-exec",
      reason: "session_closed",
    });
    expect(status.orphan_units[0]?.release).toContain("aw worktree release");
  });

  it("sin puerto git, aw status devuelve exactamente la salida de antes", async () => {
    await ensure("103");

    const status = await runStatusCommand(deps.fs, deps.env, deps.paths);

    expect(status.orphan_units).toEqual([]);
    for (const s of status.sessions.active) expect(s.units).toEqual([]);
  });
});
