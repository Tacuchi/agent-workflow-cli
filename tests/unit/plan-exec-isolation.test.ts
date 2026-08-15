import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { runCheckBranch } from "../../src/application/check-branch-service.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runResume } from "../../src/application/resume-service.js";
import { runSources } from "../../src/application/sources-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { type WorktreeListOutput, runWorktree } from "../../src/application/worktree-service.js";
import { FLOW_RUN_STATE_FILE } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";

/**
 * Dos `plan-exec` sobre el MISMO source, cada uno en lo suyo.
 *
 * La fase F2 del plan 023 se valida acá y sobre Git de verdad, porque lo que hay
 * que demostrar no es que las piezas existan —`worktree`, `check-branch`,
 * `status` y `resume` ya existían— sino que dos recorridos reales encadenados no
 * se pisan: cada uno fija su plan y sus fuentes, adquiere su unidad antes de
 * escribir, commitea ahí, y no puede acreditar ni editar el árbol del otro ni el
 * checkout compartido.
 *
 * El punto más importante está en la última prueba: la evidencia de rama y de
 * commit NO puede salir del checkout principal. Con dos unidades trabajando, el
 * checkout está limpio y en su rama justamente porque nadie escribió ahí — así
 * que `aw sources --verbose` contesta verde para un batch que no commiteó nada.
 */

const ALIAS = "acme";
const OTRO = "vecino";
const FILE = "src/feature.ts";

const UNO = { code: "201", folder: "201-alpha-plan-exec", plan: "docs/plans/041-plan-alpha.md" };
const DOS = { code: "202", folder: "202-beta-plan-exec", plan: "docs/plans/042-plan-beta.md" };

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Two declared sources; only one of them is named by the plans. */
function block(sourcePath: string, otherPath: string): string {
  return `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Aislamiento concurrente.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| ${ALIAS} | ${sourcePath} | main |
| ${OTRO} | ${otherPath} | main |

## Status

- Ramas de trabajo actuales:
  - ${ALIAS}: main
  - ${OTRO}: main
<!-- AGENT-WORKFLOW-PROJECT-END -->
`;
}

describe("F2 — cada plan-exec edita y acredita sólo sus unidades", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let source: string;
  let otro: string;
  let deps: {
    fs: NodeFileSystem;
    env: FakeEnv;
    git: GitCliAdapter;
    paths: PathsService;
  };
  let walk: ReturnType<typeof planExecWalk>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-f2-"));
    home = join(root, "home");
    workspace = join(root, "ws");
    source = join(root, ALIAS);
    otro = join(root, OTRO);
    for (const dir of [home, workspace, source, otro]) mkdirSync(dir, { recursive: true });

    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.email", "t@example.com");
    git(source, "config", "user.name", "T");
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, FILE), "export const base = 1;\n");
    git(source, "add", "-A");
    git(source, "commit", "-m", "inicial");

    deps = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths: new PathsService(normalizeNamespace("agent-workflow"), home, workspace),
    };
    walk = planExecWalk(deps, { sources: [ALIAS] });

    writeFileSync(join(workspace, "CLAUDE.md"), block(source, otro));
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    for (const run of [UNO, DOS]) {
      writeFileSync(
        join(workspace, run.plan),
        `# Plan ${run.code}\n\n## Impacted\n\n- **${ALIAS}:** el source compartido.\n`,
      );
      const dir = join(deps.paths.cwdSessionsDir(), run.folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SESSION.md"),
        `# SESSION — ${run.folder}\n\n## Objective\nejecutar ${run.plan}\n\n## Success criteria\n- [ ] la unidad queda con su commit\n`,
      );
      writeFileSync(join(dir, "CHECKPOINT.md"), `# CHECKPOINT — ${run.folder}\n\n## Completed\n`);
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Seed the durable conversation→session association the hook path reads. */
  function bind(contextId: string, folder: string): void {
    const file = join(deps.paths.cwdSessionsDir(), ".bindings.json");
    const key = createHash("sha256").update(contextId, "utf8").digest("hex");
    writeFileSync(file, JSON.stringify({ version: 1, bindings: { [key]: folder } }, null, 2));
  }

  /** Both runs up to the first row that writes code, with their units acquired. */
  async function bothIsolated(): Promise<{ uno: string; dos: string }> {
    await walk.walkTo(UNO, "plan-exec.implementation");
    await walk.walkTo(DOS, "plan-exec.implementation");
    const listed = (await runWorktree(deps, { action: "list" })) as WorktreeListOutput;
    const of = (folder: string): string => {
      const unit = listed.units.find((entry) => entry.session === folder);
      if (unit === undefined) throw new Error(`${folder} no adquirió su unidad`);
      return unit.path;
    };
    return { uno: of(UNO.folder), dos: of(DOS.folder) };
  }

  /** Commit `content` into a unit, the way its own flow would. */
  function commitIn(unit: string, content: string, message: string): string {
    writeFileSync(join(unit, FILE), content);
    git(unit, "config", "user.email", "t@example.com");
    git(unit, "config", "user.name", "T");
    git(unit, "add", "-A");
    git(unit, "commit", "-m", message);
    return git(unit, "rev-parse", "HEAD").trim();
  }

  /** Answer the scope boundary with `decisions`, whatever they are. */
  async function declareScope(run: typeof UNO, decisions: Record<string, unknown>) {
    await walk.walkTo(run, "plan-exec.source-scope");
    const { resolved } = await walk.current(run.folder);
    const result = await submitFlow(deps.fs, deps.paths, {
      code: run.code,
      raw: JSON.stringify({ input_digest: resolved.seal, signals: [], decisions }),
      approval: null,
      executor: walk.executor(),
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return result.directive;
  }

  it("un scope que el workspace o el plan no sostienen no fija nada ni adquiere nada", async () => {
    const casos: Array<[string, Record<string, unknown>, string]> = [
      // Un alias inventado: lo decide la tabla de Fuentes y nada más.
      ["alias inexistente", { plan: UNO.plan, sources: ["fantasma"] }, "FLOW_SCOPE_UNKNOWN_SOURCE"],
      // Un alias declarado que ESTE plan no nombra: ensanchar el scope es cambiar
      // qué se edita, y eso vuelve al plan, no se resuelve acá.
      [
        "fuente ajena al plan",
        { plan: UNO.plan, sources: [ALIAS, OTRO] },
        "FLOW_SCOPE_NOT_IN_PLAN",
      ],
      // Un plan que nadie puede mostrar no puede validar nada.
      [
        "plan inexistente",
        { plan: "docs/plans/099-plan-fantasma.md", sources: [ALIAS] },
        "FLOW_SCOPE_PLAN_UNREADABLE",
      ],
      // Y una corrida que no aísla ninguna fuente no tiene dónde escribir.
      ["sin fuentes", { plan: UNO.plan, sources: [] }, "FLOW_SCOPE_INVALID"],
      ["fuente repetida", { plan: UNO.plan, sources: [ALIAS, ALIAS] }, "FLOW_SCOPE_INVALID"],
      ["sin plan", { sources: [ALIAS] }, "FLOW_SCOPE_INVALID"],
    ];
    for (const [caso, decisions, code] of casos) {
      const directive = await declareScope(UNO, decisions);
      expect(directive.error?.code, caso).toBe(code);
      const { state, resolved } = await walk.current(UNO.folder);
      // Nada se fijó y nada se adquirió: la frontera sigue en pie.
      expect(state.scope, caso).toBeNull();
      expect(resolved.stopped?.id, caso).toBe("plan-exec.source-scope");
      const listed = (await runWorktree(deps, { action: "list" })) as WorktreeListOutput;
      expect(listed.units, caso).toEqual([]);
      // Un rechazo gasta un intento, así que cada caso corre sobre su propia
      // corrida: tres seguidos agotarían la frontera y eso mediría otra cosa.
      rmSync(join(deps.paths.cwdSessionsDir(), UNO.folder, FLOW_RUN_STATE_FILE), { force: true });
    }
  });

  it("cada corrida fija su propio plan y adquiere su propia unidad antes de escribir", async () => {
    const units = await bothIsolated();

    // Dos árboles distintos, cada uno en la rama de SU sesión.
    expect(units.uno).not.toBe(units.dos);
    expect(git(units.uno, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(`aw/${UNO.folder}`);
    expect(git(units.dos, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(`aw/${DOS.folder}`);

    // Y el scope quedó en el estado dirigido, no en la memoria de nadie: es lo
    // que hace distinguibles a dos corridas que por lo demás son idénticas.
    const uno = await walk.current(UNO.folder);
    const dos = await walk.current(DOS.folder);
    expect(uno.state.scope).toEqual({ plan: UNO.plan, sources: [ALIAS] });
    expect(dos.state.scope).toEqual({ plan: DOS.plan, sources: [ALIAS] });
    expect(uno.state.applied).toContain("plan-exec.unit-acquisition");
    // La adquisición va ANTES de la primera escritura: la corrida está parada en
    // `implementation` y la unidad ya existe.
    expect(uno.resolved.stopped?.id).toBe("plan-exec.implementation");
  });

  it("reanudar reutiliza la misma unidad en vez de cortar otra", async () => {
    const first = await bothIsolated();
    // Un segundo `advance` sobre una corrida ya parada: idempotente por contrato,
    // y lo que se verifica es que no aparezca un tercer árbol.
    const again = await advanceFlow(deps.fs, deps.paths, {
      code: UNO.code,
      flow: "plan-exec",
      executor: walk.executor(),
    });
    expect(again.ok).toBe(true);
    const listed = (await runWorktree(deps, { action: "list" })) as WorktreeListOutput;
    expect(listed.units).toHaveLength(2);
    expect(listed.units.find((u) => u.session === UNO.folder)?.path).toBe(first.uno);
  });

  it("cada contexto edita y commitea sólo en su unidad; main y la unidad ajena se rechazan", async () => {
    const units = await bothIsolated();
    commitIn(units.uno, "export const base = 1;\nexport const alpha = true;\n", "alpha");
    commitIn(units.dos, "export const base = 1;\nexport const beta = true;\n", "beta");

    const verdict = async (file: string, code: string) =>
      runCheckBranch(deps.fs, deps.env, deps.git, deps.paths, { fileArg: file, sessionCode: code });

    // 1 · lo propio pasa
    expect((await verdict(join(units.uno, FILE), UNO.code)).match).toBe(true);
    expect((await verdict(join(units.dos, FILE), DOS.code)).match).toBe(true);

    // 2 · el árbol del otro se rechaza nombrando a su dueño
    const ajena = await verdict(join(units.dos, FILE), UNO.code);
    expect(ajena.match).toBe(false);
    expect(ajena.reason).toBe("other_session_unit");
    expect(ajena.actual_unit?.session).toBe(DOS.folder);

    // 3 · el checkout compartido se rechaza con el comando que da la unidad
    const compartido = await verdict(join(source, FILE), UNO.code);
    expect(compartido.match).toBe(false);
    expect(compartido.reason).toBe("outside_unit");
    expect(compartido.remedy).toBe(`aw worktree ensure --source ${ALIAS} --code ${UNO.folder}`);

    // 4 · y nada de eso movió un byte: verificar es leer
    expect(readFileSync(join(units.dos, FILE), "utf-8")).toContain("beta");
    expect(readFileSync(join(source, FILE), "utf-8")).toBe("export const base = 1;\n");
  });

  it("la identidad se resuelve por --code o por binding, y falla cerrada cuando no se resuelve", async () => {
    const units = await bothIsolated();

    // Por asociación de la conversación, sin --code: es lo que el hook tiene.
    bind("conversacion-uno", UNO.folder);
    const porBinding = await runCheckBranch(deps.fs, deps.env, deps.git, deps.paths, {
      fileArg: join(units.uno, FILE),
      contextId: "conversacion-uno",
    });
    expect(porBinding.match).toBe(true);
    expect(porBinding.session_code).toBe(UNO.folder);

    // Y la misma conversación sobre el árbol ajeno se rechaza igual.
    const cruzado = await runCheckBranch(deps.fs, deps.env, deps.git, deps.paths, {
      fileArg: join(units.dos, FILE),
      contextId: "conversacion-uno",
    });
    expect(cruzado.reason).toBe("other_session_unit");

    // Sin identidad de ningún tipo y con DOS sesiones activas, el resolver no
    // puede decir de quién es el flujo — y no saberlo no autoriza nada.
    const ciego = await runCheckBranch(deps.fs, deps.env, deps.git, deps.paths, {
      fileArg: join(units.uno, FILE),
    });
    expect(ciego.match).toBe(false);
    expect(ciego.reason).toBe("unknown_identity");
    expect(ciego.error).toContain("2 sesiones activas");
  });

  it("`worktree list --code` devuelve sólo la unidad de esa sesión, con su rama, su estado y su commit", async () => {
    const units = await bothIsolated();
    const sha = commitIn(
      units.uno,
      "export const base = 1;\nexport const alpha = true;\n",
      "alpha",
    );

    const mine = (await runWorktree(deps, {
      action: "list",
      sessionCode: UNO.code,
    })) as WorktreeListOutput;
    expect(mine.session).toBe(UNO.folder);
    expect(mine.units).toHaveLength(1);
    expect(mine.units[0]?.path).toBe(units.uno);
    expect(mine.units[0]?.branch).toBe(`aw/${UNO.folder}`);
    expect(mine.units[0]?.dirty).toBe(false);
    expect(mine.units[0]?.head).toBe(sha);

    // La unidad de la otra sesión no aparece: es la lectura que la frontera de
    // rama y la de commit usan como evidencia, y ver el árbol ajeno ahí sería
    // acreditarle a esta corrida el trabajo de la otra.
    expect(mine.units.some((unit) => unit.session === DOS.folder)).toBe(false);

    // Una sesión que no se puede resolver no ensancha la lista: se rechaza.
    const nadie = await runWorktree(deps, { action: "list", sessionCode: "999" });
    expect("error" in nadie && nadie.error).toBe("session_unresolved");
  });

  it("status y resume identifican por separado plan, sesión, checkpoint, rama y path", async () => {
    const units = await bothIsolated();
    commitIn(units.uno, "export const base = 1;\nexport const alpha = true;\n", "alpha");

    const board = await runStatusCommand(deps.fs, deps.env, deps.paths, { git: deps.git });
    const sesion = (folder: string) => board.sessions.active.find((s) => s.folder === folder);
    expect(sesion(UNO.folder)?.flow?.scope?.plan).toBe(UNO.plan);
    expect(sesion(DOS.folder)?.flow?.scope?.plan).toBe(DOS.plan);
    expect(sesion(UNO.folder)?.units.map((u) => u.path)).toEqual([units.uno]);
    expect(sesion(DOS.folder)?.units.map((u) => u.path)).toEqual([units.dos]);
    expect(board.orphan_units).toEqual([]);

    for (const [run, unit] of [
      [UNO, units.uno],
      [DOS, units.dos],
    ] as const) {
      const resumed = await runResume(deps.fs, deps.env, deps.paths, {
        code: run.code,
        git: deps.git,
      });
      if (resumed.status !== "proposal") throw new Error(`esperaba una propuesta para ${run.code}`);
      expect(resumed.proposal.file).toBe(run.folder);
      expect(resumed.proposal.scope?.plan).toBe(run.plan);
      expect(resumed.proposal.units?.map((u) => u.path)).toEqual([unit]);
      expect(resumed.proposal.units?.map((u) => u.branch)).toEqual([`aw/${run.folder}`]);
    }
  });

  it("la evidencia de rama y commit no puede quedar verde leyendo el checkout principal", async () => {
    const units = await bothIsolated();
    const alpha = commitIn(units.uno, "export const base = 1;\nexport const alpha = 1;\n", "alpha");
    const beta = commitIn(units.dos, "export const base = 1;\nexport const beta = 1;\n", "beta");

    // El checkout compartido: en su rama, limpio y en el commit inicial. Ésta es
    // exactamente la lectura que `aw sources --verbose` daba como evidencia —
    // verde, y sin una sola línea del trabajo de ninguna de las dos corridas.
    const sources = await runSources(deps.fs, deps.env, deps.git, deps.paths, { verbose: true });
    const acme = (sources as { sources: Array<Record<string, unknown>> }).sources.find(
      (entry) => entry.alias === ALIAS,
    );
    expect(acme?.current_branch).toBe("main");
    expect(acme?.dirty).toBe(false);
    expect(git(source, "rev-parse", "HEAD").trim()).not.toBe(alpha);
    expect(readFileSync(join(source, FILE), "utf-8")).toBe("export const base = 1;\n");

    // La lectura por unidad, en cambio, sí distingue: cada corrida ve su commit y
    // ninguna ve el de la otra. Y con las dos commiteadas y sin integrar, la rama
    // destino sigue intacta.
    for (const [run, sha] of [
      [UNO, alpha],
      [DOS, beta],
    ] as const) {
      const listed = (await runWorktree(deps, {
        action: "list",
        sessionCode: run.code,
      })) as WorktreeListOutput;
      expect(listed.units.map((unit) => unit.head)).toEqual([sha]);
    }
    expect(git(source, "log", "--oneline", "main").trim().split("\n")).toHaveLength(1);
  });
});
