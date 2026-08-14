import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type ApplyDeps,
  applyRetirement,
  recoverPendingRetirements,
} from "../../src/application/retirement/apply.js";
import {
  journalDir,
  openJournal,
  quarantinePath,
  writeJournal,
} from "../../src/application/retirement/journal.js";
import { prepareRetirement } from "../../src/application/retirement/prepare.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { recordCommit, recordUnitTaken } from "../../src/application/session-custody-recorder.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { runWorktree } from "../../src/application/worktree-service.js";
import type { RetirementProposal } from "../../src/domain/retirement/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

const PLAN_OPEN =
  "# Plan 024 — algo\n\n> Derived from docs/specs/025-spec-algo.md\n> Estado: open\n\n## Tasks\n\n### F1 — hacer\n> Estado: pendiente\n\n- [ ] T1.1 — algo\n";
const SPEC = "---\nstatus: ready-for-plan\n---\n\n# Spec 025 — algo\n";

function block(sourcePath: string): string {
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

Retiro.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| acme | ${sourcePath} | main |

## Status

- Ramas de trabajo actuales:
  - acme: main
<!-- WORKFLOW-PROJECT-END -->
`;
}

/**
 * Real git and a real filesystem, and every mid-state reconstructed rather than
 * mocked: what is under test is that a process which DIED somewhere leaves exactly
 * one of two stable worlds, and a fake filesystem could not tell us that.
 */
describe("coordinador de retiro — dos estados estables y una sola huella", () => {
  let root: string;
  let workspace: string;
  let source: string;
  let paths: PathsService;
  let deps: ApplyDeps;
  const fs = new NodeFileSystem();
  const planPath = "docs/plans/024-plan-algo.md";

  /** A fresh deps object: the closest a unit test gets to "another process". */
  function newProcess(): ApplyDeps {
    return {
      fs: new NodeFileSystem(),
      env: new FakeEnv(join(root, "home"), workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("workflow"), join(root, "home"), workspace),
    };
  }

  async function session(name: string, inputs: string[] = []): Promise<string> {
    const result = await runSessionCreate(fs, paths, {
      type: name.endsWith("-quick") ? "quick" : "exec",
      name,
      objetivo: "o",
      ...(inputs.length > 0 ? { inputs } : {}),
    });
    if ("error" in result) throw new Error(result.error);
    return result.sessionCreate.folder;
  }

  async function proposalFor(
    mode: "discard" | "reset",
    target: string,
  ): Promise<RetirementProposal> {
    const prepared = await prepareRetirement(deps, { mode, target });
    if (!prepared.ok) throw new Error(`rechazo inesperado: ${prepared.rejection.message}`);
    return prepared.proposal;
  }

  function history(): string {
    const path = paths.cwdHistoryFile();
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  }

  function rowsFor(digest: string): number {
    return history()
      .split("\n")
      .filter((l) => l.includes(`| ${digest.slice(0, 12)} |`)).length;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "apply-"));
    workspace = join(root, "ws");
    source = join(root, "acme");
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    mkdirSync(join(workspace, "docs", "specs"), { recursive: true });
    mkdirSync(join(workspace, ".workflow", "sessions"), { recursive: true });
    mkdirSync(source, { recursive: true });
    git(source, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(source, "base.txt"), "base\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "inicial");

    writeFileSync(join(workspace, "CLAUDE.md"), block(source));
    writeFileSync(join(workspace, "docs", "specs", "025-spec-algo.md"), SPEC);
    writeFileSync(join(workspace, planPath), PLAN_OPEN);

    paths = new PathsService(normalizeNamespace("workflow"), join(root, "home"), workspace);
    deps = {
      fs,
      env: new FakeEnv(join(root, "home"), workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("aplica un discard completo y deja UNA huella, sin journal ni cuarentena", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const proposal = await proposalFor("discard", "plan:024");

    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Nada de la clausura sigue en pie.
    expect(existsSync(join(workspace, planPath))).toBe(false);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(false);
    // Y la única superficie durable propia de Workline es la fila de HISTORY.
    expect(rowsFor(proposal.digest)).toBe(1);
    expect(history()).toContain("## Retiros");
    expect(history()).toContain("plan:024");
    // Ni journal, ni cuarentena, ni ref privado.
    expect(existsSync(quarantinePath(paths, proposal.digest))).toBe(false);
    expect(existsSync(join(journalDir(paths), `${proposal.digest}.json`))).toBe(false);
    expect(outcome.result.already_applied).toBe(false);
    // La spec que NO estaba en el alcance sigue intacta.
    expect(existsSync(join(workspace, "docs", "specs", "025-spec-algo.md"))).toBe(true);
  });

  it("aplica un reset devolviendo la entrada a sus bytes previos byte por byte", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    // La sesión avanzó el plan.
    writeFileSync(join(workspace, planPath), PLAN_OPEN.replace("- [ ] T1.1", "- [x] T1.1"));
    const proposal = await proposalFor("reset", planPath);

    const outcome = await applyRetirement(deps, {
      mode: "reset",
      target: planPath,
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(readFileSync(join(workspace, planPath), "utf-8")).toBe(PLAN_OPEN);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(false);
    expect(outcome.result.restored).toEqual([planPath]);
    expect(rowsFor(proposal.digest)).toBe(1);
  });

  it("una aprobación que no es la del alcance vigente no toca nada", async () => {
    await session("algo-plan-exec", [planPath]);
    const before = readFileSync(join(workspace, planPath), "utf-8");

    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: "0".repeat(64),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.message).toContain("lo aprobado no es lo que se aplicaría");
    expect(readFileSync(join(workspace, planPath), "utf-8")).toBe(before);
    expect(history()).not.toContain("## Retiros");
    expect(existsSync(journalDir(paths))).toBe(false);
  });

  it("un artefacto que cambió después de la vista previa bloquea con cero efectos", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const proposal = await proposalFor("reset", planPath);
    // Alguien edita el plan DESPUÉS de sellar la propuesta.
    writeFileSync(join(workspace, planPath), `${PLAN_OPEN}\n<!-- editado a mano -->\n`);

    const outcome = await applyRetirement(deps, {
      mode: "reset",
      target: planPath,
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // El digest cambia con los bytes, así que el rechazo llega por el sello.
    expect(outcome.rejection.code).toBe("EVIDENCE_MISSING");
    expect(readFileSync(join(workspace, planPath), "utf-8")).toContain("editado a mano");
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(true);
    expect(history()).not.toContain("## Retiros");
  });

  it("un ref que se movió entre preparar y aplicar bloquea sin dejar huella", async () => {
    const unit = join(root, "unit");
    const folder = await session("algo-plan-exec", [planPath]);
    git(source, "worktree", "add", "--quiet", "-b", `aw/${folder}`, unit);
    await recordUnitTaken(deps, folder, {
      alias: "acme",
      sourcePath: source,
      unitPath: unit,
      unitBranch: `aw/${folder}`,
      base: "main",
    });
    writeFileSync(join(unit, "trabajo.txt"), "de la sesión\n");
    git(unit, "add", "-A");
    const receipt = await deps.git.commit(unit, "trabajo");
    await recordCommit(deps, folder, "acme", receipt);

    const proposal = await proposalFor("discard", "plan:024");
    expect(proposal.publication).not.toBeNull();

    // Otro escritor mueve la rama de la unidad entre la vista previa y el apply.
    writeFileSync(join(unit, "ajeno.txt"), "otro\n");
    git(unit, "add", "-A");
    git(unit, "commit", "-q", "-m", "otro escritor");
    const moved = git(source, "rev-parse", `refs/heads/aw/${folder}`);

    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(false);
    // El ref quedó donde lo dejó el competidor y no hay fila de éxito.
    expect(git(source, "rev-parse", `refs/heads/aw/${folder}`)).toBe(moved);
    expect(history()).not.toContain("## Retiros");
    expect(existsSync(join(workspace, planPath))).toBe(true);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(true);
  });

  it("un proceso que murió ANTES del punto de commit: la reentrada descarta lo invisible", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const proposal = await proposalFor("discard", "plan:024");
    const planBefore = readFileSync(join(workspace, planPath), "utf-8");
    const refsBefore = git(source, "show-ref");

    // El mid-state real: journal escrito y cuarentena preparada, ref sin mover.
    const journal = openJournal({
      proposal,
      quarantine: quarantinePath(paths, proposal.digest),
      opened: "2026-08-13",
    });
    await writeJournal(fs, paths, journal);
    mkdirSync(journal.quarantine, { recursive: true });
    writeFileSync(join(journal.quarantine, "restore-0"), "algo a medio preparar\n");

    const recovery = await recoverPendingRetirements(newProcess());
    expect(recovery.recovered).toEqual([
      { digest: proposal.digest, outcome: "rolled-back", target: "plan:024" },
    ]);
    // Estado observable idéntico: nada de esto llegó a existir para nadie.
    expect(readFileSync(join(workspace, planPath), "utf-8")).toBe(planBefore);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(true);
    expect(git(source, "show-ref")).toBe(refsBefore);
    expect(existsSync(journal.quarantine)).toBe(false);
    expect(history()).not.toContain("## Retiros");
  });

  it("un proceso que murió DESPUÉS del punto de commit: la reentrada termina y el ref no vuelve atrás", async () => {
    const unit = join(root, "unit");
    const folder = await session("algo-plan-exec", [planPath]);
    git(source, "worktree", "add", "--quiet", "-b", `aw/${folder}`, unit);
    await recordUnitTaken(deps, folder, {
      alias: "acme",
      sourcePath: source,
      unitPath: unit,
      unitBranch: `aw/${folder}`,
      base: "main",
    });
    writeFileSync(join(unit, "trabajo.txt"), "de la sesión\n");
    git(unit, "add", "-A");
    const receipt = await deps.git.commit(unit, "trabajo");
    await recordCommit(deps, folder, "acme", receipt);

    const proposal = await proposalFor("discard", "plan:024");
    const publication = proposal.publication;
    expect(publication).not.toBeNull();
    if (publication === null) return;

    // El mid-state: el CAS YA pasó (el ref está en el tip preparado) y el
    // filesystem todavía no. Es el único estado que no tiene vuelta atrás.
    const journal = {
      ...openJournal({
        proposal,
        quarantine: quarantinePath(paths, proposal.digest),
        opened: "2026-08-13",
      }),
      phase: "committed" as const,
    };
    await writeJournal(fs, paths, journal);
    mkdirSync(journal.quarantine, { recursive: true });
    // Reconstruimos el resultado igual que lo haría el coordinador. El id del
    // commit NO tiene por qué coincidir con el del ensayo —lleva su timestamp—,
    // pero su ÁRBOL sí: es lo que la propuesta sella y lo que la reentrada compara.
    const tree = join(root, "rebuild");
    await deps.git.worktreeAddDetached(source, tree, publication.expected_old ?? "HEAD");
    for (const revert of proposal.reverts) {
      await deps.git.rehearseRevert(tree, revert.commit, revert.mainline);
      await deps.git.commitIn(tree, `revert ${revert.commit.slice(0, 12)} (aw retiro)`);
    }
    const rebuilt = await deps.git.refValue(tree, "HEAD");
    expect(rebuilt).not.toBeNull();
    expect(await deps.git.treeOf(tree, rebuilt ?? "")).toBe(publication.expected_tree);
    await deps.git.worktreeRemove(source, tree);
    expect(
      (
        await deps.git.updateRefCas(
          source,
          publication.ref,
          rebuilt ?? "",
          publication.expected_old,
        )
      ).ok,
    ).toBe(true);

    const recovery = await recoverPendingRetirements(newProcess());
    expect(recovery.recovered[0]?.outcome).toBe("completed");
    // El resultado quedó completo y el ref sigue adelante, nunca atrás.
    expect(existsSync(join(workspace, planPath))).toBe(false);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(false);
    expect(git(source, "rev-parse", publication.ref)).toBe(rebuilt);
    expect(await deps.git.treeOf(source, publication.ref)).toBe(publication.expected_tree);
    expect(rowsFor(proposal.digest)).toBe(1);
    // El commit original sigue alcanzable: se neutralizó, no se reescribió.
    expect(git(source, "cat-file", "-t", receipt.after)).toBe("commit");
    // Y una segunda reentrada no encuentra nada que hacer.
    expect((await recoverPendingRetirements(newProcess())).recovered).toEqual([]);
    expect(rowsFor(proposal.digest)).toBe(1);
  });

  it("la misma aprobación reintentada reconoce el evento y no duplica nada", async () => {
    await session("algo-plan-exec", [planPath]);
    const proposal = await proposalFor("discard", "plan:024");
    const first = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: proposal.digest,
    });
    expect(first.ok).toBe(true);

    // El objetivo ya no existe, así que el reintento ni siquiera resuelve — y eso
    // también es una respuesta honesta: no hay nada que retirar dos veces.
    const again = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: proposal.digest,
    });
    expect(again.ok).toBe(false);
    expect(rowsFor(proposal.digest)).toBe(1);
  });

  it("mientras exista un journal, el tablero declara la operación en vuelo", async () => {
    await session("algo-plan-exec", [planPath]);
    const proposal = await proposalFor("discard", "plan:024");
    await writeJournal(
      fs,
      paths,
      openJournal({
        proposal,
        quarantine: quarantinePath(paths, proposal.digest),
        opened: "2026-08-13",
      }),
    );

    const index = await buildWorklineIndex(fs, deps.env, paths, { git: deps.git });
    expect(index.pending_retirements).toEqual([
      {
        digest: proposal.digest,
        command: "discard",
        target: "plan:024",
        phase: "prepared",
        opened: "2026-08-13",
        next: `aw discard apply plan:024 --approval ${proposal.digest}`,
      },
    ]);
    // Y el plan sigue listado: nada se proyecta como retirado antes de estarlo.
    expect(index.plans.map((p) => p.number)).toContain("024");
  });

  it("devuelve la unidad de aislamiento de la sesión retirada, y reporta la que no puede", async () => {
    // La unidad se toma por el camino real (`aw worktree ensure`), porque sólo las
    // que viven en la ruta canónica son las que el tablero —y por lo tanto la
    // propuesta— reconocen como unidades de una sesión.
    const folder = await session("algo-plan-exec", [planPath]);
    const ensured = await runWorktree(
      { fs, env: deps.env, git: deps.git, paths },
      { action: "ensure", alias: "acme", sessionCode: folder },
    );
    if ("error" in ensured) throw new Error(`no se pudo tomar la unidad: ${ensured.message}`);
    expect(existsSync(ensured.path)).toBe(true);

    const proposal = await proposalFor("discard", "plan:024");
    expect(proposal.units).toEqual([
      { alias: "acme", session: folder, path: ensured.path, branch: `aw/${folder}`, repo: source },
    ]);

    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.units_released).toEqual([`acme:aw/${folder}`]);
    expect(outcome.result.pending_reconciliation).toEqual([]);
    expect(existsSync(ensured.path)).toBe(false);
    expect(git(source, "worktree", "list", "--porcelain")).not.toContain(folder);
    // La rama sobrevive: es la única alcanzabilidad de los commits de la sesión, y
    // borrarla los volvería inalcanzables. Retirar la unidad no es borrar historia.
    expect(git(source, "rev-parse", "--verify", `refs/heads/aw/${folder}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it("una unidad con trabajo sin commitear se REPORTA, nunca se fuerza", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const ensured = await runWorktree(
      { fs, env: deps.env, git: deps.git, paths },
      { action: "ensure", alias: "acme", sessionCode: folder },
    );
    if ("error" in ensured) throw new Error(`no se pudo tomar la unidad: ${ensured.message}`);
    // Trabajo sin commitear en la unidad: git se niega a removerla, y esa negativa
    // es la respuesta correcta.
    writeFileSync(join(ensured.path, "a-medio-hacer.txt"), "trabajo sin commitear\n");

    const proposal = await proposalFor("discard", "plan:024");
    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.units_released).toEqual([]);
    expect(outcome.result.pending_reconciliation).toEqual([`acme:aw/${folder}`]);
    expect(readFileSync(join(ensured.path, "a-medio-hacer.txt"), "utf-8")).toBe(
      "trabajo sin commitear\n",
    );
    // Y el retiro igual converge: la fila está, y lo que no se pudo dar de baja
    // queda declarado en el resultado en vez de forzado o silenciado.
    expect(rowsFor(proposal.digest)).toBe(1);
  });

  it("un lock de workspace ocupado bloquea sin tocar nada", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const proposal = await proposalFor("discard", "plan:024");
    const before = readFileSync(join(workspace, planPath), "utf-8");
    // Un holder vivo del lock del workspace: la sección crítica es inalcanzable, y
    // un retiro que empezara igual sería un retiro sin coordinación.
    mkdirSync(join(workspace, ".workflow"), { recursive: true });
    writeFileSync(
      join(workspace, ".workflow", ".lock"),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );

    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: "plan:024",
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.message).toContain("lock ocupado");
    expect(readFileSync(join(workspace, planPath), "utf-8")).toBe(before);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(true);
    expect(history()).not.toContain("## Retiros");
    expect(existsSync(journalDir(paths))).toBe(false);
  });
});
