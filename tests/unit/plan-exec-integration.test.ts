import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { prepareFixGit } from "../../src/application/fix-git-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import {
  type WorktreeIntegrateSessionOutput,
  type WorktreeListOutput,
  runWorktree,
} from "../../src/application/worktree-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";

/**
 * F3 — integración, recuperación y cierre son una sola convergencia.
 *
 * Lo que la fase tiene que demostrar no es que `worktree integrate` funcione:
 * funcionaba. Es que el recorrido no puede terminar dejando trabajo donde nadie
 * lo lee. Tres estados que antes eran alcanzables y acá dejan de serlo: sellar el
 * plan `done` con los commits todavía en `aw/<sesión>`, cerrar la sesión con una
 * unidad viva, y tratar un conflicto como una falla en vez de como el estado
 * activo que es.
 *
 * Todo corre sobre Git real porque el enunciado es sobre merges: que la segunda
 * integración parta de lo que dejó la primera, que un conflicto conserve las dos
 * mitades, y que al final no queden ni `MERGE_HEAD` ni unidades ni huérfanas.
 */

const ALIAS = "acme";
const COMPARTIDO = "src/compartido.ts";
const PROPIO_UNO = "src/uno.ts";
const PROPIO_DOS = "src/dos.ts";

const UNO = { code: "301", folder: "301-alpha-plan-exec", plan: "docs/plans/051-plan-alpha.md" };
const DOS = { code: "302", folder: "302-beta-plan-exec", plan: "docs/plans/052-plan-beta.md" };

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function block(sourcePath: string): string {
  return `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Convergencia de unidades.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| ${ALIAS} | ${sourcePath} | main |

## Status

- Ramas de trabajo actuales:
  - ${ALIAS}: main
<!-- AGENT-WORKFLOW-PROJECT-END -->
`;
}

describe("F3 — integración, recuperación y cierre son una sola convergencia", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let source: string;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };
  let walk: ReturnType<typeof planExecWalk>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-f3-"));
    home = join(root, "home");
    workspace = join(root, "ws");
    source = join(root, ALIAS);
    for (const dir of [home, workspace, source]) mkdirSync(dir, { recursive: true });

    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.email", "t@example.com");
    git(source, "config", "user.name", "T");
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, COMPARTIDO), "export const version = 0;\n");
    git(source, "add", "-A");
    git(source, "commit", "-m", "inicial");

    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("agent-workflow"), home, workspace),
    };
    walk = planExecWalk(deps, {
      sources: [ALIAS],
      // Una corrida que de verdad termina un plan las declara las tres: hay tareas
      // que marcar, hay algo sin commitear y el plan quedó cerrable. Sin ellas las
      // filas condicionadas se saltean, y un recorrido que "llegó" al final porque
      // se saltó el commit no prueba nada de esta fase.
      signals: ["plan.tasks-to-mark", "plan.commit-pending", "plan.plan-closable"],
    });

    writeFileSync(join(workspace, "CLAUDE.md"), block(source));
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    for (const run of [UNO, DOS]) {
      writeFileSync(
        join(workspace, run.plan),
        `# Plan ${run.code}\n\n> Límite de ejecución: checkout\n\n## Tasks\n\n### F1 — integración\n> Fuentes: ${ALIAS}\n\n- [ ] T1.1 — integrar la unidad _(fuentes: ${ALIAS})_\n`,
      );
      const dir = join(deps.paths.cwdSessionsDir(), run.folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SESSION.md"),
        `# SESSION — ${run.folder}\n\n## Objective\nejecutar ${run.plan}\n\n## Success criteria\n- [ ] la unidad se integra y se libera\n`,
      );
      writeFileSync(join(dir, "CHECKPOINT.md"), `# CHECKPOINT — ${run.folder}\n\n## Completed\n`);
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The run's own unit, obtained the way its journey obtains it. */
  async function unitOf(run: typeof UNO): Promise<string> {
    await walk.walkTo(run, "plan-exec.implementation");
    const listed = (await runWorktree(deps, { action: "list" })) as WorktreeListOutput;
    const unit = listed.units.find((entry) => entry.session === run.folder);
    if (unit === undefined) throw new Error(`${run.folder} no adquirió su unidad`);
    return unit.path;
  }

  function commitIn(unit: string, file: string, content: string, message: string): string {
    writeFileSync(join(unit, file), content);
    git(unit, "config", "user.email", "t@example.com");
    git(unit, "config", "user.name", "T");
    git(unit, "add", "-A");
    git(unit, "commit", "-m", message);
    return git(unit, "rev-parse", "HEAD").trim();
  }

  async function integrate(run: typeof UNO): Promise<WorktreeIntegrateSessionOutput> {
    const result = await runWorktree(deps, { action: "integrate", sessionCode: run.code });
    if ("error" in result) throw new Error(`la integración se negó: ${JSON.stringify(result)}`);
    return result as WorktreeIntegrateSessionOutput;
  }

  function reachable(sha: string): boolean {
    try {
      git(source, "merge-base", "--is-ancestor", sha, "main");
      return true;
    } catch {
      return false;
    }
  }

  function liveUnits(): Promise<WorktreeListOutput> {
    return runWorktree(deps, { action: "list" }) as Promise<WorktreeListOutput>;
  }

  it("dos integraciones limpias se encadenan: la segunda parte de lo que dejó la primera", async () => {
    const uno = await unitOf(UNO);
    const dos = await unitOf(DOS);
    const shaUno = commitIn(uno, PROPIO_UNO, "export const uno = 1;\n", "alpha");
    const shaDos = commitIn(dos, PROPIO_DOS, "export const dos = 2;\n", "beta");

    const primera = await integrate(UNO);
    expect(primera.integrated).toEqual([ALIAS]);
    expect(primera.pending).toEqual([]);
    expect(primera.next).toBeNull();
    expect(primera.plan).toBe(UNO.plan);
    // El merge de la segunda corre contra la rama VIVA, no contra una foto: por eso
    // el trabajo de la primera ya está debajo cuando la segunda empieza.
    expect(reachable(shaUno)).toBe(true);
    expect(reachable(shaDos)).toBe(false);

    const segunda = await integrate(DOS);
    expect(segunda.integrated).toEqual([ALIAS]);
    expect(segunda.plan).toBe(DOS.plan);
    expect(reachable(shaUno)).toBe(true);
    expect(reachable(shaDos)).toBe(true);

    // Estado final exigido por la fase: los dos resultados en la rama destino, el
    // checkout limpio, sin merge a medias, y el registro de worktrees vacío.
    expect(readFileSync(join(source, PROPIO_UNO), "utf8")).toContain("uno = 1");
    expect(readFileSync(join(source, PROPIO_DOS), "utf8")).toContain("dos = 2");
    expect(git(source, "status", "--porcelain").trim()).toBe("");
    expect(existsSync(join(source, ".git", "MERGE_HEAD"))).toBe(false);
    const listed = await liveUnits();
    expect(listed.units).toEqual([]);
    expect(listed.orphans).toEqual([]);
  });

  it("el conflicto conserva unidad, commits y merge, y su recibo dice de qué plan es", async () => {
    const uno = await unitOf(UNO);
    const dos = await unitOf(DOS);
    commitIn(uno, COMPARTIDO, "export const version = 1;\n", "alpha toca la línea");
    const shaDos = commitIn(dos, COMPARTIDO, "export const version = 2;\n", "beta toca la línea");

    await integrate(UNO);
    const chocada = await integrate(DOS);

    expect(chocada.integrated).toEqual([]);
    expect(chocada.pending).toEqual([ALIAS]);
    const unidad = chocada.results[0];
    if (unidad === undefined || "error" in unidad) throw new Error("esperaba un merge conflictivo");
    expect(unidad.conflicted).toContain(COMPARTIDO);
    // Los tres datos que el recibo tiene que traer para que alguien pueda actuar:
    // qué trabajo es, en qué repositorio quedó, y con qué comando se sigue. El plan
    // es el único que no se puede deducir mirando Git, y es justo el que distingue
    // dos flujos concurrentes.
    expect(chocada.plan).toBe(DOS.plan);
    expect(unidad.source_path).toBe(source);
    expect(unidad.next).toBe(`aw fix-git --path ${source}`);
    expect(chocada.next).toBe(unidad.next);

    // Nada se tiró para dejar el árbol prolijo: el merge sigue en curso y la unidad
    // conserva sus commits, que son la única copia de ese lado.
    expect(unidad.released).toBe(false);
    expect(existsSync(join(source, ".git", "MERGE_HEAD"))).toBe(true);
    expect((await liveUnits()).units.map((u) => u.session)).toEqual([DOS.folder]);
    expect(git(dos, "rev-parse", "HEAD").trim()).toBe(shaDos);

    // Y el comando al que enruta el recibo ve el mismo conflicto: el traspaso entre
    // los dos comandos es real, no una sugerencia.
    const prepared = await prepareFixGit(deps.git, source, ALIAS);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(JSON.stringify(prepared.value.context)).toContain(COMPARTIDO);
  });

  it("resuelto el conflicto, el segundo integrate confirma, libera y deja Git limpio", async () => {
    const uno = await unitOf(UNO);
    const dos = await unitOf(DOS);
    const shaUno = commitIn(uno, COMPARTIDO, "export const version = 1;\n", "alpha");
    const shaDos = commitIn(dos, COMPARTIDO, "export const version = 2;\n", "beta");
    await integrate(UNO);
    await integrate(DOS);

    // Lo que hacen `fix-git apply` + `commit --confirm`: los bytes resueltos y el
    // commit del merge. Se hace acá con Git para no atar la fase al protocolo
    // semántico de ese comando, que tiene su propia prueba.
    writeFileSync(join(source, COMPARTIDO), "export const version = 3;\n");
    git(source, "add", "-A");
    git(source, "commit", "--no-edit");

    const confirmada = await integrate(DOS);
    expect(confirmada.integrated).toEqual([ALIAS]);
    expect(confirmada.pending).toEqual([]);
    expect(confirmada.next).toBeNull();
    const unidad = confirmada.results[0];
    if (unidad === undefined || "error" in unidad) throw new Error("esperaba una integración");
    expect(unidad.released).toBe(true);

    // Las dos mitades están en la rama destino, con la resolución encima.
    expect(reachable(shaUno)).toBe(true);
    expect(reachable(shaDos)).toBe(true);
    expect(readFileSync(join(source, COMPARTIDO), "utf8")).toContain("version = 3");
    expect(git(source, "status", "--porcelain").trim()).toBe("");
    expect(existsSync(join(source, ".git", "MERGE_HEAD"))).toBe(false);
    const listed = await liveUnits();
    expect(listed.units).toEqual([]);
    expect(listed.orphans).toEqual([]);
  });

  it("el flow no pasa la integración con un conflicto, y vuelve a la MISMA frontera", async () => {
    const uno = await unitOf(UNO);
    const dos = await unitOf(DOS);
    commitIn(uno, COMPARTIDO, "export const version = 1;\n", "alpha");
    commitIn(dos, COMPARTIDO, "export const version = 2;\n", "beta");

    await walk.walkTo(DOS, "plan-exec.unit-integration");
    // La frontera existe y es de autorización: integrar escribe en la rama que
    // todos leen, así que no la cubre el grant de los commits.
    const parada = await walk.current(DOS.folder);
    expect(parada.resolved.stopped?.id).toBe("plan-exec.unit-integration");
    expect(parada.resolved.kind).toBe("authorization");
    await walk.step(DOS);

    // Un merge conflictivo NO es una invocación completada. Devolverlo como tal
    // sería declarar integrado lo que sigue en su rama, y por eso el motor lo
    // rechaza con el remedio de la fila: el conflicto es un estado activo.
    const rechazo = await walk.step(DOS, { outcome: "needs_input" });
    expect(rechazo.error?.code).toBe("FLOW_EXECUTION_NOT_COMPLETED");
    expect(rechazo.error?.action).toContain("fix-git");
    const pendiente = await walk.current(DOS.folder);
    expect(pendiente.state.applied).not.toContain("plan-exec.unit-integration");
    expect(pendiente.resolved.stopped?.id).toBe("plan-exec.unit-integration");

    // Y resuelto, la MISMA transición la acredita: es la frontera a la que se
    // vuelve, no una que haya que saltear.
    const confirmada = await walk.step(DOS);
    expect(confirmada.boundary.transition).toBe("plan-exec.plan-done");
    expect((await walk.current(DOS.folder)).state.applied).toContain("plan-exec.unit-integration");
  });

  it("el cierre dirigido se niega mientras viva una unidad, y cierra cuando ya no", async () => {
    const dos = await unitOf(DOS);
    commitIn(dos, PROPIO_DOS, "export const dos = 2;\n", "beta");

    const negado = await walk.executor()(
      { kind: "internal", operation: "session.close" },
      { session: DOS.folder, code: DOS.code, scope: null, proposal: null },
    );
    expect(negado.ok).toBe(false);
    expect(negado.summary).toContain("sin integrar");
    expect(negado.summary).toContain(`aw worktree integrate --code ${DOS.folder}`);
    expect(negado.effects).toEqual([]);
    // Lo que hace que la negativa sirva: el marcador NO se escribió, así que la
    // sesión sigue siendo alcanzable por su propio código y el remedio funciona.
    expect(existsSync(join(deps.paths.cwdSessionsDir(), DOS.folder, ".closed"))).toBe(false);

    await integrate(DOS);
    const cerrado = await walk.executor()(
      { kind: "internal", operation: "session.close" },
      { session: DOS.folder, code: DOS.code, scope: null, proposal: null },
    );
    expect(cerrado.ok).toBe(true);
    expect(existsSync(join(deps.paths.cwdSessionsDir(), DOS.folder, ".closed"))).toBe(true);
  });

  it("un inventario de unidades ilegible NO cuenta como sesión sin unidades", async () => {
    await unitOf(DOS);

    // El hallazgo del gate de revisión: el lector de unidades devolvía `[]` cuando
    // no podía leer, y eso se lee igual que "no hay nada que integrar". Mientras el
    // cierre sólo informaba era inocuo; ahora que se niega, es justo el estado que
    // NO puede cerrarse en silencio — el único donde nadie pudo mirar.
    const negado = await runSessionClose(
      deps.fs,
      deps.paths,
      { code: DOS.code, requireIntegrated: true },
      async () => {
        throw new Error("git worktree list no respondió");
      },
    );
    if (!("sessionHeld" in negado)) throw new Error("un inventario ilegible tiene que negar");
    expect(negado.sessionHeld.reason).toContain("no se pudo comprobar");
    expect(existsSync(join(deps.paths.cwdSessionsDir(), DOS.folder, ".closed"))).toBe(false);

    // Y por el camino que informa, el fallo viaja en su propio campo en vez de
    // desaparecer detrás de un `pending_integration` ausente.
    const cerrado = await runSessionClose(deps.fs, deps.paths, { code: DOS.code }, async () => {
      throw new Error("git worktree list no respondió");
    });
    if (!("sessionClose" in cerrado)) throw new Error("el cierre a mano tenía que cerrar");
    expect(cerrado.sessionClose.pending_integration).toBeUndefined();
    expect(cerrado.sessionClose.pending_integration_error).toContain("no respondió");
  });

  it("el cierre a mano sigue cerrando, y su recibo conserva el remedio de reapertura", async () => {
    const dos = await unitOf(DOS);
    commitIn(dos, PROPIO_DOS, "export const dos = 2;\n", "beta");

    // La asimetría es la decisión: una persona que cierra a mano puede tener
    // razones que este servicio no ve, así que se lleva el recibo y el cierre.
    const closed = await runSessionClose(deps.fs, deps.paths, { code: DOS.code }, async () => {
      const listed = await liveUnits();
      return listed.units;
    });
    if (!("sessionClose" in closed)) throw new Error("el cierre a mano tenía que cerrar");
    expect(closed.sessionClose.closed).toBe(true);
    expect(closed.sessionClose.pending_integration?.[0]?.command).toBe(
      `aw worktree integrate --source ${ALIAS} --code ${DOS.folder}`,
    );
    // Y acá el remedio que antes faltaba: cerrada la sesión, ese comando ya no
    // resuelve, así que el recibo tiene que decir cómo volver.
    expect(closed.sessionClose.reopen).toBe(`aw session-resume --code ${DOS.folder} --reopen`);

    // La prueba de que hacía falta: sin reabrir, la integración se niega — y lo
    // dice con el motivo del resolver, no con un "pasá --code" que ya se pasó.
    const negada = await runWorktree(deps, {
      action: "integrate",
      alias: ALIAS,
      sessionCode: DOS.code,
    });
    if (!("error" in negada)) throw new Error("una sesión cerrada no puede integrar");
    expect(negada.error).toBe("session_unresolved");
    expect(negada.hint).toContain("--reopen");
  });
});
