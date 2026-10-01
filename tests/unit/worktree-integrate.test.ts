import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  type WorktreeIntegrateSessionOutput,
  runWorktree,
} from "../../src/application/worktree-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function branchOf(hub: string, session: string): string {
  return `aw/${createHash("sha256").update(hub.replaceAll("\\", "/")).digest("hex").slice(0, 8)}/${session}`;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function block(sourcePath: string): string {
  return `<!-- WORKFLOW-HUB-START -->
## Hub

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
<!-- WORKFLOW-HUB-END -->
`;
}

describe("integración al cierre y visibilidad de los flujos concurrentes", () => {
  let root: string;
  let home: string;
  let hub: string;
  let source: string;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };

  function session(folder: string, closed = false): void {
    const dir = join(hub, ".workflow", "sessions", folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SESSION.md"), `# SESSION — ${folder}\n\n## Objective\nX\n`);
    if (closed) writeFileSync(join(dir, ".closed"), "");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-integrate-"));
    home = join(root, "home");
    hub = join(root, "ws");
    source = join(root, "acme");
    for (const d of [home, hub, source]) mkdirSync(d, { recursive: true });

    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.email", "t@example.com");
    git(source, "config", "user.name", "T");
    writeFileSync(join(source, "README.md"), "base\n");
    git(source, "add", "-A");
    git(source, "commit", "-m", "inicial");

    writeFileSync(join(hub, "CLAUDE.md"), block(source));
    mkdirSync(join(hub, ".workflow"), { recursive: true });
    session("103-uno-plan-exec");
    session("104-dos-plan-exec");

    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, hub),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("workflow"), home, hub),
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
    expect(conflicted).toMatchObject({
      alias: "acme",
      unit_path: second.path,
      merge_path: source,
      into: "main",
      branch: branchOf(hub, "104-dos-plan-exec"),
      integrated: false,
      released: false,
    });
    expect(conflicted.next).toContain(
      "aw worktree integrate --source acme --code 104-dos-plan-exec",
    );
    expect(conflicted.next).toContain(source);
    expect(conflicted.next).not.toMatch(/fix-git|merge --abort/);
    // La unidad SOBREVIVE: sus commits son la única copia de un lado del merge.
    expect(conflicted.released).toBe(false);
    expect(git(source, "worktree", "list", "--porcelain")).toContain(
      branchOf(hub, "104-dos-plan-exec"),
    );
    // El merge queda en curso para resolución externa; no hay abort automático.
    expect(git(source, "status", "--porcelain")).toContain("choque.txt");
    expect(git(source, "rev-parse", "--verify", "MERGE_HEAD").trim()).not.toBe("");
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

  it("integra sin mover el checkout cuando está en otra rama", async () => {
    const unit = await ensure("103");
    commitIn(unit.path, "uno.txt", "x\n", "trabajo");
    const committed = git(unit.path, "rev-parse", "HEAD");
    git(source, "checkout", "-b", "otra-rama");

    const result = await runWorktree(deps, {
      action: "integrate",
      alias: "acme",
      sessionCode: "103",
    });

    expect(result).toMatchObject({ integrated: true, into: "main", released: true });
    expect(git(source, "rev-parse", "main")).toBe(committed);
    expect(git(source, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("otra-rama");
  });

  it("rechaza una rama de rol divergente si el checkout está en otra rama", async () => {
    const unit = await ensure("103");
    commitIn(unit.path, "unidad.txt", "unidad\n", "trabajo");
    commitIn(source, "main.txt", "main\n", "base avanzada");
    git(source, "checkout", "-b", "otra-rama");
    const main = git(source, "rev-parse", "main");
    const result = await runWorktree(deps, {
      action: "integrate",
      alias: "acme",
      sessionCode: "103",
    });
    expect(result).toMatchObject({ error: "checkout_off_branch" });
    expect(git(source, "rev-parse", "main")).toBe(main);
    expect(existsSync(unit.path)).toBe(true);
  });

  it("aw status lleva la unidad por sesión activa y las huérfanas con su acción", async () => {
    await ensure("103");
    await ensure("104");
    writeFileSync(join(hub, ".workflow", "sessions", "104-dos-plan-exec", ".closed"), "");

    const status = await runStatusCommand(deps.fs, deps.env, deps.paths, { git: deps.git });

    const live = status.sessions.active.find((s) => s.folder === "103-uno-plan-exec");
    expect(live?.units).toEqual([
      expect.objectContaining({ alias: "acme", branch: branchOf(hub, "103-uno-plan-exec") }),
    ]);
    expect(status.orphan_units).toHaveLength(1);
    expect(status.orphan_units[0]).toMatchObject({
      session: "104-dos-plan-exec",
      reason: "session_closed",
    });
    expect(status.orphan_units[0]?.release).toContain("aw worktree reclaim");
  });

  it("sin puerto git, aw status devuelve exactamente la salida de antes", async () => {
    await ensure("103");

    const status = await runStatusCommand(deps.fs, deps.env, deps.paths);

    expect(status.orphan_units).toEqual([]);
    for (const s of status.sessions.active) expect(s.units).toEqual([]);
  });
});

describe("integrar una sesión entera: el residuo se recoge al terminar", () => {
  const ALIASES = ["alfa", "beta", "gamma"] as const;
  let root: string;
  let home: string;
  let hub: string;
  let sources: Record<string, string>;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };

  function multiBlock(paths: Record<string, string>): string {
    const rows = ALIASES.map((a) => `| ${a} | ${paths[a]} | main |`).join("\n");
    const work = ALIASES.map((a) => `  - ${a}: main`).join("\n");
    return `<!-- WORKFLOW-HUB-START -->
## Hub

Test.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
${rows}

## Stack

_Stack sin detectar._

## Status

- Ramas de trabajo actuales:
${work}
- Última actividad: 2026-08-07
- Histórico: \`.workflow/HISTORY.md\`
<!-- WORKFLOW-HUB-END -->
`;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-integrate-multi-"));
    home = join(root, "home");
    hub = join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(hub, { recursive: true });
    sources = {};
    for (const alias of ALIASES) {
      const path = join(root, alias);
      mkdirSync(path, { recursive: true });
      git(path, "init", "--initial-branch=main");
      git(path, "config", "user.email", "t@example.com");
      git(path, "config", "user.name", "T");
      writeFileSync(join(path, "choque.txt"), "base\n");
      git(path, "add", "-A");
      git(path, "commit", "-m", "inicial");
      sources[alias] = path;
    }
    writeFileSync(join(hub, "CLAUDE.md"), multiBlock(sources));
    const dir = join(hub, ".workflow", "sessions", "103-uno-plan-exec");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SESSION.md"), "# SESSION — 103-uno-plan-exec\n");

    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, hub),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("workflow"), home, hub),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("integra las tres en orden de alias, conserva la que choca y recoge las limpias que quedaron", async () => {
    const units: Record<string, string> = {};
    for (const alias of ALIASES) {
      const unit = (await runWorktree(deps, {
        action: "ensure",
        alias,
        sessionCode: "103",
      })) as WorktreeEnsureOutput;
      units[alias] = unit.path;
      writeFileSync(join(unit.path, "choque.txt"), `unidad ${alias}\n`);
      git(unit.path, "add", "-A");
      git(unit.path, "commit", "-m", `trabajo en ${alias}`);
    }
    // Sólo `beta` va a chocar: su checkout movió el mismo archivo por su cuenta.
    writeFileSync(join(sources.beta as string, "choque.txt"), "el checkout de beta\n");
    git(sources.beta as string, "add", "-A");
    git(sources.beta as string, "commit", "-m", "beta se movió sola");

    const result = (await runWorktree(deps, {
      action: "integrate",
      sessionCode: "103",
    })) as WorktreeIntegrateSessionOutput;

    // Nada se aborta por un vecino: las tres se intentaron, en orden de alias.
    expect(result.results).toHaveLength(3);
    expect(result.integrated).toEqual(["alfa", "gamma"]);
    expect(result.pending).toEqual(["beta"]);
    expect(result.next).toContain("aw worktree integrate --source beta --code 103-uno-plan-exec");
    // La unidad que choca SOBREVIVE: sus commits son el único lado suyo del merge.
    expect(git(sources.beta as string, "worktree", "list", "--porcelain")).toContain(
      branchOf(hub, "103-uno-plan-exec"),
    );
    expect(readFileSync(join(units.beta as string, "choque.txt"), "utf-8")).toBe("unidad beta\n");
    // Y la recogida del cierre no la tocó, porque lo suyo no está en la rama de trabajo.
    expect(result.retained.map((u) => u.alias)).toEqual(["beta"]);
    expect(result.retained[0]?.reason).toBe("commits_outside_work_branch");
    // Las limpias ya se habían liberado al integrar: no queda residuo que barrer.
    expect(result.reclaimed).toEqual([]);
    for (const alias of ["alfa", "gamma"] as const) {
      expect(git(sources[alias] as string, "worktree", "list", "--porcelain")).not.toContain(
        "aw/103-uno-plan-exec",
      );
      expect(readFileSync(join(sources[alias] as string, "choque.txt"), "utf-8")).toBe(
        `unidad ${alias}\n`,
      );
    }
  });

  it("recoge al terminar la unidad que no tenía nada que la rama de trabajo no tuviera ya", async () => {
    const unit = (await runWorktree(deps, {
      action: "ensure",
      alias: "alfa",
      sessionCode: "103",
    })) as WorktreeEnsureOutput;
    // La sesión tomó la unidad de alfa y nunca la editó. Integrar con el checkout
    // en otra rama reconoce que la base ya contiene la unidad y la libera.
    git(sources.alfa as string, "checkout", "-b", "otra-rama");

    const result = (await runWorktree(deps, {
      action: "integrate",
      sessionCode: "103",
    })) as WorktreeIntegrateSessionOutput;

    expect(result.results[0]).toMatchObject({ integrated: true, alias: "alfa", released: true });
    expect(result.reclaimed).toEqual([]);
    expect(result.retained).toEqual([]);
    // No queda unidad que sostener ni integración pendiente.
    expect(result.pending).toEqual([]);
    expect(result.next).toBeNull();
    expect(existsSync(unit.path)).toBe(false);
    expect(git(sources.alfa as string, "worktree", "list", "--porcelain")).not.toContain(
      "aw/103-uno-plan-exec",
    );
  });
});
