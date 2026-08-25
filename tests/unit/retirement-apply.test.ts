import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { appendClaimEvent, readClaimEvents } from "../../src/application/claims-ledger.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type ApplyDeps,
  applyRetirement,
  recoverPendingRetirements,
} from "../../src/application/retirement/apply.js";
import { appendEvent, eventOf } from "../../src/application/retirement/history-events.js";
import {
  journalDir,
  openJournal,
  quarantinePath,
  writeJournal,
} from "../../src/application/retirement/journal.js";
import { prepareRetirement } from "../../src/application/retirement/prepare.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { recordPublication } from "../../src/application/session-custody-recorder.js";
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

  /**
   * The cancellation half of a reservation's life, run for real.
   *
   * Retiring a session IS cancelling it, so these are the tests that say the
   * retirement stopped abandoning correlatives — and, just as load-bearing, that
   * it only ever gives back the ones its own target was holding intact.
   */
  async function claim(owner: string, name: string, directory = "docs/specs"): Promise<string> {
    const result = await runNextNumber(fs, deps.env, paths, {
      directory,
      claim: { name, owner },
    });
    return `${directory}/${result.next}-${name}`;
  }

  async function ledgerEvents(): Promise<Array<{ event: string; path: string; owner: string }>> {
    const read = await readClaimEvents(fs, paths);
    return read.events.map((e) => ({
      event: e.event,
      path: `docs/${e.claim.category}/${e.claim.correlative}-${e.claim.name}`,
      owner: e.claim.owner,
    }));
  }

  it("retirar la sesión libera su reserva intacta y lo registra en el ledger", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const proposal = await proposalFor("discard", `session:${folder}`);

    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: `session:${folder}`,
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // El correlativo dejó de estar tomado y el retiro lo dice.
    expect(existsSync(join(workspace, held))).toBe(false);
    expect(outcome.result.reservations_released).toEqual([held]);
    expect(outcome.result.reservations_held).toEqual([]);
    // Y la huella sobrevive a la carpeta que la tenía: el ledger vive fuera.
    expect(await ledgerEvents()).toEqual([
      { event: "claimed", path: held, owner: folder },
      { event: "released", path: held, owner: folder },
    ]);
    // Una sola operación, una sola fila.
    expect(rowsFor(proposal.digest)).toBe(1);
  });

  it("no toca la reserva de otra sesión ni la que tiene el marcador dañado", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const other = await session("otro-plan-new");
    const damaged = await claim(folder, "spec-danada.md");
    const foreign = await claim(other, "spec-ajena.md");
    writeFileSync(join(workspace, damaged), "");
    const proposal = await proposalFor("discard", `session:${folder}`);

    const outcome = await applyRetirement(deps, {
      mode: "discard",
      target: `session:${folder}`,
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Bytes inciertos: el retiro los deja donde están y lo dice en su reporte.
    expect(existsSync(join(workspace, damaged))).toBe(true);
    expect(outcome.result.reservations_held).toEqual([damaged]);
    expect(outcome.result.reservations_released).toEqual([]);
    // La ajena sigue siendo de su dueño, y sin un solo registro nuevo sobre ella.
    expect(existsSync(join(workspace, foreign))).toBe(true);
    expect(await ledgerEvents()).toEqual([
      { event: "claimed", path: damaged, owner: folder },
      { event: "claimed", path: foreign, owner: other },
    ]);
  });

  it("un retiro que se deshace antes del punto de commit no libera ningún correlativo", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const proposal = await proposalFor("discard", `session:${folder}`);
    const before = await ledgerEvents();

    // El mid-state real: journal escrito, ref sin mover, punto de commit sin pasar.
    const journal = openJournal({
      proposal,
      quarantine: quarantinePath(paths, proposal.digest),
      opened: "2026-08-24",
    });
    await writeJournal(fs, paths, journal);
    mkdirSync(journal.quarantine, { recursive: true });

    const recovery = await recoverPendingRetirements(newProcess());

    expect(recovery.recovered).toEqual([
      { digest: proposal.digest, outcome: "rolled-back", target: `session:${folder}` },
    ]);
    // La liberación vive DENTRO de la transacción: si el retiro no ocurre,
    // tampoco ocurre ella — ni el borrado ni el registro.
    expect(existsSync(join(workspace, held))).toBe(true);
    expect(await ledgerEvents()).toEqual(before);
  });

  it("un retiro que falla antes del punto de commit no libera ningún correlativo", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const proposal = await proposalFor("discard", `session:${folder}`);

    // La cuarentena no se puede preparar: el retiro se cae ANTES del punto de
    // commit y hace rollback. Es el estado en el que, por contrato, nada
    // observable llegó a tocarse — y un correlativo devuelto es observable.
    const real = new NodeFileSystem();
    const brittle = new Proxy(real, {
      get(target, prop) {
        if (prop === "mkdirp") {
          return async (path: string): Promise<void> => {
            if (path.endsWith(".quarantine")) throw new Error("ENOSPC simulado");
            return target.mkdirp(path);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const outcome = await applyRetirement(
      { ...newProcess(), fs: brittle },
      { mode: "discard", target: `session:${folder}`, approval: proposal.digest },
    );

    expect(outcome.ok).toBe(false);
    // La liberación vive DENTRO de la transacción y DESPUÉS de su punto de
    // commit: un retiro que no ocurrió no devuelve ningún número, ni en disco
    // ni en el ledger.
    expect(existsSync(join(workspace, held))).toBe(true);
    expect((await ledgerEvents()).some((e) => e.event === "released")).toBe(false);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(true);
  });

  it("terminar dos veces el mismo retiro no agrega un segundo registro de liberación", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const proposal = await proposalFor("discard", `session:${folder}`);

    const first = await applyRetirement(deps, {
      mode: "discard",
      target: `session:${folder}`,
      approval: proposal.digest,
    });
    expect(first.ok).toBe(true);

    // Un journal que reaparece: un proceso que pasó el punto de commit y murió
    // creyendo que le faltaba trabajo. La reentrada TERMINA, nunca reempieza.
    await writeJournal(fs, paths, {
      ...openJournal({
        proposal,
        quarantine: quarantinePath(paths, proposal.digest),
        opened: "2026-08-24",
      }),
      phase: "committed" as const,
    });
    const recovery = await recoverPendingRetirements(newProcess());

    expect(recovery.recovered[0]?.outcome).toBe("completed");
    // El ledger es append-only: una liberación que se registrara dos veces sería
    // una historia que dice que el mismo correlativo volvió dos veces.
    expect((await ledgerEvents()).filter((e) => e.event === "released")).toEqual([
      { event: "released", path: held, owner: folder },
    ]);
    expect(rowsFor(proposal.digest)).toBe(1);
  });

  it("el correlativo que el retiro libera vuelve al conjunto elegible", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const correlative = held.slice("docs/specs/".length, "docs/specs/".length + 3);
    const proposal = await proposalFor("discard", `session:${folder}`);

    await applyRetirement(deps, {
      mode: "discard",
      target: `session:${folder}`,
      approval: proposal.digest,
    });
    const next = await runNextNumber(fs, deps.env, paths, {
      directory: "docs/specs",
      claim: { name: "spec-otra.md", owner: await session("nuevo-spec-new") },
    });

    // Liberado y nunca publicado: el hueco se vuelve a llenar en vez de perderse.
    expect(next.next).toBe(correlative);
  });

  it("una reserva cuyos bytes cambiaron DESPUÉS del sello no se libera al terminar", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const proposal = await proposalFor("discard", `session:${folder}`);
    // El sello dice que estaba intacta, y lo estaba cuando se selló.
    expect(proposal.reservations[0]?.intact).toBe(true);

    // El punto de commit ya pasó —la fila está en HISTORY— y el proceso murió
    // antes de completar. Entre ese momento y la reentrada, alguien escribió ahí.
    await appendEvent(fs, paths, eventOf(proposal, new Date()));
    await writeJournal(fs, paths, {
      ...openJournal({
        proposal,
        quarantine: quarantinePath(paths, proposal.digest),
        opened: "2026-08-24",
      }),
      phase: "committed" as const,
    });
    writeFileSync(join(workspace, held), "# trabajo de alguien\n");

    const recovery = await recoverPendingRetirements(newProcess());

    expect(recovery.recovered[0]?.outcome).toBe("completed");
    // La reentrada NO vuelve a preparar ni compara digests: si se fiara del sello
    // borraría trabajo. Los bytes se releen en el momento exacto de borrarlos.
    expect(readFileSync(join(workspace, held), "utf-8")).toBe("# trabajo de alguien\n");
    expect((await ledgerEvents()).some((e) => e.event === "released")).toBe(false);
  });

  it("registra la liberación ANTES de borrar el archivo", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const proposal = await proposalFor("discard", `session:${folder}`);

    // Un borrado que falla es el único modo de observar el ORDEN. Al revés, una
    // caída entre los dos pasos dejaría el correlativo libre sin una sola línea
    // que lo diga, que es el estado exacto que el ledger existe para terminar.
    const real = new NodeFileSystem();
    const brittle = new Proxy(real, {
      get(target, prop) {
        if (prop === "remove") {
          return async (path: string): Promise<void> => {
            if (path.endsWith("spec-mia.md")) throw new Error("EIO simulado");
            return target.remove(path);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const outcome = await applyRetirement(
      { ...newProcess(), fs: brittle },
      { mode: "discard", target: `session:${folder}`, approval: proposal.digest },
    );

    // Pasado el punto de commit no se falla: el slot que no se pudo liberar se
    // REPORTA y la operación termina igual, como hace la reconciliación de
    // unidades. Abortar acá dejaría a medias una completitud que ya se debe.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.reservations_held).toEqual([held]);
    expect(outcome.result.reservations_released).toEqual([]);

    // El archivo sigue ahí porque el borrado falló, y el registro YA está puesto:
    // sobre-declarar una liberación se reconcilia; una liberación muda, no.
    expect(existsSync(join(workspace, held))).toBe(true);
    expect((await ledgerEvents()).filter((e) => e.event === "released")).toEqual([
      { event: "released", path: held, owner: folder },
    ]);
    // Y la fila de HISTORY YA está: la liberación corre PASADO el punto de
    // commit, que en un retiro sin git ES esa fila. Antes de ella, este mismo
    // fallo habría devuelto un correlativo de una operación que la reentrada
    // lee como deshecha.
    expect(rowsFor(proposal.digest)).toBe(1);

    // Y por estar del lado bueno del punto de commit, se CURA sola: la reentrada
    // termina la liberación en vez de dejarla a medias, y sin duplicar el registro.
    await writeJournal(fs, paths, {
      ...openJournal({
        proposal,
        quarantine: quarantinePath(paths, proposal.digest),
        opened: "2026-08-24",
      }),
      phase: "committed" as const,
    });
    await recoverPendingRetirements(newProcess());
    expect(existsSync(join(workspace, held))).toBe(false);
    expect((await ledgerEvents()).filter((e) => e.event === "released")).toHaveLength(1);
  });

  it("si la fila de HISTORY no se puede escribir, el correlativo NO se libera", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-mia.md");
    const proposal = await proposalFor("discard", `session:${folder}`);

    // Este retiro no tiene lado git, así que su punto de commit ES la fila de
    // HISTORY. Hacerla fallar es la única forma de observar de qué lado del
    // punto de commit corre la liberación.
    const real = new NodeFileSystem();
    const brittle = new Proxy(real, {
      get(target, prop) {
        if (prop === "writeText") {
          return async (path: string, content: string): Promise<void> => {
            if (path.endsWith("HISTORY.md")) throw new Error("ENOSPC simulado");
            return target.writeText(path, content);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await applyRetirement(
      { ...newProcess(), fs: brittle },
      { mode: "discard", target: `session:${folder}`, approval: proposal.digest },
    ).catch(() => undefined);

    // El punto de commit no se pasó: la operación es, para toda reentrada, una
    // que no ocurrió. Devolver su correlativo igual lo pondría en el conjunto
    // elegible de otra sesión mientras esta sigue leyéndose como deshecha.
    expect(rowsFor(proposal.digest)).toBe(0);
    expect(existsSync(join(workspace, held))).toBe(true);
    expect((await ledgerEvents()).some((e) => e.event === "released")).toBe(false);
  });

  it("un reset devuelve el correlativo que su propia restauración vuelve a materializar", async () => {
    const folder = await session("algo-spec-new");
    const held = await claim(folder, "spec-mia.md");
    const marker = readFileSync(join(workspace, held), "utf-8");
    // La sesión completó su propia reserva: el destino se sella en custodia con
    // rol `input` y baseline = EL MARCADOR, y el ledger acredita `published`.
    writeFileSync(join(workspace, held), "---\nstatus: draft\n---\n\n# Spec\n");
    await recordPublication(deps, folder, [{ path: held, previous: marker }]);
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "published",
      claim: {
        category: "specs",
        correlative: held.slice(11, 14),
        name: "spec-mia.md",
        owner: folder,
      },
      cause: "el flujo completó su propia reserva",
    });

    const proposal = await proposalFor("reset", `session:${folder}`);
    // Enumerado ANTES de aprobar, no descubierto al aplicar.
    expect(proposal.reservations.map((r) => r.path)).toEqual([held]);

    const outcome = await applyRetirement(deps, {
      mode: "reset",
      target: `session:${folder}`,
      approval: proposal.digest,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Sin esto el reset restauraba el marcador sobre el documento y borraba a su
    // dueño: un archivo cuyo contenido entero es `<!-- aw:reserva … -->` que el
    // ledger ya marcó `published`, así que `slotOf` NO lo lee como slot y el
    // tablero lo contaba como una spec publicada. Ninguna superficie lo resolvía.
    expect(existsSync(join(workspace, held))).toBe(false);
    expect(outcome.result.reservations_released).toEqual([held]);
    const index = await buildWorklineIndex(fs, deps.env, paths, {});
    expect(index.specs.map((s) => s.file)).not.toContain(held);
    expect(index.reservations).toEqual([]);
  });

  it("una reserva sellada NO liberable jamás se reporta como liberada, ni si otro la borró", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const held = await claim(folder, "spec-danada.md");
    writeFileSync(join(workspace, held), "");
    const proposal = await proposalFor("discard", `session:${folder}`);
    expect(proposal.reservations[0]?.intact).toBe(false);

    // Entre el sello y el final, la recuperación sancionada la liberó de verdad.
    const journal = openJournal({
      proposal,
      quarantine: quarantinePath(paths, proposal.digest),
      opened: "2026-08-24",
    });
    await appendEvent(fs, paths, eventOf(proposal, new Date()));
    await writeJournal(fs, paths, { ...journal, phase: "committed" as const });
    rmSync(join(workspace, held));

    await recoverPendingRetirements(newProcess());

    // La vista previa dijo que NO la liberaba. Atribuirse el borrado de otro
    // convertiría el reporte en una afirmación falsa sobre un efecto destructivo.
    expect((await ledgerEvents()).some((e) => e.event === "released")).toBe(false);
  });
});
