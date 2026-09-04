// El pasado validado conserva su historia y la ejecución sigue sola (F6 del
// plan 032, S033/AC-08 y S033/AC-10).
//
// La tentación es reabrir: destildar la tarea, volver la fase a `pendiente`. Eso
// reescribiría lo que pasó — esas casillas registran que el trabajo se hizo y se
// validó el día que se hizo, y eso sigue siendo verdad. Lo que cambió es que el
// contrato que satisfacía ya no es el vigente. Así que nada histórico se mueve:
// la decisión crea trabajo NUEVO, que lleva el contrato efectivo y no el
// documento del plan, y el plan deja de ser cerrable hasta saldarlo.
//
// Validación de fase de F6, sobre un plan fixture con una fase `validada`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  noteIndexArtifact,
  noteIndexPath,
  sealNote,
} from "../../src/application/decision-note-service.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  type NoteObligation,
  computeNoteDigest,
  normalizeObligations,
} from "../../src/domain/decision-note.js";
import {
  type BaselineInput,
  composeEffectiveContract,
} from "../../src/domain/effective-contract.js";
import {
  consumeContinuation,
  newRunState,
  withContinuation,
} from "../../src/domain/flow/run-state.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { obligationExit, reconciliationOf } from "../../src/domain/reconciliation.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const SPEC = {
  path: "docs/specs/033-spec-x.md",
  number: "033",
  digest: `sha256:${"1".repeat(64)}`,
};
const PLAN = {
  path: "docs/plans/032-plan-x.md",
  number: "032",
  digest: `sha256:${"2".repeat(64)}`,
};

const BASELINE: BaselineInput = { ...SPEC, criteria: ["S033/AC-01", "S033/AC-02"] };

function note(over: Partial<DecisionNote> = {}): DecisionNote {
  const body: Omit<DecisionNote, "digest"> = {
    schema: NOTE_SCHEMA,
    id: "DEC-001",
    lineage: { spec: SPEC, plan: PLAN, execution: { session: "131-x", phase: "F5" } },
    decision: "el gate se detiene",
    reason: "cierre y no tamaño",
    supersedes_assertions: ["S033/AC-01"],
    supersedes_note: null,
    scope: "functional",
    consumers: [PLAN.path],
    evidence_preserved: [],
    evidence_invalidated: ["F2 · el resultado de la fase validada"],
    obligations: [
      { text: "revalidar el recorrido PLAN completo", kind: "compensation", declared: true },
    ],
    resume_point: "F2/T2.3",
    date: "2026-08-16",
    ...over,
  };
  return { ...body, digest: computeNoteDigest(body) };
}

/** El contexto vivo de una salida: el plan, su punto de HOY y quién lo tiene. */
const EXIT = {
  plan: PLAN.path,
  current_point: "F6 — la que falta",
  run: null,
};

function reconcile(chain: readonly DecisionNote[], plan?: string) {
  const composed = composeEffectiveContract(BASELINE, chain);
  if (composed.status !== "composed") {
    throw new Error(`no compone: ${JSON.stringify(composed.failures)}`);
  }
  return reconciliationOf(composed.contract, chain, plan);
}

describe("reconciliationOf — el trabajo compensatorio conserva su causa", () => {
  it("una nota sin obligaciones deja el plan cerrable", () => {
    const r = reconcile([note({ obligations: [] })]);

    expect(r.pending).toEqual([]);
    expect(r.closable).toBe(true);
    expect(obligationExit(r, EXIT)).toBeNull();
  });

  it("cada obligación pendiente nombra la nota que la creó y dónde se retoma", () => {
    const r = reconcile([note()]);

    expect(r.pending).toEqual([
      {
        text: "revalidar el recorrido PLAN completo",
        by: "DEC-001",
        index: 0,
        declared_point: "F2/T2.3",
        kind: "compensation",
        legacy: false,
      },
    ]);
    expect(r.handoffs).toEqual([]);
    expect(r.closable).toBe(false);
  });

  it("la obligación que manda es la PRIMERA alcanzada, no la más nueva", () => {
    const first = note({
      obligations: [{ text: "revalidar F2", kind: "compensation", declared: true }],
      resume_point: "F2/T2.3",
    });
    const second = note({
      id: "DEC-002",
      supersedes_assertions: ["S033/AC-02"],
      obligations: [{ text: "revalidar F4", kind: "compensation", declared: true }],
      resume_point: "F4/T4.1",
      date: "2026-08-17",
    });

    const r = reconcile([first, second]);

    expect(r.pending.map((o) => o.by)).toEqual(["DEC-001", "DEC-002"]);
    // Saldar por DEC-002 pisaría trabajo que DEC-001 todavía debe, así que la
    // salida se nombra por la primera y cuenta las que quedan detrás.
    expect(obligationExit(r, EXIT)?.owed).toBe("DEC-001 — revalidar F2 (+1 más)");
    // Y el punto declarado por cada nota queda en el detalle, sin mandar a nadie.
    expect(r.pending.map((o) => o.declared_point)).toEqual(["F2/T2.3", "F4/T4.1"]);
  });

  it("saldar una obligación es publicar una nota que sustituye a la suya sin arrastrarla", () => {
    const owing = note();
    expect(reconcile([owing]).closable).toBe(false);

    const settled = note({
      id: "DEC-002",
      supersedes_note: "DEC-001",
      decision: "el trabajo compensatorio quedó hecho",
      obligations: [],
      date: "2026-08-17",
    });

    const r = reconcile([owing, settled]);
    expect(r.pending).toEqual([]);
    expect(r.closable).toBe(true);
  });
});

describe("continuidad acotada: mueve la posición en el PLAN, nunca el cursor", () => {
  it("apunta a la primera obligación y no toca applied, skipped ni boundary", () => {
    const before = newRunState("plan-exec", "131-x");
    const after = withContinuation(before, reconcile([note()]));

    expect(after.continuation).toEqual({ resume_point: "F2/T2.3", by: "DEC-001" });
    // Lo que NO se movió: el recorrido sigue siendo una pasada lineal.
    expect(after.applied).toEqual(before.applied);
    expect(after.skipped).toEqual(before.skipped);
    expect(after.boundary).toBe(before.boundary);
    expect(after.attempts).toEqual(before.attempts);
  });

  it("una reconciliación sin nada pendiente limpia la continuidad sola", () => {
    const owing = withContinuation(newRunState("plan-exec", "131-x"), reconcile([note()]));
    expect(owing.continuation).not.toBeNull();

    const settled = withContinuation(owing, reconcile([note({ obligations: [] })]));
    expect(settled.continuation).toBeNull();
  });

  it("re-apuntar a la MISMA obligación no re-sella el estado", () => {
    const first = withContinuation(newRunState("plan-exec", "131-x"), reconcile([note()]));
    const again = withContinuation(first, reconcile([note()]));

    expect(again).toBe(first);
  });

  it("consumir la continuidad la borra sin tocar el cursor", () => {
    const owing = withContinuation(newRunState("plan-exec", "131-x"), reconcile([note()]));
    const consumed = consumeContinuation(owing);

    expect(consumed.continuation).toBeNull();
    expect(consumed.applied).toEqual(owing.applied);
    expect(consumed.digest).not.toBe(owing.digest);
    // Consumir dos veces no hace nada la segunda.
    expect(consumeContinuation(consumed)).toBe(consumed);
  });
});

describe("sobre un plan fixture con una fase validada", () => {
  let root: string;
  let fs: NodeFileSystem;
  let env: FakeEnv;
  let paths: PathsService;

  const SPEC_TEXT = [
    "# 033 — spec fixture",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] **S033/AC-01 — una.** texto",
    "- [ ] **S033/AC-02 — otra.** texto",
    "",
  ].join("\n");

  /** Un plan CERRADO: declara done, todas las casillas y su fase validada. */
  const planText = (specDigest: string): string =>
    [
      "# 032 — plan fixture",
      "",
      "> Derived from: docs/specs/033-spec-x.md",
      `> Baseline: docs/specs/033-spec-x.md@${specDigest}`,
      "> Estado: done",
      "> Cierre: cerrado tras validar su única fase",
      "",
      "## Tasks",
      "",
      "### F1 — la única fase",
      "> Estado: validada",
      "",
      "**Trabajo:**",
      "- [x] T1.1 — el trabajo que se hizo y se validó",
      "",
    ].join("\n");

  const board = () => buildWorklineIndex(fs, env, paths, { now: new Date("2026-08-16T12:00:00Z") });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reconc-board-"));
    fs = new NodeFileSystem();
    env = new FakeEnv(root, root);
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    writeFileSync(join(root, "docs/specs/033-spec-x.md"), SPEC_TEXT);
    writeFileSync(
      join(root, "docs/plans/032-plan-x.md"),
      planText(`sha256:${baseDigest(SPEC_TEXT)}`),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /**
   * Publica una cadena con UNA nota que invalida el resultado de F1.
   *
   * Escribe por `noteIndexArtifact`, que es el escritor real: serializar la nota
   * a mano la sacaría de la forma con la que fue sellada y el índice no
   * verificaría — que es exactamente lo que el escritor existe para evitar.
   */
  const publishNote = (
    obligations: readonly (string | NoteObligation)[],
    text: string = planText(`sha256:${baseDigest(SPEC_TEXT)}`),
  ): DecisionNote => {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: "docs/specs/033-spec-x.md", number: "033" },
      notes: [] as DecisionNote[],
    };
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: {
          path: "docs/specs/033-spec-x.md",
          number: "033",
          // Lo que pinea el servicio real: el digest FUNCIONAL. El plan de al
          // lado sigue sellado byte-exacto (legado) y la composición casa igual.
          digest: functionalSpecDigest(SPEC_TEXT),
        },
        plan: {
          path: "docs/plans/032-plan-x.md",
          number: "032",
          digest: `sha256:${baseDigest(planText(`sha256:${baseDigest(SPEC_TEXT)}`))}`,
        },
        execution: { session: "131-x", phase: "F1" },
      },
      decision: "el resultado de F1 ya no satisface el contrato",
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: ["S033/AC-01"],
      supersedes_note: null,
      scope: "functional",
      consumers: ["docs/plans/032-plan-x.md"],
      evidence_preserved: [],
      evidence_invalidated: ["F1/T1.1"],
      obligations: normalizeObligations(obligations) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    writeFileSync(join(root, "docs/plans/032-plan-x.md"), text);
    const artifact = noteIndexArtifact(noteIndexPath("docs/decisions", "033", "x"), {
      ...index,
      notes: [sealed],
    });
    writeFileSync(join(root, artifact.path), artifact.content);
    return sealed;
  };

  it("sin ninguna nota, el plan cerrado se lee done", async () => {
    const plans = (await board()).plans;
    const plan = plans.find((p) => p.number === "032");

    expect(plan?.plan_state).toBe("done");
    expect(plan?.reconciliation).toEqual({ pending: [], handoffs: [], closable: true });
  });

  it("una nota con obligación abierta impide declarar el plan cerrable", async () => {
    publishNote(["revalidar F1 contra el contrato nuevo"]);
    const plan = (await board()).plans.find((p) => p.number === "032");

    // El documento dice `done` y el contrato dice que no: eso es `inconsistent`.
    expect(plan?.plan_state).toBe("inconsistent");
    expect(plan?.reconciliation?.closable).toBe(false);
    expect(plan?.reconciliation?.pending).toEqual([
      {
        text: "revalidar F1 contra el contrato nuevo",
        by: "DEC-001",
        index: 0,
        declared_point: "F1/T1.1",
        // Publicada en forma de texto: la clase no la declaró nadie y el plan no
        // enumera ese trabajo, así que se lee compensación — la mitad segura.
        kind: "compensation",
        legacy: true,
      },
    ]);
    // La nota dijo F1/T1.1, y F1 es la ÚNICA fase del plan y está validada. El
    // punto vigente del tablero es el cierre, y es lo que las salidas nombran.
    expect(plan?.current_point).toBe("el cierre del plan");
  });

  it("la fase sigue VALIDADA y su casilla marcada: no se destilda ni se edita nada", async () => {
    const before = readFileSync(join(root, "docs/plans/032-plan-x.md"), "utf8");
    publishNote(["revalidar F1 contra el contrato nuevo"]);
    const plan = (await board()).plans.find((p) => p.number === "032");

    expect(plan?.phases_validated).toBe(1);
    expect(plan?.phases_total).toBe(1);
    expect(plan?.tasks_done).toBe(1);
    expect(plan?.tasks_total).toBe(1);
    // Y el documento es byte-idéntico: leer el tablero no reescribe la historia.
    expect(readFileSync(join(root, "docs/plans/032-plan-x.md"), "utf8")).toBe(before);
  });

  it("una nota SIN obligaciones no bloquea el cierre: lo que gatea es la compensación", async () => {
    publishNote([]);
    const plan = (await board()).plans.find((p) => p.number === "032");

    expect(plan?.reconciliation?.closable).toBe(true);
    expect(plan?.plan_state).toBe("done");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El reparto entre compensación y traspaso (plan 042 · F1 · S042/AC-02 y AC-04).
//
// Sólo una compensación es trabajo que este linaje debe, y sólo una compensación
// puede tener el cierre cerrado. Un traspaso es trabajo de otra gente: se ve, y
// no bloquea — porque una corrida que no puede saldarlo nunca podría cerrar, que
// es exactamente el bloqueo que este reparto termina.

const HANDOFF = (text: string): NoteObligation => ({ text, kind: "handoff", declared: true });
const COMPENSATION = (text: string): NoteObligation => ({
  text,
  kind: "compensation",
  declared: true,
});

describe("compensaciones y traspasos se cuentan por separado", () => {
  it("un plan cuyas únicas obligaciones vigentes son traspasos es cerrable", () => {
    const r = reconcile([note({ obligations: [HANDOFF("Producto y QA validan el flujo nuevo")] })]);

    expect(r.pending).toEqual([]);
    expect(r.closable).toBe(true);
    expect(r.handoffs.map((o) => o.text)).toEqual(["Producto y QA validan el flujo nuevo"]);
    // Cerrable, y sin embargo hay algo que decir: el traspaso sigue vivo y su
    // salida existe. Lo que NO hace es bloquear.
    expect(obligationExit(r, EXIT)?.kind).toBe("handoff");
  });

  it("mezcladas, sólo la compensación bloquea y el traspaso sigue visible", () => {
    const r = reconcile([
      note({
        obligations: [
          HANDOFF("Producto y QA validan el flujo nuevo"),
          COMPENSATION("revalidar F2 contra el contrato nuevo"),
        ],
      }),
    ]);

    expect(r.pending.map((o) => o.text)).toEqual(["revalidar F2 contra el contrato nuevo"]);
    expect(r.handoffs.map((o) => o.text)).toEqual(["Producto y QA validan el flujo nuevo"]);
    expect(r.closable).toBe(false);
    // La salida la fija la compensación: nadie vuelve por un traspaso.
    expect(obligationExit(r, EXIT)?.kind).toBe("compensation");
    expect(obligationExit(r, EXIT)?.owed).toContain("revalidar F2 contra el contrato nuevo");
  });
});

// La correspondencia de una obligación LEGADA es identidad verbatim contra algo
// que el plan ya enumera, nunca un juicio sobre palabras (D3 del plan 042).
describe("una obligación legada se lee contra lo que el plan ya enumera", () => {
  const HANDOFF_ITEM = "publicar la release del paquete y actualizar el aw global";
  const planWith = (items: readonly string[]): string =>
    [
      "# 032 — plan fixture",
      "",
      "## Handoff operativo",
      "",
      ...items.map((item) => `- ${item}`),
      "",
      "## Tasks",
      "",
      "- [x] T1.1 — trabajo que sí es de este linaje",
      "",
    ].join("\n");

  /** Una nota como quedó publicada antes de que las clases existieran. */
  const legacy = (text: string) => note({ obligations: normalizeObligations([text]) ?? [] });

  it("coincidencia verbatim: se lee traspaso y no bloquea, nombrando el ítem", () => {
    const r = reconcile([legacy(HANDOFF_ITEM)], planWith([HANDOFF_ITEM]));

    expect(r.pending).toEqual([]);
    expect(r.closable).toBe(true);
    expect(r.handoffs[0]?.legacy).toBe(true);
    expect(r.handoffs[0]?.corresponds_to).toBe(HANDOFF_ITEM);
  });

  it("contención en cualquier dirección: el plan cita a la nota, o la nota al plan", () => {
    const longer = `${HANDOFF_ITEM} antes de la próxima corrida`;

    expect(reconcile([legacy(HANDOFF_ITEM)], planWith([longer])).closable).toBe(true);
    expect(reconcile([legacy(longer)], planWith([HANDOFF_ITEM])).closable).toBe(true);
  });

  it("las preguntas abiertas cuentan igual: son trabajo que el plan NO tomó", () => {
    const plan = ["# 032", "", "## Open questions", "", `- ${HANDOFF_ITEM}`, ""].join("\n");

    expect(reconcile([legacy(HANDOFF_ITEM)], plan).closable).toBe(true);
  });

  it("sin coincidencia se lee compensación marcada como legada, y bloquea", () => {
    const r = reconcile(
      [legacy("revisar a mano el ledger de la sesión")],
      planWith([HANDOFF_ITEM]),
    );

    expect(r.handoffs).toEqual([]);
    expect(r.pending[0]?.kind).toBe("compensation");
    expect(r.pending[0]?.legacy).toBe(true);
    expect(r.pending[0]?.corresponds_to).toBeUndefined();
    expect(r.closable).toBe(false);
  });

  it("por debajo del mínimo no cuenta: un fragmento común no es una cita", () => {
    // 22 caracteres, contenidos verbatim en el ítem del plan y aun así por
    // debajo del piso: una coincidencia corta no es una cita.
    const short = "publicar la release de";
    expect(short).toHaveLength(22);
    expect(HANDOFF_ITEM).toContain(short);

    expect(reconcile([legacy(short)], planWith([HANDOFF_ITEM])).closable).toBe(false);
  });

  it("un ítem envuelto en varias líneas casa igual: los espacios se normalizan", () => {
    const wrapped = [
      "# 032",
      "",
      "## Handoff operativo",
      "",
      "- publicar la release del paquete",
      "  y actualizar el aw global",
      "",
    ].join("\n");

    // El plan enumera el mismo trabajo partido en dos líneas; la nota lo dice
    // de corrido. Sin normalizar espacios serían dos frases distintas.
    expect(reconcile([legacy(HANDOFF_ITEM)], wrapped).closable).toBe(true);
  });

  it("un bloque de código que CITA una sección no abre esa sección", () => {
    const quoting = [
      "# 032",
      "",
      "## Tasks",
      "",
      "El esqueleto de un plan se ve así:",
      "",
      "```md",
      "## Handoff operativo",
      "",
      `- ${HANDOFF_ITEM}`,
      "```",
      "",
    ].join("\n");

    expect(reconcile([legacy(HANDOFF_ITEM)], quoting).closable).toBe(false);
  });

  it("la prosa de la sección no cuenta: sólo sus ítems enumerados", () => {
    const plan = ["# 032", "", "## Handoff operativo", "", HANDOFF_ITEM, ""].join("\n");

    expect(reconcile([legacy(HANDOFF_ITEM)], plan).closable).toBe(false);
  });

  it("un ítem de otra sección tampoco: el trabajo de las tareas es de este linaje", () => {
    const plan = ["# 032", "", "## Tasks", "", `- ${HANDOFF_ITEM}`, ""].join("\n");

    expect(reconcile([legacy(HANDOFF_ITEM)], plan).closable).toBe(false);
  });

  it("sin plan a la vista, una legada conserva la lectura segura", () => {
    expect(reconcile([legacy(HANDOFF_ITEM)]).closable).toBe(false);
  });

  it("la salida marca la lectura: el tablero no la afirma como palabra de la nota", () => {
    // El peor caso es justo el que NO bloquea: un traspaso legado vuelve el plan
    // cerrable, y afirmarlo como si lo dijera la nota esconde que nadie lo
    // ratificó. La única superficie que lo marcaba era `aw settle`.
    const r = reconcile([legacy(HANDOFF_ITEM)], planWith([HANDOFF_ITEM]));
    const exit = obligationExit(r, {
      plan: PLAN.path,
      current_point: "el cierre del plan",
      run: null,
    });

    expect(r.handoffs[0]?.legacy).toBe(true);
    expect(exit?.kind).toBe("handoff");
    expect(exit?.headline).toContain("clase no declarada, leída traspaso");
  });

  it("una clase DECLARADA no lleva marca: es la palabra de la nota", () => {
    const r = reconcile([note({ obligations: [HANDOFF(HANDOFF_ITEM)] })]);
    const exit = obligationExit(r, {
      plan: PLAN.path,
      current_point: "el cierre del plan",
      run: null,
    });

    expect(exit?.headline).not.toContain("clase no declarada");
  });

  it("una clase DECLARADA no se revisa contra el plan: es la palabra de la nota", () => {
    const r = reconcile(
      [note({ obligations: [COMPENSATION(HANDOFF_ITEM)] })],
      planWith([HANDOFF_ITEM]),
    );

    expect(r.closable).toBe(false);
    expect(r.pending[0]?.legacy).toBe(false);
  });
});

// F4 · T4.4 — el rechazo del sello, el titular del tablero y la acción del
// pipeline nombran la MISMA salida, y salen de acá. Lo que se fija es lo que
// cada uno de esos tres textos hacía distinto: el punto al que se manda, el
// comando que se ofrece, y si la clase bloquea o no.
describe("obligationExit — una sola salida para los tres textos", () => {
  const owing = () => reconcile([note()]);

  it("nombra el punto VIGENTE del plan, nunca el que la nota grabó al nacer", () => {
    const exit = obligationExit(owing(), EXIT);

    expect(exit?.point).toBe("F6 — la que falta");
    expect(exit?.headline).toContain("retomá en F6 — la que falta");
    // F2/T2.3 es lo que dijo la nota, y esa fase está validada e integrada: sigue
    // en el detalle de la obligación y NO aparece en ningún texto de salida.
    expect(owing().pending[0]?.declared_point).toBe("F2/T2.3");
    expect(exit?.headline).not.toContain("F2/T2.3");
    expect(exit?.action).not.toContain("F2/T2.3");
  });

  it("sin corrida abierta la salida es `aw settle`, y nunca es nada", () => {
    const exit = obligationExit(owing(), EXIT);

    expect(exit?.command).toBe(`aw settle prepare ${PLAN.path}`);
    expect(exit?.action).toContain(`aw settle prepare ${PLAN.path}`);
  });

  it("con una corrida abierta la salida es el comando de ESA corrida", () => {
    const exit = obligationExit(owing(), {
      ...EXIT,
      run: {
        session: "167-x",
        command: "aw flow advance --code 167-x",
        why: "tiene una corrida de ejecución abierta sobre este plan",
      },
    });

    expect(exit?.command).toBe("aw flow advance --code 167-x");
    expect(exit?.action).toContain("167-x");
    // Y sigue nombrando la otra mitad: una corrida que ya pasó la frontera de
    // saldo no puede volver, y para ésa la salida es el comando.
    expect(exit?.action).toContain(`aw settle prepare ${PLAN.path}`);
  });

  it("cita el POR QUÉ de la lectura en vez de afirmar que la corrida tiene el plan", () => {
    // Las tres lecturas de «quién tiene este plan» no son la misma afirmación:
    // una corrida lo tiene en su alcance, otra tiene un estado que no se puede
    // leer, una tercera todavía no fijó su plan. Redactar «tiene la corrida
    // abierta sobre este plan» sobre las dos últimas afirmaría justo lo que la
    // lectura se negó a afirmar.
    const exit = obligationExit(owing(), {
      ...EXIT,
      run: {
        session: "099-roto",
        command: "aw flow advance --code 099-roto --adopt",
        why: "tiene un estado de corrida que no se puede leer, así que no se puede descartar que tenga este plan",
      },
    });

    expect(exit?.action).toContain("no se puede leer");
    expect(exit?.action).not.toContain("tiene la corrida abierta");
    // Y el comando es el que la proyección calculó, con su `--adopt` y todo.
    expect(exit?.command).toBe("aw flow advance --code 099-roto --adopt");
  });

  it("el traspaso tiene salida y NO tiene bloqueo: son dos hechos distintos", () => {
    const r = reconcile([note({ obligations: [HANDOFF("Producto valida el flujo")] })]);
    const exit = obligationExit(r, EXIT);

    expect(r.closable).toBe(true);
    expect(exit?.kind).toBe("handoff");
    expect(exit?.headline).toContain("no bloquea el cierre");
    expect(exit?.command).toBe(`aw settle prepare ${PLAN.path}`);
  });

  it("un linaje ilegible nombra su REPARACIÓN, no un punto de fase", () => {
    // La forma que fabrica el tablero cuando la cadena no compone: la pendiente
    // es la propia negativa, y su reparación es la única frase accionable de
    // toda la situación. Una fase no arregla un JSON roto, así que la salida no
    // ofrece ninguna — y F4 la habría perdido tratándola como punto declarado.
    const exit = obligationExit(
      {
        pending: [
          {
            text: "NOTE_INDEX_UNREADABLE: el índice no se puede leer como JSON",
            by: "composición",
            index: 0,
            declared_point: "sin nota: la pendiente la fabrica la composición",
            repair: "reparalo a mano antes de agregar otra nota",
            kind: "compensation",
            legacy: false,
          },
        ],
        handoffs: [],
        closable: false,
      },
      EXIT,
    );

    expect(exit?.headline).toContain("LINAJE ILEGIBLE");
    expect(exit?.headline).toContain("reparalo a mano antes de agregar otra nota");
    expect(exit?.action).toContain("reparalo a mano antes de agregar otra nota");
    // Y no manda a ninguna fase: las fases no son lo que está roto.
    expect(exit?.headline).not.toContain("retomá en");
    expect(exit?.headline).not.toContain(EXIT.current_point);
    // La salida sigue existiendo: un rechazo sin comando es una pared.
    expect(exit?.command).toBe(`aw settle prepare ${PLAN.path}`);
  });

  it("no cerrable y sin obligación nombrada es la composición, no un traspaso", () => {
    // La forma que fabrica el tablero cuando la cadena no se puede leer: no
    // cerrable y con la lista vacía. Caer a los traspasos ahí describiría un plan
    // ILEGIBLE como uno que sólo delegó trabajo.
    const exit = obligationExit(
      { pending: [], handoffs: [HANDOFF("algo de afuera")], closable: false },
      EXIT,
    );

    expect(exit?.kind).toBe("compensation");
    expect(exit?.owed).toBe("el contrato efectivo no se puede componer");
  });
});
