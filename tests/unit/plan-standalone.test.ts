// Un plan nacido de la conversación es ciudadano de primera (lote D).
//
// El CLI ya permitía publicar un plan sin `Derived from` —un plan sin sello es un
// diagnóstico legítimo, no un error— pero lo trataba como defectuoso:
//
//   1. el tablero le colgaba `SIN SELLO DE BASELINE` para siempre y lo enrutaba
//      en modo `compatible`, que es el modo legacy: ruido permanente sobre algo
//      que no está mal;
//   2. no podía registrar UNA decisión: `readLineage` moría en
//      `FLOW_DECISION_LINEAGE_INVALID` exigiendo que el plan dejara de ser
//      standalone, así que un desvío componible durante la ejecución sólo tenía
//      salidas de handoff — y un handoff mata la corrida.
//
// Lo que se fija acá:
//   1. el marcador `> Standalone: <prosa>` es el CUARTO nivel de evidencia, y el
//      último: si hay spec declarada, ésa gana y el marcador queda inerte;
//   2. el tablero no emite aviso, enruta en su modo propio, `specConsumers` lo
//      ignora y el contador de `status` no lo cuenta como deuda;
//   3. la variante standalone del estado de la corrida va y vuelve, y un estado
//      viejo sin ella sigue parseando;
//   4. la ida completa sobre una corrida real: el gate registra la decisión, la
//      corrida SIGUE, el evento queda en la traza, `docs/decisions/` no nace, y
//      el plan CIERRA con su sello `done`.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { parseSpecRelation } from "../../src/application/parsers/spec-relation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { buildWorklineIndex, specConsumers } from "../../src/application/workline-index-service.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import { journeyForState } from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import {
  newRunState,
  parseRunState,
  serializeRunState,
  withDecisionPreparation,
} from "../../src/domain/flow/run-state.js";
import { specBaselineDigest } from "../../src/domain/lineage.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const SPEC_PATH = "docs/specs/070-spec-linaje.md";
const PLAN_PATH = "docs/plans/071-plan-conversacion.md";
const MARKER = "> Standalone: conversación del host · sesión 041-refactor-quick";

// ── el marcador ──────────────────────────────────────────────────────────────

/** Un plan cuyo blockquote de cabecera lleva exactamente las líneas dadas. */
function planWith(header: readonly string[], origin = "Adoptado de la conversación."): string {
  return `# Plan 071 — nacido de la conversación

${header.join("\n")}

## Origin

${origin}

## Tasks

### F1 — hacer el trabajo
> Estado: pendiente
> Fuentes: workspace

- [ ] T1.1 — hacer el trabajo _(fuentes: workspace)_
`;
}

describe("el marcador standalone — cuarto nivel de evidencia, y el último", () => {
  it("solo el marcador: el plan se declara standalone", () => {
    expect(parseSpecRelation(planWith([MARKER, "> Límite de ejecución: checkout"]))).toEqual({
      status: "standalone",
    });
  });

  it("marcador MÁS `Derived from`: gana la spec y el marcador queda inerte", () => {
    // La precedencia es una regla declarada, no una adivinanza: el marcador se lee
    // último, así que jamás puede degradar un linaje declarado. Si adivinara
    // standalone acá, un plan con spec perdería su baseline y su reconciliación.
    expect(parseSpecRelation(planWith([`> Derived from ${SPEC_PATH}`, MARKER]))).toEqual({
      status: "declared",
      number: "070",
      evidence: "derived-from",
    });
  });

  it("y también pierde contra la evidencia más débil: una spec nombrada en `## Origin`", () => {
    expect(parseSpecRelation(planWith([MARKER], "Spec 070 · la refinamos en la sesión."))).toEqual({
      status: "declared",
      number: "070",
      evidence: "spec-reference",
    });
  });

  it("el marcador citado en prosa NO cuenta: hablar de él no es adoptarlo", () => {
    const prose = planWith(
      ["> Límite de ejecución: checkout"],
      'Los planes sin spec llevan "Standalone: de dónde salieron" en su cabecera.',
    );
    expect(parseSpecRelation(prose)).toEqual({ status: "absent" });
  });

  it("y el `>` es parte de la gramática: una línea suelta en la cabecera no declara nada", () => {
    // Sin el blockquote no hay declaración: una frase sobre el marcador escrita
    // arriba del primer `##` es prosa igual que en cualquier otra parte, y
    // aceptarla haría que un plan que EXPLICA la forma la adoptara.
    expect(
      parseSpecRelation(planWith(["Standalone: conversación del host", "> Límite: checkout"])),
    ).toEqual({ status: "absent" });
  });

  it("y fuera de la cabecera no cuenta NI COMO BLOCKQUOTE: el límite es el que declara", () => {
    // El caso que el límite existe para cerrar, y el único que no muere ya por la
    // gramática del `>`: un plan legacy cuyo `## Origin` documenta la doctrina
    // citándola como blockquote. Si el marcador se leyera en todo el documento,
    // ese plan pasaría de `absent` a `standalone` solo — el tablero le retiraría
    // el aviso, `aw status --detail` dejaría de contarlo como deuda y el gate de
    // la desviación dejaría de exigirle su nota durable. Eso es exactamente el
    // "adivinar" que el marcador promete no hacer.
    const documented = planWith(
      ["> Límite de ejecución: checkout"],
      `La doctrina dice:\n\n${MARKER}\n\ny este plan no lo adoptó.`,
    );
    // El marcador está en el documento, con su `>` y todo: lo que lo desactiva es
    // dónde está, así que si el `>` faltara el caso probaría la otra regla.
    expect(documented).toContain(`\n${MARKER}\n`);
    expect(parseSpecRelation(documented)).toEqual({ status: "absent" });
  });

  it("ni dentro de un fence, aunque el fence esté en la cabecera", () => {
    const fenced = `# Plan 071 — nacido de la conversación

> Límite de ejecución: checkout

\`\`\`
${MARKER}
\`\`\`

## Origin

Adoptado de la conversación.
`;
    expect(parseSpecRelation(fenced)).toEqual({ status: "absent" });
  });

  it("un marcador con valor vacío declara nada, así que no es un marcador", () => {
    expect(parseSpecRelation(planWith(["> Standalone:"]))).toEqual({ status: "absent" });
    expect(parseSpecRelation(planWith(["> Standalone:    "]))).toEqual({ status: "absent" });
  });
});

// ── el tablero ───────────────────────────────────────────────────────────────

const fakeEnv = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 8, 1, 12, 0, 0);

/** La spec real del workspace, para que `specConsumers` tenga a quién preguntar. */
const SPEC = `---
status: ready-for-plan
---

# Spec 070 — el linaje

## Requirement

Un plan standalone es ciudadano de primera.

## Scope

El tablero y el gate de la desviación.

## Acceptance criteria

- [ ] AC-01: un plan standalone no lleva aviso de baseline.
`;

const memPaths = new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");

function memFs(planText: string): MemFs {
  const fs = new MemFs({ lenient: true });
  fs.file("/cwd/.workflow/sessions/.keep", "");
  fs.file(`/cwd/${SPEC_PATH}`, SPEC);
  fs.file(`/cwd/${PLAN_PATH}`, planText);
  return fs;
}

function memBoard(planText: string) {
  return buildWorklineIndex(memFs(planText), fakeEnv, memPaths, { now: NOW });
}

/** Lo que `aw status --detail` imprime sobre este workspace, palabra por palabra. */
async function memStatus(planText: string): Promise<string> {
  const data = await runStatusCommand(memFs(planText), fakeEnv, memPaths, { now: NOW });
  return statusCommand.renderHuman?.({ ok: true, data, exitCode: 0 }, { detail: true }) ?? "";
}

describe("el tablero — un standalone no es deuda ni ruido", () => {
  it("no trae aviso, su modo es el propio y su `next` es el normal", async () => {
    const board = await memBoard(planWith([MARKER, "> Límite de ejecución: checkout"]));
    const item = board.pipeline.find((entry) => entry.file === PLAN_PATH);
    if (item === undefined) throw new Error("el plan tiene que estar en el pipeline");

    expect(item.detail.warning).toBeUndefined();
    expect(item.action).toEqual({
      kind: "continue",
      command: `/w:plan-exec ${PLAN_PATH}`,
      mode: "standalone",
    });
    expect(item.detail.obligation).toBe(false);
    expect(item.detail.next).toBe("continuar por la primera fase no validada");
    expect(board.plans[0]?.spec).toEqual({ status: "standalone" });
    // Su sello sigue ausente, y eso sigue siendo cierto: lo que cambia es lo que
    // el tablero HACE con esa verdad, no la verdad.
    expect(board.plans[0]?.baseline).toEqual({ status: "unsealed" });
  });

  it("un plan legacy sin marcador conserva su aviso y su modo compatible", async () => {
    // El contraste que hace al enunciado: la ruta legacy no se movió, así que
    // «no lleva aviso» es una propiedad del marcador y no del sello ausente.
    const board = await memBoard(planWith(["> Límite de ejecución: checkout"]));
    const item = board.pipeline.find((entry) => entry.file === PLAN_PATH);
    expect(item?.detail.warning?.code).toBe("WORKLINE_BASELINE_LEGACY_UNSEALED");
    expect(item?.action).toMatchObject({ mode: "compatible" });
  });

  it("`specConsumers` lo ignora: no deriva de ninguna spec, así que no consume ninguna", async () => {
    const board = await memBoard(planWith([MARKER]));
    expect(specConsumers("070", board.plans)).toEqual([]);
  });

  it("el contador de planes sin spec demostrada lo excluye", async () => {
    // El legacy sin marcador SÍ se cuenta: nadie puede probar de qué derivó, y
    // eso es deuda real. El contraste es lo que hace al enunciado.
    expect(await memStatus(planWith(["> Límite de ejecución: checkout"]))).toContain(
      "Planes sin spec demostrada",
    );
    expect(await memStatus(planWith([MARKER]))).not.toContain("Planes sin spec demostrada");
  });
});

// ── la persistencia del estado ───────────────────────────────────────────────

describe("la variante standalone del estado — aditiva, y de ida y vuelta", () => {
  it("una preparación standalone se serializa y vuelve idéntica", () => {
    const state = withDecisionPreparation(newRunState("plan-exec", "041-conversacion-plan-exec"), {
      kind: "standalone",
      decision: "el helper vive en el módulo vecino",
      resume_point: "F1/T1.1",
    });
    const back = parseRunState(serializeRunState(state));
    if (!back.ok) throw new Error(`esperaba un estado válido: ${back.failure.code}`);
    expect(back.state).toEqual(state);
    expect(back.state.decision_preparation).toEqual({
      kind: "standalone",
      decision: "el helper vive en el módulo vecino",
      resume_point: "F1/T1.1",
    });
  });

  it("una standalone sin punto de reanudación no es un estado legible", () => {
    const state = newRunState("plan-exec", "041-conversacion-plan-exec");
    const broken = { ...state, decision_preparation: { kind: "standalone", decision: "x" } };
    expect(parseRunState(JSON.stringify(broken)).ok).toBe(false);
  });

  it("un estado viejo sin la variante sigue parseando: el cambio es aditivo", () => {
    const state = newRunState("plan-exec", "041-conversacion-plan-exec");
    const back = parseRunState(serializeRunState(state));
    if (!back.ok) throw new Error(`esperaba un estado válido: ${back.failure.code}`);
    expect(back.state.decision_preparation).toBeNull();
  });

  it("y el linaje decide la consecuencia del gate: sólo el standalone pierde la nota", () => {
    // El contraste que hace al enunciado: la fila se escribe UNA vez y promete
    // «una nota de decisión durable sobre el contrato efectivo». Con spec eso es
    // cierto y el texto de la fila viaja verbatim; sin spec no hay contrato al
    // cual sumarla, y prometerla igual sería hacerle aprobar a la persona algo
    // que no va a pasar. La señal es el linaje ya sellado en la preparación.
    const base = newRunState("plan-exec", "041-conversacion-plan-exec");
    const gate = journeyForState(base).find((row) => row.id === "plan-exec.deviation-gate");
    if (gate === undefined)
      throw new Error("el gate de la desviación tiene que estar en el recorrido");

    const standalone = resolveBoundary(
      withDecisionPreparation(base, {
        kind: "standalone",
        decision: "el helper vive en el módulo vecino",
        resume_point: "F1/T1.1",
      }),
      [gate],
    );
    expect(standalone.choices[0]?.label).toBe("Registrar la decisión y seguir");
    expect(standalone.choices[0]?.consequence).not.toContain("durable");
    expect(standalone.choices[0]?.consequence).toContain("DECISION.md");

    const conNota = resolveBoundary(
      withDecisionPreparation(base, {
        kind: "reused",
        note: "docs/decisions/001-decision.md",
        decision: "el helper vive en el módulo vecino",
        resume_point: "F1/T1.1",
      }),
      [gate],
    );
    expect(conNota.choices[0]?.consequence).toContain("durable");
    expect(conNota.choices[0]?.consequence).not.toContain("DECISION.md");
  });
});

// ── la ida completa, sobre una corrida real ──────────────────────────────────

const SESSION = "041-conversacion-plan-exec";
const CODE = "041";
const RECOGNITION = "plan-exec.deviation-recognition";
const GATE = "plan-exec.deviation-gate";
const WORKSPACE_BLOCK = `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Un plan nacido de la conversación.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| acme | /tmp/acme | main |

## Status

- Ramas de trabajo actuales:
  - acme: main
<!-- AGENT-WORKFLOW-PROJECT-END -->
`;

/** El plan standalone del workspace real: sin `Derived from`, con su marcador. */
const REAL_PLAN = `# Plan 071 — nacido de la conversación

${MARKER}
> Límite de ejecución: checkout

## Origin

Adoptado de la conversación del host, sin spec previa.

## Tasks

### F1 — hacer el trabajo
> Estado: pendiente
> Fuentes: workspace

- [ ] T1.1 — hacer el trabajo _(fuentes: workspace)_
`;

describe("la ida completa — un desvío componible se registra y la corrida SIGUE", () => {
  const fs = new NodeFileSystem();
  let workdir: string;
  let paths: PathsService;
  let walk: ReturnType<typeof planExecWalk>;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-standalone-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — plan standalone\n\n## Objective\nejecutar un plan sin spec\n",
      "utf8",
    );
    await writeFile(join(workdir, "CLAUDE.md"), WORKSPACE_BLOCK, "utf8");
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(join(workdir, PLAN_PATH), REAL_PLAN, "utf8");
    walk = planExecWalk(
      { fs, env: new FakeEnv(workdir, workdir), git: new GitCliAdapter(new NodeProcess()), paths },
      { sources: ["workspace"], signals: ["plan.deviation-composable"] },
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const run = { code: CODE, folder: SESSION, plan: PLAN_PATH };

  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
  }

  async function submit(body: unknown, approval: string | null = null) {
    const result = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify(body),
      approval,
      executor: walk.executor(),
    });
    if (!result.ok) throw new Error(`un rechazo de negocio viaja ok:true: ${result.failure?.code}`);
    return result.directive;
  }

  /** El draft que el agente manda al reconocer la desviación. */
  function draft(overrides: Record<string, unknown> = {}) {
    return {
      question: {
        assertions: ["el helper va en el módulo nuevo"],
        behaviors: [
          { key: "componer", summary: "se registra la decisión y la ejecución sigue" },
          { key: "escalar", summary: "se abre una spec propia" },
        ],
      },
      draft: {
        decision: "el helper vive en el módulo vecino, no en uno nuevo",
        reason: "el módulo vecino ya tiene su único lector",
        resume_point: "F1/T1.1",
        ...overrides,
      },
    };
  }

  /** Contestar el reconocimiento con la desviación componible y su decisión. */
  async function recognize(decision: unknown) {
    await walk.walkTo(run, RECOGNITION);
    const { resolved } = await current();
    expect(resolved.stopped?.id).toBe(RECOGNITION);
    return await submit({
      input_digest: resolved.seal,
      signals: ["plan.deviation-composable"],
      decisions: { paso: RECOGNITION, decision },
    });
  }

  it("el gate ofrece registrar y seguir, la corrida SIGUE, y nada durable se escribe", async () => {
    await recognize(draft());
    const atGate = await current();
    expect(atGate.state.decision_preparation).toEqual({
      kind: "standalone",
      decision: "el helper vive en el módulo vecino, no en uno nuevo",
      resume_point: "F1/T1.1",
    });

    // El gate llegó, es humano, y su alternativa recomendada es componer.
    await walk.walkTo(run, GATE);
    const gate = await current();
    expect(gate.resolved.stopped?.id).toBe(GATE);
    expect(gate.resolved.kind).toBe("human");
    expect(gate.resolved.choices[0]?.label).toBe("Registrar la decisión y seguir");
    // Y su consecuencia dice la verdad de ESTE plan: la fila promete una nota de
    // decisión durable sobre el contrato efectivo, y acá no hay contrato al cual
    // sumarla —lo prueba el `docs/decisions` ausente del final de esta misma
    // prueba—. Lo que la persona aprueba es la ruta real: la traza y el
    // `DECISION.md` de la sesión.
    expect(gate.resolved.choices[0]?.consequence).not.toContain("durable");
    expect(gate.resolved.choices[0]?.consequence).toContain("DECISION.md");

    const after = await submit({
      input_digest: gate.resolved.seal,
      choice: "Registrar la decisión y seguir",
    });

    // Sin error y sin handoff: la corrida dejó el gate atrás y sigue caminando.
    expect(after.error).toBeNull();
    const moved = await current();
    expect(moved.state.applied).toContain(GATE);
    expect(moved.state.handoff ?? null).toBeNull();
    expect(moved.resolved.stopped?.id).not.toBe(GATE);
    // La preparación se consume: dejarla sentada mostraría una vista ya decidida
    // delante de la próxima frontera.
    expect(moved.state.decision_preparation ?? null).toBeNull();

    // El evento queda en la traza, que es el ÚNICO lugar donde esta decisión se
    // prueba: sin efectos y sin evidencia, porque nada llegó al mundo.
    const traced = moved.state.events.filter(
      (event) => event.operation === "plan-exec.standalone-decision",
    );
    expect(traced).toHaveLength(1);
    expect(traced[0]).toMatchObject({
      kind: "executed",
      transition: GATE,
      summary: "el helper vive en el módulo vecino, no en uno nuevo",
      effects: [],
      evidence: [],
    });
    expect(traced[0]?.kind === "executed" && traced[0].output_digest).toMatch(/^sha256:[0-9a-f]+$/);

    // Y la directiva le dice al agente dónde anotarla y desde dónde retomar.
    expect(after.next_action).toContain("DECISION.md");
    expect(after.next_action).toContain("F1/T1.1");

    // Nada durable: un plan sin spec no tiene cadena a la cual sumar una nota.
    expect(existsSync(join(workdir, "docs", "decisions"))).toBe(false);
  });

  it("una decisión sin punto de reanudación se rechaza con el código que ya existe", async () => {
    const refused = await recognize(draft({ resume_point: "   " }));
    expect(refused.error?.code).toBe("FLOW_DECISION_INPUT_INVALID");
    expect(refused.error?.action).toContain("resume_point");
    const { state } = await current();
    expect(state.applied).not.toContain(RECOGNITION);
    expect(state.decision_preparation ?? null).toBeNull();
  });

  it("y una decisión en blanco tampoco pasa: guardarla dejaría la corrida ILEGIBLE", async () => {
    // La otra mitad del guard, que es la que impide que un valor en blanco del
    // llamador brickee la corrida: una preparación `{decision: ""}` se serializa
    // sin problema y es la LECTURA siguiente la que muere, porque
    // `isDecisionPreparation` exige contenido. A partir de ahí todo `aw flow`
    // sobre esa sesión se niega, y no hay comando que lo desarme.
    const refused = await recognize(draft({ decision: "   " }));
    expect(refused.error?.code).toBe("FLOW_DECISION_INPUT_INVALID");
    const read = await readRun(fs, locateRun(paths, SESSION));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.applied).not.toContain(RECOGNITION);
    expect(read.state.decision_preparation ?? null).toBeNull();
  });

  it("y el plan SIN marcador no entra por esta vía: su desvío sigue exigiendo linaje", async () => {
    // La reserva de `FLOW_DECISION_LINEAGE_INVALID` es el corazón del lote, y es
    // una reserva sobre el plan que DEBERÍA declarar su spec y no lo hizo: el
    // tablero lo sigue contando en "Planes sin spec demostrada" (su relación es
    // `absent`, no `standalone`), así que si la vía standalone lo aceptara, las
    // dos mitades del gate afirmarían cosas opuestas sobre el mismo documento y
    // la enmienda durable de su contrato se perdería en silencio.
    await writeFile(join(workdir, PLAN_PATH), REAL_PLAN.replace(`${MARKER}\n`, ""), "utf8");
    const refused = await recognize(draft());
    expect(refused.error?.code).toBe("FLOW_DECISION_LINEAGE_INVALID");
    const { state } = await current();
    expect(state.applied).not.toContain(RECOGNITION);
    expect(state.decision_preparation ?? null).toBeNull();
    // Y no nació nada durable con la decisión a medio registrar.
    expect(existsSync(join(workdir, "docs", "decisions"))).toBe(false);
  });

  it("y el plan standalone CIERRA: sello ausente no es baseline inválido", async () => {
    await recognize(draft());
    // El recorrido entero, hasta que no queda frontera: la última fila es el
    // sello `done`, y su precondición vuelve a leer el tablero bajo el lock del
    // workspace. Un standalone llega con `unsealed`, que `planDonePrecondition`
    // NO rechaza — sólo `divergent`, `malformed` y `unresolved` lo hacen.
    for (let step = 0; step < 60; step += 1) {
      const { resolved } = await current();
      if (resolved.stopped === null) break;
      const approval =
        resolved.kind === "authorization"
          ? effectApprovalDigest(resolved.stopped.id, resolved.authorization?.planned ?? [])
          : null;
      await submit(
        approval === null
          ? walk.bodyFor(run, resolved)
          : { input_digest: resolved.seal, choice: "Autorizar el efecto" },
        approval,
      );
    }
    const final = await current();
    expect(final.resolved.stopped).toBeNull();
    expect(final.state.applied).toContain("plan-exec.plan-done");

    const sealed = await readFile(join(workdir, PLAN_PATH), "utf8");
    expect(sealed).toContain("> Estado: done");
    expect(sealed).toContain("> Cierre:");
    expect(existsSync(join(workdir, "docs", "decisions"))).toBe(false);
  });

  it("y el otro lado del mismo gate: un plan DIVERGENTE no cierra, y el rechazo nombra las DOS salidas", async () => {
    // El contraste del caso de arriba, y el único momento en que `aw reseal`
    // hace falta de verdad: el agente está DENTRO de `/w:plan-exec`, su doctrina
    // cargada no nombra el comando en ninguna línea, y si el rechazo dijera sólo
    // «volvé a /w:plan-refine» la salida de dos comandos quedaría inalcanzable
    // justo donde se traba. `/w:plan-refine` sigue siendo la acción recomendada:
    // el reseal es la alternativa, nunca su reemplazo.
    await mkdir(join(workdir, "docs", "specs"), { recursive: true });
    // La spec en disco ya no es la que se selló —un byte en un criterio basta—,
    // así que el plan, que sí declara su linaje, queda `divergent`.
    await writeFile(
      join(workdir, SPEC_PATH),
      SPEC.replace("ciudadano de primera.", "ciudadano de primera,"),
      "utf8",
    );
    await writeFile(
      join(workdir, PLAN_PATH),
      `# Plan 071 — sellado contra su spec

> Derived from ${SPEC_PATH}
> Baseline: ${SPEC_PATH}@${specBaselineDigest(SPEC)}
> Límite de ejecución: checkout

## Origin

Spec 070.

## Tasks

### F1 — hacer el trabajo
> Estado: pendiente
> Fuentes: workspace

- [ ] T1.1 — hacer el trabajo _(fuentes: workspace)_
`,
      "utf8",
    );
    // Sin señales de desviación: este plan no declara ninguna, así que el
    // recorrido camina derecho hasta el sello final.
    const derecho = planExecWalk(
      { fs, env: new FakeEnv(workdir, workdir), git: new GitCliAdapter(new NodeProcess()), paths },
      { sources: ["workspace"], signals: [] },
    );
    await derecho.walkTo(run, "plan-exec.plan-done");
    expect((await current()).resolved.stopped?.id).toBe("plan-exec.plan-done");
    await derecho.step(run);

    const refused = (await current()).state.events.find(
      (event) => event.operation === "plan-exec.plan-done" && event.kind === "failed",
    );
    expect(refused?.message).toContain("no tiene un baseline ejecutable (divergent)");
    expect(refused?.message).toContain(`/w:plan-refine ${PLAN_PATH}`);
    expect(refused?.message).toContain(`aw reseal prepare ${PLAN_PATH}`);
    // Y el sello no se escribió: el rechazo es un rechazo, no un aviso.
    expect(await readFile(join(workdir, PLAN_PATH), "utf8")).not.toContain("> Estado: done");
  });
});
