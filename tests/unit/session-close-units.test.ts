import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import {
  type IsolationReader,
  type IsolationReleaser,
  runSessionClose,
} from "../../src/application/session-close-service.js";
import { birthCustody } from "../../src/application/session-custody-service.js";
import { classifyListedUnits, runWorktree } from "../../src/application/worktree-service.js";
import { git, worktreeFixture } from "../helpers/worktree-fixture.js";

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

describe("unidades del cierre final y del cierre reabrible", () => {
  function setup(sealed = true) {
    const f = worktreeFixture();
    dispose.push(f.dispose);
    if (sealed)
      writeFileSync(
        join(f.session, ".custody.json"),
        `${JSON.stringify(
          birthCustody({
            subject: { kind: "session", key: "101-test-plan-exec" },
            subjectPath: ".workflow/sessions/101-test-plan-exec",
            parents: [],
            artifacts: [],
            created: "2026-09-27",
          }),
        )}\n`,
      );
    const reader: IsolationReader = async () => {
      const listed = await runWorktree(f.deps, { action: "list" });
      if (!("units" in listed)) throw new Error("inventario ilegible");
      return {
        units: await classifyListedUnits(f.deps, listed.units),
        unreadable: listed.unreadable,
      };
    };
    const releaser: IsolationReleaser = async (alias, folder) => {
      const result = await runWorktree(f.deps, {
        action: "release",
        alias,
        sessionCode: folder,
      });
      if ("error" in result || "released" in result) return result;
      throw new Error("el servicio devolvió otra acción");
    };
    const close = (final = true, requireIntegrated = true) =>
      runSessionClose(
        f.deps.fs,
        f.deps.paths,
        { code: "101", final, requireIntegrated },
        reader,
        undefined,
        undefined,
        releaser,
      );
    return { ...f, reader, close };
  }

  it("libera la unidad vacía antes del cierre final y borra sólo su rama contenida", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    const result = await f.close();
    expect(result).toMatchObject({
      sessionClose: { released_empty: [expect.objectContaining({ alias: "acme" })] },
    });
    expect(existsSync(unit.path)).toBe(false);
    expect(git(f.repo, "branch", "--list", "aw/*")).toBe("");
    expect(existsSync(join(f.session, ".closed"))).toBe(true);
  });

  it("libera como preservada en origin y conserva la rama aw/* no contenida en la base", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    writeFileSync(join(unit.path, "work.txt"), "guardado\n");
    git(unit.path, "add", "work.txt");
    git(unit.path, "commit", "-m", "trabajo");
    git(f.repo, "update-ref", "refs/remotes/origin/feature", git(unit.path, "rev-parse", "HEAD"));
    const result = await f.close();
    expect(result).toMatchObject({
      sessionClose: {
        released_preserved: [
          expect.objectContaining({ preserved_in: "refs/remotes/origin/feature" }),
        ],
      },
    });
    expect(existsSync(unit.path)).toBe(false);
    expect(git(f.repo, "branch", "--list", "aw/*")).toContain("aw/");
  });

  it("distingue la unidad ya integrada en la base de otra rama que sólo la preserva", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    writeFileSync(join(unit.path, "integrated.txt"), "trabajo\n");
    git(unit.path, "add", "integrated.txt");
    git(unit.path, "commit", "-m", "integrado");
    git(f.repo, "merge", "--ff-only", unit.branch);
    git(f.repo, "branch", "aaaa-qa", git(f.repo, "rev-parse", "main"));
    const block = readFileSync(join(f.workspace, "CLAUDE.md"), "utf8");
    writeFileSync(
      join(f.workspace, "CLAUDE.md"),
      block.replace(
        "- Ramas de trabajo actuales:",
        "- Ramas QA actuales:\n  - acme: aaaa-qa\n- Ramas de trabajo actuales:",
      ),
    );
    expect(await f.close()).toMatchObject({
      sessionClose: { released_integrated: [expect.objectContaining({ alias: "acme" })] },
    });
    expect(git(f.repo, "branch", "--list", "aw/*")).toBe("");
  });

  it("los commits en QA declarada también están preservados", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    writeFileSync(join(unit.path, "qa.txt"), "guardado\n");
    git(unit.path, "add", "qa.txt");
    git(unit.path, "commit", "-m", "qa");
    git(f.repo, "branch", "qa", git(unit.path, "rev-parse", "HEAD"));
    const block = readFileSync(join(f.workspace, "CLAUDE.md"), "utf8");
    writeFileSync(
      join(f.workspace, "CLAUDE.md"),
      block.replace(
        "- Ramas de trabajo actuales:",
        "- Ramas QA actuales:\n  - acme: qa\n- Ramas de trabajo actuales:",
      ),
    );
    expect(await f.close()).toMatchObject({
      sessionClose: {
        released_preserved: [expect.objectContaining({ preserved_in: "refs/heads/qa" })],
      },
    });
  });

  it("con cambios sin commitear retiene la unidad, informa el motivo y conserva sus bytes", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    writeFileSync(join(unit.path, "draft.txt"), "sin commitear\n");
    expect(await f.close()).toMatchObject({
      sessionHeld: {
        pending_integration: [
          expect.objectContaining({ classification: "retained", reason: "cambios sin commitear" }),
        ],
      },
    });
    expect(readFileSync(join(unit.path, "draft.txt"), "utf8")).toBe("sin commitear\n");
    expect(existsSync(join(f.session, ".closed"))).toBe(false);
    expect(await f.close(true, false)).toMatchObject({
      sessionClose: {
        pending_integration: [expect.objectContaining({ classification: "retained" })],
      },
    });
    expect(readFileSync(join(unit.path, "draft.txt"), "utf8")).toBe("sin commitear\n");
  });

  it("commits sólo propios siguen pendientes, sin soltar su rama", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    writeFileSync(join(unit.path, "own.txt"), "sólo unidad\n");
    git(unit.path, "add", "own.txt");
    git(unit.path, "commit", "-m", "pendiente");
    expect(await f.close()).toMatchObject({
      sessionHeld: {
        pending_integration: [expect.objectContaining({ classification: "pending" })],
      },
    });
    expect(existsSync(unit.path)).toBe(true);
  });

  it("una operación git a medias queda retenida sin liberar la rama", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    f.deps.git = new (class extends GitCliAdapter {
      override async operationState(path: string) {
        return path === unit.path ? ("merge" as const) : super.operationState(path);
      }
    })(new NodeProcess());
    expect(await f.close()).toMatchObject({
      sessionHeld: {
        pending_integration: [
          expect.objectContaining({
            classification: "retained",
            reason: "operación git a medio resolver",
          }),
        ],
      },
    });
    expect(existsSync(unit.path)).toBe(true);
    expect(git(f.repo, "branch", "--list", "aw/*")).toContain("aw/");
  });

  it("sin base sellada ni rama declarada una unidad legacy no pasa por vacía", async () => {
    const f = setup(false);
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    const block = readFileSync(join(f.workspace, "CLAUDE.md"), "utf8");
    writeFileSync(
      join(f.workspace, "CLAUDE.md"),
      block.replace("- Ramas de trabajo actuales:\n  - acme: main\n", ""),
    );
    expect(await f.close()).toMatchObject({
      sessionHeld: {
        pending_integration: [expect.objectContaining({ classification: "pending" })],
      },
    });
    expect(existsSync(unit.path)).toBe(true);
  });

  it("a mitad del recorrido informa vacía sin soltarla ni contarla pendiente", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    expect(await f.close(false)).toMatchObject({
      sessionClose: { empty_units: [expect.objectContaining({ alias: "acme" })] },
    });
    expect(existsSync(unit.path)).toBe(true);
    expect(git(f.repo, "branch", "--list", "aw/*")).toContain("aw/");
  });

  it("a mitad del recorrido informa preservada sin soltarla ni pedir integrarla", async () => {
    const f = setup();
    const unit = await f.run("ensure");
    if (!("path" in unit)) throw new Error("no unit");
    writeFileSync(join(unit.path, "held.txt"), "remote\n");
    git(unit.path, "add", "held.txt");
    git(unit.path, "commit", "-m", "remote");
    git(f.repo, "update-ref", "refs/remotes/origin/feature", git(unit.path, "rev-parse", "HEAD"));
    const result = await f.close(false);
    expect(result).toMatchObject({
      sessionClose: { preserved_units: [expect.objectContaining({ alias: "acme" })] },
    });
    if ("sessionClose" in result) expect(result.sessionClose.pending_integration).toBeUndefined();
    expect(existsSync(unit.path)).toBe(true);
  });
});
