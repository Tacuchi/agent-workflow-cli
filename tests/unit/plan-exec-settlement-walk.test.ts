/**
 * F6 del plan 042 — el incidente, fijado, y los cuatro caminos de punta a punta.
 *
 * El incidente es real y es el que originó la spec: una corrida llegó al cierre
 * con una nota de dos obligaciones en forma de texto, el tablero la leyó como si
 * el plan debiera las dos, `plan-done` se negó, y la única salida que quedaba era
 * editar `docs/decisions/` a mano. Cada camino de acá abajo es una mitad de por
 * qué eso ya no puede pasar, y todos corren sobre la corrida REAL: las acciones
 * internas se ejecutan de verdad y lo único que se fabrica es lo que devolvería
 * un ejecutor externo, que es la mitad que ninguna prueba puede correr.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import {
  noteIndexArtifact,
  noteIndexPath,
  sealNote,
} from "../../src/application/decision-note-service.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { PathsService } from "../../src/application/paths-service.js";
import { applySettle, listSettle, prepareSettle } from "../../src/application/settle-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  type NoteObligation,
  normalizeObligations,
} from "../../src/domain/decision-note.js";
import { journeyForState } from "../../src/domain/flow/authority.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const SPEC = "docs/specs/080-spec-incidente.md";
const PLAN = "docs/plans/081-plan-incidente.md";
const SESSION = "410-incidente-plan-exec";
const RUN = { code: "410", folder: SESSION, plan: PLAN };

/** El trabajo compensatorio: nadie de afuera lo hace, y retiene el cierre. */
const COMPENSACION = "revalidar F1 contra el criterio nuevo";
/** Copiado VERBATIM del paso de traspaso operativo que el plan enumera. */
const TRASPASO = "publicar la release del paquete y actualizar el aw global";

const SPEC_TEXT = [
  "---",
  "status: ready-for-plan",
  "---",
  "",
  "# 080 — spec del incidente",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] **S080/AC-01 — una.** el resultado que la fase probaba",
  "",
].join("\n");

const WORKSPACE_BLOCK = [
  "<!-- AGENT-WORKFLOW-PROJECT-START -->",
  "## Proyecto",
  "",
  "El incidente del andamiaje autorreparable.",
  "",
  "## Fuentes",
  "",
  "| Alias | Path | Rama principal |",
  "|---|---|---|",
  "| acme | /tmp/acme | main |",
  "",
  "## Status",
  "",
  "- Ramas de trabajo actuales:",
  "  - acme: main",
  "<!-- AGENT-WORKFLOW-PROJECT-END -->",
  "",
].join("\n");

/** El plan del incidente: sellado, con su sección de traspaso operativo. */
const PLAN_TEXT = [
  "# Plan 081 — el incidente",
  "",
  `> Derived from: ${SPEC}`,
  `> Baseline: ${SPEC}@sha256:${baseDigest(SPEC_TEXT)}`,
  "> Límite de ejecución: checkout",
  "",
  "## Origin",
  "",
  "Spec 080.",
  "",
  "## Handoff operativo",
  "",
  `- ${TRASPASO}`,
  "",
  "## Tasks",
  "",
  "### F1 — hacer el trabajo",
  "> Estado: pendiente",
  "> Fuentes: workspace",
  "",
  "- [ ] T1.1 — hacer el trabajo _(fuentes: workspace)_",
  "",
].join("\n");

/** El mismo plan con su fase validada y su casilla marcada: el del incidente. */
const PLAN_VALIDADO = PLAN_TEXT.replace("> Estado: pendiente", "> Estado: validada").replace(
  "- [ ] T1.1",
  "- [x] T1.1",
);

describe("F6 — el recorrido completo cierra solo, y un workspace bloqueado sale por `aw settle`", () => {
  let workdir: string;
  let paths: PathsService;
  let deps: {
    fs: NodeFileSystem;
    env: FakeEnv;
    git: GitCliAdapter;
    paths: PathsService;
  };
  const fs = new NodeFileSystem();

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-f6-saldo-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    deps = {
      fs,
      env: new FakeEnv(workdir, workdir),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      `# SESSION — ${SESSION}\n\n## Objective\nejecutar ${PLAN}\n`,
      "utf8",
    );
    await mkdir(join(workdir, "docs", "specs"), { recursive: true });
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await mkdir(join(workdir, "docs", "decisions"), { recursive: true });
    await writeFile(join(workdir, "CLAUDE.md"), WORKSPACE_BLOCK, "utf8");
    await writeFile(join(workdir, SPEC), SPEC_TEXT, "utf8");
    await writeFile(join(workdir, PLAN), PLAN_TEXT, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  // ── T6.1 · el incidente, fijado ────────────────────────────────────────────

  /**
   * La nota como quedó publicada el día del incidente: sus obligaciones en forma
   * de TEXTO, sin clase, que es la forma que existía antes de este plan.
   */
  async function publishIncident(obligations: readonly (string | NoteObligation)[]): Promise<void> {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: SPEC, number: "080" },
      notes: [] as DecisionNote[],
    };
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: { path: SPEC, number: "080", digest: functionalSpecDigest(SPEC_TEXT) },
        plan: { path: PLAN, number: "081", digest: `sha256:${baseDigest(PLAN_TEXT)}` },
        execution: { session: SESSION, phase: "F1" },
      },
      decision: "el resultado de F1 ya no satisface el contrato vigente",
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: ["S080/AC-01"],
      supersedes_note: null,
      scope: "functional",
      consumers: [PLAN],
      evidence_preserved: ["F1/T1.1 como historia"],
      evidence_invalidated: [],
      obligations: normalizeObligations(obligations) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-07-20",
    });
    const artifact = noteIndexArtifact(noteIndexPath("docs/decisions", "080", "incidente"), {
      ...index,
      notes: [sealed],
    });
    await writeFile(join(workdir, artifact.path), artifact.content, "utf8");
  }

  function walker(signals: readonly string[] = []) {
    return planExecWalk(deps, { sources: ["workspace"], signals });
  }

  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
  }

  /** Contestar la frontera vigente con un cuerpo propio, no con el del helper. */
  async function answer(body: Record<string, unknown>) {
    const { resolved } = await current();
    const result = await submitFlow(fs, paths, {
      code: RUN.code,
      raw: JSON.stringify({ input_digest: resolved.seal, ...body }),
      executor: walker().executor(),
    });
    if (!result.ok)
      throw new Error(`un rechazo de negocio viaja ok:true: ${JSON.stringify(result)}`);
    return result.directive;
  }

  const board = () => buildWorklineIndex(fs, deps.env, paths, { git: deps.git });

  /** Las notas del linaje como quedaron EN DISCO, para leer lo que se publicó. */
  async function chainOf(): Promise<DecisionNote[]> {
    const raw = await readFile(
      join(workdir, noteIndexPath("docs/decisions", "080", "incidente")),
      "utf8",
    );
    return (JSON.parse(raw) as { notes: DecisionNote[] }).notes;
  }
  const planOf = async () => (await board()).plans.find((p) => p.file === PLAN);

  it("T6.1 · el incidente se lee como DOS clases, no como dos deudas", async () => {
    // Sobre el plan como lo dejó el incidente: todo validado y todo tildado, que
    // es lo que hace que la única cosa abierta sea la obligación.
    await writeFile(join(workdir, PLAN), PLAN_VALIDADO, "utf8");
    await publishIncident([COMPENSACION, TRASPASO]);
    const plan = await planOf();

    // La lectura que el incidente no tenía: una compensación que retiene, y un
    // traspaso que el plan ya enumeraba y que no retiene nada.
    expect(plan?.reconciliation?.pending.map((o) => o.text)).toEqual([COMPENSACION]);
    expect(plan?.reconciliation?.handoffs.map((o) => o.text)).toEqual([TRASPASO]);
    expect(plan?.reconciliation?.handoffs[0]?.corresponds_to).toBe(TRASPASO);
    expect(plan?.reconciliation?.closable).toBe(false);
    // Las dos son lecturas, no palabra de la nota: nadie declaró ninguna clase.
    expect(plan?.reconciliation?.pending[0]?.legacy).toBe(true);
    expect(plan?.reconciliation?.handoffs[0]?.legacy).toBe(true);
  });

  // ── T6.2 · el camino que cierra solo ───────────────────────────────────────

  it("T6.2 · la legada CON correspondencia cierra sola, y el traspaso queda a la vista", async () => {
    // Sólo el traspaso: el plan lo enumera, así que se lee traspaso, no bloquea,
    // y el tramo de saldo se saltea entero. El cierre es el de siempre.
    await publishIncident([TRASPASO]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.plan-done");
    await walk.step(RUN);

    const sealed = await readFile(join(workdir, PLAN), "utf8");
    expect(sealed).toContain("> Estado: done");
    // Y el traspaso sigue a la vista DESPUÉS del cierre, que es lo que cerrar el
    // plan hacía desaparecer: vuelve al pipeline como pendiente no bloqueante.
    const item = (await board()).pipeline.find((row) => row.file === PLAN);
    expect(item?.kind).toBe("plan-handoff");
    expect(item?.detail.next).toContain(TRASPASO);
    expect(item?.detail.obligation).toBe(false);
    expect(item?.command).toBe(`aw settle prepare ${PLAN}`);
  });

  it("T6.2 · con la compensación declarada cumplida, el CLI publica el saldo y sella `done`", async () => {
    await publishIncident([
      { text: COMPENSACION, kind: "compensation", declared: true },
      { text: TRASPASO, kind: "handoff", declared: true },
    ]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    expect(owed.map((o) => o.text)).toEqual([COMPENSACION]);
    await answer({
      decisions: {
        settlement: owed.map((o) => ({
          note: o.note,
          index: o.index,
          outcome: "settled",
          evidence: "npm test -- tests/unit/f1.test.ts en verde",
        })),
      },
    });

    // Ninguna pregunta humana nueva: la clase estaba declarada, así que no hay
    // nada que ratificar y el recorrido sigue derecho. Es AC-12 literal — el
    // cierre no agrega interacción humana sobre el estado interno del CLI.
    await walk.walkTo(RUN, "plan-exec.plan-done");
    // `applied` registra toda fila por la que pasó el cursor, salteada incluida;
    // `skipped` es la que dice que nadie la contestó. Ésa es la afirmación.
    expect((await current()).state.skipped).toContain("plan-exec.settlement-question");
    await walk.step(RUN);

    expect(await readFile(join(workdir, PLAN), "utf8")).toContain("> Estado: done");
    // El saldo lo publicó el CLI: hay un sucesor en la cadena y el plan cerró.
    const plan = await planOf();
    expect(plan?.contract?.applied).toContain("DEC-002");
    expect(plan?.reconciliation?.pending).toEqual([]);
    expect(plan?.reconciliation?.handoffs.map((o) => o.text)).toEqual([TRASPASO]);
    // Y QUÉ arrastra el sucesor, que es lo que lo hace un saldo y no una nota
    // nueva: sustituye a la que cargaba la obligación, conserva la afirmación
    // enmendada, y lleva la evidencia declarada como la constancia del saldo.
    const sucesor = (await chainOf()).at(-1);
    expect(sucesor?.supersedes_note).toBe("DEC-001");
    expect(sucesor?.supersedes_assertions).toEqual(["S080/AC-01"]);
    expect(sucesor?.evidence_preserved.join(" ")).toContain(
      "npm test -- tests/unit/f1.test.ts en verde",
    );
    expect(sucesor?.obligations.map((o) => o.text)).toEqual([TRASPASO]);
  });

  it("T6.2 · el fixture del incidente ENTERO atraviesa el cierre y su traspaso sobrevive", async () => {
    // Las dos obligaciones legadas del incidente, y sólo la compensación
    // declarada: el sucesor tiene que clasificar el traspaso que arrastra por la
    // lectura que hizo el tablero, no por una clase que nadie escribió.
    await publishIncident([COMPENSACION, TRASPASO]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    expect(owed.map((o) => o.text)).toEqual([COMPENSACION]);
    expect(owed[0]?.legacy).toBe(true);
    await answer({
      decisions: {
        settlement: owed.map((o) => ({
          note: o.note,
          index: o.index,
          outcome: "settled",
          evidence: "revalidado contra el criterio nuevo",
        })),
      },
    });
    // La legada es ambigua, así que la pregunta se abre: se ratifica el saldo.
    await answer({ choice: "Cumplida con la evidencia declarada" });
    await walk.walkTo(RUN, "plan-exec.plan-done");
    await walk.step(RUN);

    expect(await readFile(join(workdir, PLAN), "utf8")).toContain("> Estado: done");
    const sucesor = (await chainOf()).at(-1);
    // En DISCO, y en forma de objeto: el sucesor escribe la clase que el tablero
    // leyó, así que de acá en adelante es la palabra de la nota y ya no una
    // lectura que alguien supuso. Eso es lo que el incidente no podía hacer.
    expect(sucesor?.obligations).toEqual([{ text: TRASPASO, kind: "handoff" }]);
    const plan = await planOf();
    expect(plan?.reconciliation?.closable).toBe(true);
    expect(plan?.reconciliation?.handoffs.map((o) => o.text)).toEqual([TRASPASO]);
  });

  // ── T6.3 · la legada sin correspondencia pregunta UNA vez ──────────────────

  it("T6.3 · la legada SIN correspondencia abre una sola pregunta, con sus tres lecturas", async () => {
    await publishIncident([COMPENSACION]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    expect(owed[0]?.legacy).toBe(true);
    await answer({
      decisions: {
        settlement: owed.map((o) => ({ note: o.note, index: o.index, outcome: "pending" })),
      },
    });

    const { resolved } = await current();
    expect(resolved.stopped?.id).toBe("plan-exec.settlement-question");
    expect(resolved.kind).toBe("human");
    // Las tres lecturas, y una sola pregunta para todas las ambiguas. Los dos
    // controles de flujo los agrega el motor a toda frontera humana: no son
    // alternativas de esta pregunta y por eso se cuentan aparte.
    const labels = resolved.choices.map((c) => c.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Cumplida con la evidencia declarada",
        "Es un traspaso",
        "Sigue pendiente",
      ]),
    );
    expect(labels.filter((label) => label === "Compactar" || label === "Cerrar")).toHaveLength(2);
    expect(labels).toHaveLength(5);

    // La elegida publica la nota que CORRESPONDE: leída traspaso, la obligación
    // se conserva reclasificada —no se descarta— y con eso el plan cierra.
    await answer({ choice: "Es un traspaso" });
    await walk.walkTo(RUN, "plan-exec.plan-done");
    await walk.step(RUN);

    expect(await readFile(join(workdir, PLAN), "utf8")).toContain("> Estado: done");
    const plan = await planOf();
    expect(plan?.reconciliation?.pending).toEqual([]);
    expect(plan?.reconciliation?.handoffs.map((o) => o.text)).toEqual([COMPENSACION]);
  });

  it("T6.3 · la lectura ratificada REEMPLAZA la propuesta, y suelta su evidencia", async () => {
    // El callejón sin salida que esta prueba cierra: el agente propone «la hice,
    // acá está la prueba» y la persona ratifica «es un traspaso». Si la evidencia
    // cruzaba la ratificación, `checkSettlements` rechazaba el saldo para siempre
    // —evidencia sin saldo— y el plan quedaba ni ejecutable ni cerrable. Otra vez
    // el incidente, y por el camino que el saldo abrió para evitarlo.
    await publishIncident([COMPENSACION]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    await answer({
      decisions: {
        settlement: owed.map((o) => ({
          note: o.note,
          index: o.index,
          outcome: "settled",
          evidence: "lo corrí y pasó",
        })),
      },
    });
    await answer({ choice: "Es un traspaso" });

    // La declaración quedó reclasificada Y sin la evidencia de la propuesta.
    expect((await current()).state.settlement?.declared).toEqual([
      { note: owed[0]?.note, index: owed[0]?.index, outcome: "handoff" },
    ]);
    await walk.walkTo(RUN, "plan-exec.plan-done");
    await walk.step(RUN);

    // Y el saldo se publicó: el plan cierra y la obligación quedó reclasificada,
    // no descartada — sigue en la cadena, ahora como traspaso declarado.
    expect(await readFile(join(workdir, PLAN), "utf8")).toContain("> Estado: done");
    expect((await chainOf()).at(-1)?.obligations).toEqual([
      { text: COMPENSACION, kind: "handoff" },
    ]);
    const plan = await planOf();
    expect(plan?.reconciliation?.pending).toEqual([]);
    expect(plan?.reconciliation?.handoffs.map((o) => o.text)).toEqual([COMPENSACION]);
  });

  it("T6.3 · la respuesta única alcanza SÓLO a las ambiguas, no a lo ya declarado", async () => {
    // Una compensación con su clase declarada y una legada sin correspondencia.
    // La pregunta se abre por la legada, y lo que la persona contesta no puede
    // alcanzar a la otra: su clase la dijo la nota, y nadie la puso en duda.
    await publishIncident([
      { text: COMPENSACION, kind: "compensation", declared: true },
      TRASPASO.replace("publicar", "coordinar"),
    ]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    expect(owed.map((o) => o.legacy)).toEqual([false, true]);
    await answer({
      decisions: {
        settlement: [
          {
            note: owed[0]?.note,
            index: owed[0]?.index,
            outcome: "settled",
            evidence: "suite verde",
          },
          { note: owed[1]?.note, index: owed[1]?.index, outcome: "pending" },
        ],
      },
    });
    await answer({ choice: "Es un traspaso" });
    await walk.walkTo(RUN, "plan-exec.plan-done");
    await walk.step(RUN);

    // La declarada se SOLTÓ —estaba cumplida con su evidencia— y la legada quedó
    // conservada como traspaso. Si la respuesta hubiera alcanzado a las dos, la
    // declarada habría cruzado con su evidencia y el saldo no se publicaba.
    expect((await chainOf()).at(-1)?.obligations).toEqual([
      { text: TRASPASO.replace("publicar", "coordinar"), kind: "handoff" },
    ]);
    expect(await readFile(join(workdir, PLAN), "utf8")).toContain("> Estado: done");
  });

  it("T6.3 · «Sigue pendiente» deja la frontera abierta y no gasta ningún intento", async () => {
    await publishIncident([COMPENSACION]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    await answer({
      decisions: {
        settlement: owed.map((o) => ({ note: o.note, index: o.index, outcome: "pending" })),
      },
    });
    const directive = await answer({ choice: "Sigue pendiente" });

    // Elegir «no cerrar» es elegir no cerrar: el recorrido espera acá. Y decir la
    // verdad no puede costar un intento, o el próximo agente miente.
    expect(directive?.error?.code).toBe("PLAN_EXEC_SETTLEMENT_PENDING");
    expect((await current()).resolved.stopped?.id).toBe("plan-exec.settlement-question");
    expect(directive?.attempt_accounting?.spent).toBe(0);
    expect(await readFile(join(workdir, PLAN), "utf8")).not.toContain("> Estado: done");
  });

  it("T6.3 · «Cumplida» sobre algo que nadie probó se rechaza, y también gratis", async () => {
    await publishIncident([COMPENSACION]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    // La autoría la propuso pendiente, así que no hay evidencia declarada.
    await answer({
      decisions: {
        settlement: owed.map((o) => ({ note: o.note, index: o.index, outcome: "pending" })),
      },
    });
    const directive = await answer({ choice: "Cumplida con la evidencia declarada" });

    // Una obligación se salda con lo que lo prueba: ratificar «cumplida» sobre
    // algo que nadie probó es la única lectura que esta frontera debe negar, y
    // la niega sin cobrar, porque el camino de salida es volver y declararla.
    expect(directive?.error?.code).toBe("PLAN_EXEC_SETTLEMENT_PENDING");
    expect(directive?.error?.message).toContain("no hay evidencia declarada");
    expect(directive?.attempt_accounting?.spent).toBe(0);
    expect((await current()).resolved.stopped?.id).toBe("plan-exec.settlement-question");
  });

  it("T6.3 · con DOS ambiguas la pregunta se abre una sola vez y alcanza a las dos", async () => {
    const OTRA = "revisar el instalador contra el host nuevo";
    await publishIncident([COMPENSACION, OTRA]);
    const walk = walker();
    await walk.walkTo(RUN, "plan-exec.settlement-authoring");

    const owed = (await current()).state.settlement?.compensations ?? [];
    expect(owed.map((o) => o.text)).toEqual([COMPENSACION, OTRA]);
    await answer({
      decisions: {
        settlement: owed.map((o) => ({ note: o.note, index: o.index, outcome: "pending" })),
      },
    });
    expect((await current()).resolved.stopped?.id).toBe("plan-exec.settlement-question");

    // UNA pregunta para las dos, que es la degradación que el plan declaró: la
    // lectura elegida se aplica a todas las ambiguas de una vez.
    await answer({ choice: "Es un traspaso" });
    expect((await current()).resolved.stopped?.id).not.toBe("plan-exec.settlement-question");
    await walk.walkTo(RUN, "plan-exec.plan-done");
    await walk.step(RUN);

    expect((await chainOf()).at(-1)?.obligations).toEqual([
      { text: COMPENSACION, kind: "handoff" },
      { text: OTRA, kind: "handoff" },
    ]);
    expect(await readFile(join(workdir, PLAN), "utf8")).toContain("> Estado: done");
  });

  // ── T6.4 · sin corrida abierta, la salida es `aw settle` ───────────────────

  it("T6.4 · `aw settle` deja el plan cerrable y sólo cambia el índice de decisiones", async () => {
    await publishIncident([COMPENSACION, TRASPASO]);
    // El workspace del incidente: el plan entero validado, sin ninguna corrida.
    await writeFile(
      join(workdir, PLAN),
      PLAN_TEXT.replace("> Estado: pendiente", "> Estado: validada").replace(
        "- [ ] T1.1",
        "- [x] T1.1",
      ),
      "utf8",
    );

    const listed = await listSettle(fs, deps.env, paths, PLAN);
    if (listed.status !== "listed") throw new Error(JSON.stringify(listed));
    expect(listed.listing.closable).toBe(false);
    expect(listed.listing.compensations.map((o) => o.text)).toEqual([COMPENSACION]);
    expect(listed.listing.handoffs.map((o) => o.text)).toEqual([TRASPASO]);

    const before = await treeOf(workdir);
    // Las DOS: el sucesor tiene que decir la clase de todo lo que arrastra, así
    // que la lectura del traspaso legado también se ratifica acá. Sin eso el
    // saldo estamparía como declarada una clase que nadie confirmó.
    const declarations = {
      settle: ["DEC-001[0]=npm test en verde"],
      handoff: ["DEC-001[1]"],
      pending: [] as string[],
    };
    const prepared = await prepareSettle(fs, deps.env, paths, PLAN, declarations);
    if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
    // La vista previa no escribe nada: el árbol es idéntico.
    expect(await treeOf(workdir)).toEqual(before);

    const applied = await applySettle(fs, deps.env, paths, {
      target: PLAN,
      approval: prepared.digest,
      declarations,
    });
    if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
    expect(applied.reconciliation.closable).toBe(true);

    // Y el único archivo que cambió es el índice de decisiones: ni el plan, ni la
    // spec, ni `.workflow/`. Eso es lo que hacía falta editar a mano.
    const after = await treeOf(workdir);
    // Sobre la UNIÓN de las claves: recorrer sólo las de después no ve un
    // borrado, y «sólo cambió el índice» tiene que cubrir también lo que
    // desaparece — un saldo que borrara el plan pasaría inadvertido.
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (path) => before.get(path) !== after.get(path),
    );
    expect(changed).toEqual([noteIndexPath("docs/decisions", "080", "incidente")]);
  });

  /** Cada archivo del workspace con su contenido, para comparar antes y después. */
  async function treeOf(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walkDir = async (rel: string): Promise<void> => {
      for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walkDir(path);
        else out.set(path, await readFile(join(dir, path), "utf8"));
      }
    };
    await walkDir("");
    return out;
  }
});
