import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKLINE_FLOWS } from "../../src/application/capability/compose.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  COMMAND_EXCLUSIONS,
  FLOW_DECISIONS,
  type FlowDecision,
  effectsOf,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import { FLOW_BOUNDARY_KINDS } from "../../src/domain/flow/directive.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * El cierre de la migración: no queda autoridad legacy y el fallback se retiró.
 *
 * Esta fase no agrega una capacidad, saca una. Lo que hay que probar entonces no
 * es que algo ande, sino que algo YA NO EXISTE y que nada quedó dependiendo de
 * ello — que es exactamente lo que una suite verde puede ocultar si nadie lo
 * pregunta.
 *
 * Cuatro cosas se fijan acá:
 *
 * 1. **El mecanismo no está.** Ni el motivo de frontera, ni el campo de la
 *    respuesta, ni los códigos de error que lo sostenían. Un vocabulario cerrado
 *    del que se saca un valor es la única forma de que no vuelva por descuido.
 * 2. **La doctrina no reenuncia lo migrado**, y se prueba por marcador NEGATIVO
 *    sobre el texto real que esta fase retiró — no sobre una frase inventada acá
 *    para tener algo que afirmar.
 * 3. **`spec-new` quedó clasificado**, que era el hueco: un recorrido público sin
 *    filas ni exclusión se lee igual que uno olvidado. Y su módulo conserva la
 *    regla, porque ese recorrido no tiene corrida que dirigir.
 * 4. **Una corrida real llega al final.** Es la prueba que ninguna de las otras
 *    da: el recorrido SPEC se detenía en el gate de división remitiendo a un
 *    documento que su propio read-set nunca le entregó, así que no había forma de
 *    terminarlo sin salirse de la corrida.
 */

const fs = new NodeFileSystem();
const BUNDLE = resolve(__dirname, "..", "..", "skills", "w");
const SRC = resolve(__dirname, "..", "..", "src");
const SESSION = "041-cierre-legacy-spec-refine";
const CODE = "041";
const JOURNEY = journeyOfFlow("spec-refine");

async function bundle(rel: string): Promise<string> {
  return readFile(join(BUNDLE, rel), "utf8");
}

describe("el mecanismo de fallback no existe más", () => {
  it("el vocabulario de fronteras perdió el único motivo que remitía a un documento", () => {
    expect([...FLOW_BOUNDARY_KINDS]).not.toContain("legacy");
  });

  it("ningún código del fallback sobrevive en el código fuente", async () => {
    // Los tres eran el contrato entero de la vuelta a la doctrina: declarar el
    // documento antes de aplicarlo, exigir que la respuesta lo nombrara, y
    // rechazar una frontera que dijera una cosa y una propiedad otra. Los dos
    // primeros se van con el mecanismo; el tercero cambió de sentido y se queda.
    const retired = ["FLOW_DIRECTIVE_LEGACY_WITHOUT_FALLBACK", "FLOW_FALLBACK_UNDECLARED"];
    const sources = [
      "domain/flow/answer.ts",
      "domain/flow/directive.ts",
      "application/flow/advance.ts",
      "application/flow/submit.ts",
    ];
    for (const rel of sources) {
      const body = await readFile(join(SRC, rel), "utf8");
      for (const code of retired) expect(body, `${rel} → ${code}`).not.toContain(code);
    }
  });

  it("la respuesta ya no tiene dónde declarar un fallback", async () => {
    // El campo se fue con su único productor. Dejarlo siempre en `null` habría
    // sido justamente lo que este plan persigue: forma declarada sin consumidor.
    const body = await readFile(join(SRC, "domain/flow/answer.ts"), "utf8");
    const contract = body.slice(body.indexOf("export interface FlowAnswer"));
    expect(contract.slice(0, contract.indexOf("}"))).not.toContain("fallback");
  });

  it("ningún recorrido público puede producir el bloqueo por propiedad", () => {
    for (const flow of WORKLINE_FLOWS) {
      const left = journeyOfFlow(flow).filter((row) => row.ownership !== "cli-owned");
      expect(
        left.map((row) => row.id),
        flow,
      ).toEqual([]);
    }
    expect(FLOW_DECISIONS.filter((row) => row.ownership !== "cli-owned")).toEqual([]);
  });
});

describe("la doctrina no reenuncia ninguna regla migrada", () => {
  it("el protocolo de fronteras ya no describe un paso que el CLI no posee", async () => {
    const harness = await bundle("harness/HARNESS.md");
    // Marcadores negativos, con el texto exacto que esta fase sacó de la tabla.
    expect(harness).not.toContain("a step the CLI does not own yet");
    expect(harness).not.toContain("the fallback declaration");
    expect(harness).not.toContain("read the declared document, apply its rule");
    expect(harness).not.toContain("`cli-owned` or `legacy`");
    // Y lo que quedó sigue diciendo de dónde sale la propiedad, que es la otra
    // mitad: retirar el fallback sin eso dejaría a las superficies sin regla.
    expect(harness).toContain("the only place ownership changes");
  });

  it("el módulo de forma del cambio ya no enuncia las etiquetas que emite el registro", async () => {
    const shape = await bundle("modules/SPEC-CHANGE-SHAPE.md");
    const split = shape.slice(shape.indexOf("**Split semantics (in place).**"));
    expect(split.slice(0, split.indexOf("**Replace semantics."))).not.toContain(
      "`Dividir en varias specs`",
    );
    // La rama `replace` SÍ las conserva, y la asimetría es verificable: ninguna
    // fila del registro emite sus alternativas, así que el documento es su única
    // fuente y retirarlas lo dejaría sin regla.
    expect(shape).toContain("`Crear una nueva spec`");
    const emitters = FLOW_DECISIONS.filter((row) =>
      (row.alternatives ?? []).some((choice) => choice.label === "Crear una nueva spec"),
    );
    expect(emitters).toEqual([]);
  });

  it("cada documento que este cierre migró atribuye la decisión a quien la toma", async () => {
    for (const id of [
      "spec-refine.split-signal",
      "spec-refine.split-gate",
      "spec-refine.split-choice",
      "spec-refine.design-reuse",
      "resume.route-choice",
      "persist.shape-classification",
      "context-plan.signal-declaration",
      "fix-git.intent",
      "export.selection",
    ]) {
      const row = FLOW_DECISIONS.find((decision) => decision.id === id);
      expect(row, id).toBeDefined();
      expect(row?.ownership, id).toBe("cli-owned");
      const marker = row?.attribution ?? "";
      expect(marker.length, id).toBeGreaterThanOrEqual(8);
      expect(await bundle(row?.document ?? ""), id).toContain(marker);
    }
  });
});

describe("`spec-new` quedó clasificado, y su módulo conserva la regla", () => {
  it("está excluido con un motivo que dice por qué no hay corrida que dirigir", () => {
    const entry = COMMAND_EXCLUSIONS.find((exclusion) => exclusion.command === "spec-new");
    expect(entry).toBeDefined();
    expect(entry?.reason).toMatch(/no abre loop/);
    expect(entry?.reason).toContain("modules/SPLIT-GATE.md");
  });

  it("ninguna fila del registro cita su módulo, y el módulo conserva su enunciado", async () => {
    // Las dos mitades de la misma decisión. Si el registro lo citara, la guarda de
    // atribución exigiría un marcador y la de retirada exigiría sacarle la regla —
    // y ese recorrido se quedaría sin ninguna.
    expect(FLOW_DECISIONS.map((row) => row.document)).not.toContain("modules/SPLIT-GATE.md");
    const gate = await bundle("modules/SPLIT-GATE.md");
    expect(gate).toContain("The gate fires **only on clear signals**");
    expect(gate).toContain(">=2 of");
  });
});

describe("la corrida real de SPEC llega al final, que antes era imposible", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-cierre-legacy-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — cierre legacy\n\n## Objective\nterminar un recorrido SPEC entero\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return { state: read.state, resolved: resolveBoundary(read.state, JOURNEY) };
  }

  type Resolved = Awaited<ReturnType<typeof current>>["resolved"];

  /** The real output an `execution` boundary demands — never a confirmation. */
  function resultFor(resolved: Resolved, stopped: FlowDecision): Record<string, unknown> {
    const action = resolved.action;
    if (action === null) throw new Error("una frontera de ejecución sin invocación");
    const declared = effectsOf(stopped);
    return {
      input_digest: resolved.seal,
      outcome: "completed",
      invocation: action.invocation,
      validations: action.evidence.map((id) => ({ id, passed: true, detail: `salida de ${id}` })),
      effects: { planned: [...declared], approved: [], applied: [...declared] },
      output: null,
    };
  }

  /** Whatever the boundary in force admits, plus the approval when it asks for one. */
  function answerFor(
    resolved: Resolved,
    stopped: FlowDecision,
  ): { body: Record<string, unknown>; approval: string | null } {
    if (resolved.kind === "execution") {
      return { body: resultFor(resolved, stopped), approval: null };
    }
    if (resolved.kind === "authorization") {
      return {
        body: { input_digest: resolved.seal, choice: "Autorizar el efecto" },
        approval: effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? []),
      };
    }
    if (resolved.kind === "semantic") {
      return {
        body: { input_digest: resolved.seal, signals: [], decisions: { paso: stopped.id } },
        approval: null,
      };
    }
    return {
      body: { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" },
      approval: null,
    };
  }

  it("cruza el gate de división y termina, sin remitir a ningún documento", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "spec-refine", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");

    const crossed: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const { resolved } = await current();
      if (resolved.kind === "final") {
        // Lo que esta fase desbloqueó: el recorrido entero, de punta a punta.
        expect(crossed).toContain("spec-refine.split-signal");
        expect(crossed).toContain("spec-refine.design-reuse");
        expect(crossed).toContain("chassis.finalize");
        expect(resolved.error).toBeNull();
        return;
      }
      const stopped = resolved.stopped as FlowDecision;
      expect(resolved.error, stopped.id).toBeNull();
      crossed.push(stopped.id);

      const { body, approval } = answerFor(resolved, stopped);
      const sent = await submitFlow(fs, paths, {
        code: CODE,
        raw: JSON.stringify(body),
        approval,
      });
      if (!sent.ok) throw new Error("un rechazo de negocio viaja ok:true");
      expect(sent.directive.error, stopped.id).toBeNull();
    }
    throw new Error("el recorrido nunca llegó al final");
  });
});
