// El linaje spec→plan deja de acoplar el CONTRATO a los BYTES.
//
// Un plan sella de qué versión de su spec deriva. Mientras ese sello fue el
// digest del archivo completo, corregir una coma, reordenar una lista o tocar el
// frontmatter volvía DIVERGENTE a todo plan de esa spec — y un plan divergente
// no cierra (`PLAN_EXEC_DONE_BASELINE_INVALID`), así que la única reparación era
// un `/w:plan-refine` entero por consumidor. Editar prosa no es enmendar un
// contrato.
//
// Y la válvula que existía para no tocar ni la spec ni el plan —«Registrar la
// decisión y seguir»— estaba MUERTA: para direccionar una afirmación hacía falta
// la forma `S{NNN}/AC-nn` literal, las specs reales rotulan `- [ ] AC-nn:`, la
// cosecha devolvía `[]` y toda nota moría en `CONTRACT_ASSERTION_ABSENT`
// diciendo que la spec no enuncia un criterio que la spec enuncia.
//
// Lo que se fija acá:
//   1. qué mueve el digest funcional y qué no;
//   2. la alineación DUAL, que es la migración: un sello legado sigue valiendo;
//   3. la PARIDAD — el digest que el tablero reporta es el que una nota pinea;
//   4. los criterios rotulados son direccionables, en las dos formas;
//   5. la ida completa: la nota compone y el plan queda cerrable.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noteIndexPath, sealNote } from "../../src/application/decision-note-service.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import {
  ACCEPTANCE_CRITERIA_KEY,
  functionalSpecDigest,
  functionalSpecPayload,
  unclosedSpecFence,
} from "../../src/application/parsers/spec-functional.js";
import {
  parsePlanBaselineSeal,
  parseSpecCriteria,
} from "../../src/application/parsers/spec-relation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { preparePlanExecDecision } from "../../src/application/plan-exec-decision-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { NOTE_SCHEMA } from "../../src/domain/decision-note.js";
import { type FlowDecision, effectsOf, journeyForState } from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import { alignSpecBaseline, specBaselineDigest } from "../../src/domain/lineage.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const SPEC_PATH = "docs/specs/040-spec-valvula.md";
const PLAN_PATH = "docs/plans/041-plan-valvula.md";

/** Una spec con el esqueleto real de la doctrina y sus criterios ROTULADOS. */
const SPEC = `---
status: ready-for-plan
---

# Spec 040 — la válvula

## Origin

Sesión 151 · conversación del host.

## Context

El linaje spec→plan era un número, no un contrato.

## Requirement

Un plan sella la versión FUNCIONAL de su spec, no sus bytes.

## Affected capabilities

- el linaje spec→plan.

## Behavioral changes

- modificado: el borrado de un sello viejo es lógico.

## Scope

El digest del baseline y la cosecha de criterios.

## Acceptance criteria

- [ ] AC-01: una edición editorial de la spec no vuelve divergente a su plan.
- [ ] AC-02: un cambio de alcance sí lo vuelve divergente.
- [ ] AC-03: una nota puede direccionar un criterio rotulado.

## Scenarios

GIVEN una coma nueva en el contexto WHEN se compara THEN el plan sigue alineado.

## Open questions

- ¿hace falta un comando de re-sello?
`;

describe("el payload funcional — qué mueve el digest y qué es editorial", () => {
  const same = (edited: string): void => {
    expect(edited).not.toBe(SPEC);
    expect(functionalSpecDigest(edited)).toBe(functionalSpecDigest(SPEC));
  };
  const moves = (edited: string): void => {
    expect(edited).not.toBe(SPEC);
    expect(functionalSpecDigest(edited)).not.toBe(functionalSpecDigest(SPEC));
  };

  it("sólo las secciones del allowlist entran al payload, y entran las SEIS", () => {
    expect(Object.keys(functionalSpecPayload(SPEC)).sort()).toEqual([
      "acceptance criteria",
      "affected capabilities",
      "behavioral changes",
      "requirement",
      "scenarios",
      "scope",
    ]);
  });

  it("la clave del checklist que el módulo exporta ES la que el payload escribe", () => {
    // El acoplamiento que hace que el sello y la cosecha de ids lean la MISMA
    // sección: una clave que no exista dejaría la cosecha sin checklist y toda
    // nota moriría en `CONTRACT_ASSERTION_ABSENT`, sin que nada más se queje.
    expect(Object.keys(functionalSpecPayload(SPEC))).toContain(ACCEPTANCE_CRITERIA_KEY);
  });

  it("editar `## Context` no mueve el digest", () => {
    same(SPEC.replace("era un número, no un contrato.", "era, apenas, un número."));
  });

  it("editar `## Origin` tampoco", () => {
    same(SPEC.replace("Sesión 151 · conversación del host.", "Sesión 152."));
  });

  it("editar `## Open questions` tampoco", () => {
    same(SPEC.replace("¿hace falta un comando de re-sello?", "ninguna: quedó cerrada."));
  });

  it("agregar `## Decisions` entero tampoco: no es una sección del contrato", () => {
    same(
      SPEC.replace(
        "## Open questions",
        "## Decisions\n\n- se sella el funcional.\n\n## Open questions",
      ),
    );
  });

  it("cambiar el frontmatter tampoco: la madurez de la spec no es lo prometido", () => {
    same(SPEC.replace("status: ready-for-plan", "status: refining"));
  });

  it("reordenar dos secciones H2 tampoco: el payload es un objeto de claves ordenadas", () => {
    const scope = "## Scope\n\nEl digest del baseline y la cosecha de criterios.\n\n";
    const scenarios =
      "## Scenarios\n\nGIVEN una coma nueva en el contexto WHEN se compara THEN el plan sigue alineado.\n\n";
    const reordered = SPEC.replace(scope, "").replace(scenarios, `${scenarios}${scope}`);
    expect(reordered).toContain(scope);
    same(reordered);
  });

  it("espacios de más —al final y adentro— tampoco: así es como se reescribe un párrafo", () => {
    same(
      SPEC.replace("- [ ] AC-01: una edición", "- [ ]   AC-01:  una   edición").replace(
        "divergente a su plan.",
        "divergente a su plan.  \t",
      ),
    );
  });

  it("una corrida de líneas vacías colapsa, y los blancos del borde de la sección se podan", () => {
    const one = "# Spec 040\n\n## Scope\n\nlo primero.\n\ny lo segundo.\n";
    const padded = "# Spec 040\n\n## Scope\n\n\n\nlo primero.\n\n\n\ny lo segundo.\n\n\n";
    expect(functionalSpecDigest(padded)).toBe(functionalSpecDigest(one));
    // Pero UNA línea vacía donde no había ninguna sí separa dos párrafos.
    const split = "# Spec 040\n\n## Scope\n\nlo primero.\ny lo segundo.\n";
    expect(functionalSpecDigest(split)).not.toBe(functionalSpecDigest(one));
  });

  it("tildar un criterio tampoco: marcarlo es contabilidad, no contrato", () => {
    same(SPEC.replace("- [ ] AC-02", "- [x] AC-02"));
    same(SPEC.replace("- [ ] AC-02", "- [X] AC-02"));
  });

  it("un alias español enuncia exactamente el mismo contrato que el inglés", () => {
    const es = SPEC.replace("## Requirement", "## Requerimiento")
      .replace("## Scope", "## Alcance")
      .replace("## Acceptance criteria", "## Criterios de aceptación")
      .replace("## Scenarios", "## Escenarios")
      .replace("## Behavioral changes", "## Cambios de comportamiento")
      .replace("## Affected capabilities", "## Capacidades afectadas");
    same(es);
  });

  it("cambiar una palabra de `## Scope` SÍ mueve el digest", () => {
    moves(SPEC.replace("El digest del baseline", "El digest del plan"));
  });

  it("cambiar `## Behavioral changes` SÍ: ahí se promete la conducta que se mueve", () => {
    // Una spec conforme al esquema refinado declara acá «behavior added /
    // modified / removed / preserved». Si la sección no fuera contrato, cambiar
    // «el borrado es lógico» por «el borrado es físico» no movería el digest: el
    // plan seguiría `aligned`, la nota seguiría componiendo y el tablero lo
    // dejaría cerrable contra una conducta prometida que ya no cumple.
    moves(SPEC.replace("el borrado de un sello viejo es lógico", "el borrado es FÍSICO"));
  });

  it("cambiar `## Affected capabilities` SÍ: son las fronteras que el cambio toca", () => {
    moves(SPEC.replace("- el linaje spec→plan.", "- el linaje spec→plan y el de diseño."));
  });

  it("cambiar un criterio SÍ", () => {
    moves(SPEC.replace("no vuelve divergente a su plan", "vuelve divergente a su plan"));
  });

  it("mover texto de `## Scope` a `## Acceptance criteria` SÍ: la clave cambia", () => {
    const line = "El digest del baseline y la cosecha de criterios.";
    moves(SPEC.replace(`${line}\n`, "").replace("- [ ] AC-01:", `${line}\n- [ ] AC-01:`));
  });

  it("dentro de un fence un espacio SÍ cuenta: ahí se promete un literal", () => {
    const fenced = SPEC.replace(
      "## Scenarios",
      "## Scenarios\n\n```\naw flow submit --code 040\n```",
    );
    const spaced = fenced.replace("aw flow submit", "aw  flow submit");
    expect(functionalSpecDigest(spaced)).not.toBe(functionalSpecDigest(fenced));
    // Y el fence entra al payload tal cual, sin normalizar.
    expect(functionalSpecPayload(spaced).scenarios).toContain("aw  flow submit");
  });

  it("dentro de un fence el FIN DE LÍNEA no cuenta: un checkout CRLF no mueve el sello", () => {
    // El `\r` es del sistema de archivos, no de la spec: sin quitarlo, un clon
    // con `core.autocrlf=true` vuelve `divergent` a todos los planes de
    // cualquier spec con un bloque cercado, y un plan divergente no cierra.
    const fenced = SPEC.replace(
      "## Scenarios",
      "## Scenarios\n\n```\naw flow submit --code 040\n```",
    );
    expect(functionalSpecDigest(fenced.replace(/\n/g, "\r\n"))).toBe(functionalSpecDigest(fenced));
  });

  it("payload VACÍO degrada al byte-exacto: el sello no puede volverse una constante", () => {
    // Sin la caída, una spec sin ninguna sección del allowlist digiere a UNA
    // constante compartida por todas las specs en ese estado: el plan queda
    // `aligned` para siempre, aunque a la spec le reescriban o le vacíen todo.
    // Degradar al byte-exacto devuelve la conducta previa al lote —sensible a
    // cualquier edición— que es lo peor que este digest puede dar.
    const bare = "# Spec 099 — nada\n\n## Notes\n\nsólo prosa.\n";
    const otra = "# Spec 100 — tampoco\n\n## Notes\n\notra prosa.\n";
    expect(functionalSpecPayload(bare)).toEqual({});
    expect(functionalSpecDigest(bare)).toBe(specBaselineDigest(bare));
    expect(functionalSpecDigest(bare)).not.toBe(functionalSpecDigest(otra));
    // Y es el caso LEGÍTIMO: nadie dejó un fence abierto, así que no hay
    // diagnóstico que dar. Si diera un número, el tablero mandaría a cerrar una
    // fence que no existe.
    expect(unclosedSpecFence(bare)).toBeNull();
    // Y cualquier edición la mueve, incluso una que en una spec normal sería
    // editorial: sin secciones no hay nada de qué decir que es prosa.
    const edited = bare.replace("sólo prosa.", "sólo prosa, y una coma.");
    expect(functionalSpecDigest(edited)).not.toBe(functionalSpecDigest(bare));
  });

  it("un fence SIN CERRAR en `## Context` vacía el payload, y ahí también degrada", () => {
    // El camino realista al payload vacío: un fence abierto marca como fenced
    // todo el resto del documento, `scanMarkdown` no ve ni un heading más y las
    // seis secciones del contrato desaparecen de golpe. Si el digest fuera la
    // constante, reescribir el `## Requirement` entero no movería el sello.
    const unclosed = [
      "# Spec 099 — el fence",
      "",
      "## Context",
      "",
      "```",
      "un ejemplo que nadie cerró",
      "",
      "## Requirement",
      "",
      "Un plan sella la versión funcional de su spec.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] AC-01: lo prometido.",
      "",
    ].join("\n");
    expect(functionalSpecPayload(unclosed)).toEqual({});
    expect(functionalSpecDigest(unclosed)).toBe(specBaselineDigest(unclosed));

    const rewritten = unclosed.replace(
      "Un plan sella la versión funcional de su spec.",
      "Un plan NO sella nada.",
    );
    expect(functionalSpecDigest(rewritten)).not.toBe(functionalSpecDigest(unclosed));

    // En el MISMO golpe muere la cosecha de criterios: el `AC-01` está escrito y
    // ninguna nota puede direccionarlo.
    expect(parseSpecCriteria(unclosed, "099")).toEqual([]);
    // Y el estado es OBSERVABLE, que es lo único que lo distingue del caso
    // legítimo de arriba: sin esto las dos frases que el sistema emite son
    // falsas —«la spec cambió» sobre una spec que no cambió, y «la spec no lo
    // enuncia» sobre una spec que lo enuncia— y nada nombra la causa.
    expect(unclosedSpecFence(unclosed)).toBe(4);
  });

  it("un `### Scenario:` no corta `## Scenarios`: su GIVEN/WHEN/THEN es contrato", () => {
    // La plantilla de la doctrina escribe CADA escenario bajo un H3. Si la
    // sección terminara en el próximo heading de cualquier nivel, el payload de
    // `## Scenarios` quedaría vacío y voltear un THEN —o sea, prometer lo
    // contrario— pasaría a ser una edición editorial.
    const doc = [
      "# Spec 040 — la válvula",
      "",
      "## Scenarios",
      "",
      "### Scenario: alta feliz",
      "",
      "GIVEN un usuario con permiso",
      "WHEN pide el alta",
      "THEN el alta queda registrada",
      "",
      "### Scenario: sin permiso",
      "",
      "GIVEN un usuario sin permiso",
      "WHEN pide el alta",
      "THEN el alta es rechazada",
      "",
      "## Open questions",
      "",
      "- ninguna.",
      "",
    ].join("\n");
    const payload = functionalSpecPayload(doc);

    // Los dos escenarios viven en UNA sección, con sus H3 adentro.
    expect(Object.keys(payload)).toEqual(["scenarios"]);
    expect(payload.scenarios).toBe(
      [
        "### Scenario: alta feliz",
        "",
        "GIVEN un usuario con permiso",
        "WHEN pide el alta",
        "THEN el alta queda registrada",
        "",
        "### Scenario: sin permiso",
        "",
        "GIVEN un usuario sin permiso",
        "WHEN pide el alta",
        "THEN el alta es rechazada",
      ].join("\n"),
    );
    // Y voltear el THEN mueve el digest: eso es enmendar el contrato.
    const flipped = doc.replace("THEN el alta queda registrada", "THEN el alta es RECHAZADA");
    expect(functionalSpecDigest(flipped)).not.toBe(functionalSpecDigest(doc));
    // Mientras el H2 siguiente SÍ la cierra: lo de `## Open questions` no entra.
    const editorial = doc.replace("- ninguna.", "- quedó una: el comando de re-sello.");
    expect(functionalSpecDigest(editorial)).toBe(functionalSpecDigest(doc));
  });

  it("una sección repetida se concatena en orden de documento, no se pierde", () => {
    const twice = SPEC.replace("## Scenarios", "## Scope\n\nY además el sello.\n\n## Scenarios");
    expect(functionalSpecPayload(twice).scope).toBe(
      "El digest del baseline y la cosecha de criterios.\nY además el sello.",
    );
  });
});

// ── la alineación dual: el sello legado sigue valiendo ────────────────────────

const fakeEnv = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 8, 1, 12, 0, 0);

/** El plan, con el `> Baseline:` que se le dé (o sin ninguno). */
function planDoc(baselineLine: string | null): string {
  const header = ["# Plan 041 — la válvula", "", `> Derived from ${SPEC_PATH}`];
  if (baselineLine !== null) header.push(baselineLine);
  header.push("> Estado: open", "> Límite de ejecución: checkout");
  return `${header.join("\n")}

## Origin

Spec 040.

## Tasks

### F1 — sellar lo funcional
> Estado: pendiente
> Fuentes: workspace

- [ ] T1.1 — sellar el digest funcional _(fuentes: workspace)_
`;
}

/** El mismo plan, pero CERRADO: declara done, su casilla marcada y su fase validada. */
function closedPlanDoc(baselineLine: string): string {
  return `# Plan 041 — la válvula

> Derived from ${SPEC_PATH}
${baselineLine}
> Estado: done
> Cierre: cerrado tras validar su única fase

## Origin

Spec 040.

## Tasks

### F1 — sellar lo funcional
> Estado: validada
> Fuentes: workspace

- [x] T1.1 — sellar el digest funcional _(fuentes: workspace)_
`;
}

/**
 * La cadena de una nota YA PUBLICADA, pineada al digest que se le dé.
 *
 * `specDigest` es el parámetro que importa: una nota publicada antes del payload
 * funcional pineó los BYTES exactos de la spec, porque era lo que el baseline
 * significaba entonces.
 */
function noteChain(planText: string, specDigest: string, amends: string): string {
  const index = {
    schema: "workline.decision-index/v1" as const,
    spec: { path: SPEC_PATH, number: "040" },
    notes: [],
  };
  const sealed = sealNote(index, {
    schema: NOTE_SCHEMA,
    lineage: {
      spec: { path: SPEC_PATH, number: "040", digest: specDigest },
      plan: { path: PLAN_PATH, number: "041", digest: `sha256:${baseDigest(planText)}` },
      execution: { session: "150-valvula", phase: "F1" },
    },
    decision: "el rótulo se satisface con el sello viejo",
    reason: "se decidió cuando el baseline eran los bytes",
    supersedes_assertions: [amends],
    supersedes_note: null,
    scope: "functional",
    consumers: [PLAN_PATH],
    evidence_preserved: [],
    evidence_invalidated: [],
    obligations: [],
    resume_point: "F1/T1.1",
    date: "2026-08-01",
  });
  return `${JSON.stringify({ ...index, notes: [sealed] }, null, 2)}\n`;
}

function memWorkspace(planText: string, specText: string = SPEC): MemFs {
  const fs = new MemFs({ lenient: true });
  fs.file("/cwd/.workflow/sessions/.keep", "");
  fs.file(`/cwd/${SPEC_PATH}`, specText);
  fs.file(`/cwd/${PLAN_PATH}`, planText);
  return fs;
}

function memIndex(fs: MemFs) {
  return buildWorklineIndex(
    fs,
    fakeEnv,
    new PathsService(normalizeNamespace("workflow"), "/home", "/cwd"),
    { now: NOW },
  );
}

const LEGACY_SEAL = `> Baseline: ${SPEC_PATH}@${specBaselineDigest(SPEC)}`;
const FUNCTIONAL_SEAL = `> Baseline: ${SPEC_PATH}@${functionalSpecDigest(SPEC)}`;
/** Una coma más en `## Context`: cero cambios en lo prometido. */
const EDITORIAL = SPEC.replace("un número, no un contrato.", "un número y no un contrato.");
/** Otro alcance: el contrato dice algo distinto. */
const FUNCTIONAL_CHANGE = SPEC.replace("El digest del baseline", "El digest del plan");

const digestsOf = (text: string) => ({
  functional: functionalSpecDigest(text),
  exact: specBaselineDigest(text),
});

describe("alineación dual — la migración no invalida un solo plan sellado", () => {
  const alignmentOf = (seal: string | null, spec: string) =>
    alignSpecBaseline(parsePlanBaselineSeal(planDoc(seal)), digestsOf(spec));

  it("sello legado byte-exacto con la spec intacta: alineado", () => {
    expect(alignmentOf(LEGACY_SEAL, SPEC)).toEqual({
      status: "aligned",
      digest: functionalSpecDigest(SPEC),
    });
  });

  it("sello legado con una edición editorial: divergente — el remedio es re-publicar", () => {
    expect(alignmentOf(LEGACY_SEAL, EDITORIAL)).toEqual({
      status: "divergent",
      sealed_digest: specBaselineDigest(SPEC),
      current_digest: functionalSpecDigest(EDITORIAL),
    });
  });

  it("sello funcional con una edición editorial: ALINEADO, que es el objetivo del lote", () => {
    expect(alignmentOf(FUNCTIONAL_SEAL, EDITORIAL)).toEqual({
      status: "aligned",
      digest: functionalSpecDigest(SPEC),
    });
  });

  it("sello funcional con `## Scope` cambiado: divergente", () => {
    expect(alignmentOf(FUNCTIONAL_SEAL, FUNCTIONAL_CHANGE)).toEqual({
      status: "divergent",
      sealed_digest: functionalSpecDigest(SPEC),
      current_digest: functionalSpecDigest(FUNCTIONAL_CHANGE),
    });
  });

  it("sin sello sigue siendo `unsealed`: no se afirma una comparación que nadie hizo", () => {
    expect(alignmentOf(null, SPEC)).toEqual({ status: "unsealed" });
  });

  it("un sello roto sigue siendo `malformed`, jamás `unsealed`", () => {
    expect(alignmentOf(`> Baseline: ${SPEC_PATH}@no-es-un-digest`, SPEC)).toMatchObject({
      status: "malformed",
    });
  });

  it("una spec ausente sigue siendo `unresolved`, no divergente", () => {
    expect(alignSpecBaseline(parsePlanBaselineSeal(planDoc(FUNCTIONAL_SEAL)), null)).toEqual({
      status: "unresolved",
      reason: "spec-not-found",
      path: SPEC_PATH,
    });
  });

  it("y el tablero lo lee igual: editorial sobre sello funcional no entrega a plan-refine", async () => {
    const board = await memIndex(memWorkspace(planDoc(FUNCTIONAL_SEAL), EDITORIAL));
    expect(board.plans[0]?.baseline).toEqual({
      status: "aligned",
      digest: functionalSpecDigest(SPEC),
    });
    expect(board.pipeline[0]?.command).toBe(`/w:plan-exec ${PLAN_PATH}`);
  });
});

describe("paridad — el digest que el tablero reporta ES el que una nota pinea", () => {
  /** Lo que `plan-exec-decision-service` pinearía en la nota, sin escribir nada. */
  const pinned = async (fs: MemFs): Promise<string> => {
    const prepared = await preparePlanExecDecision(fs, {
      root: "/cwd",
      session: "151-valvula-plan-exec",
      plan: PLAN_PATH,
      value: {
        question: {
          assertions: ["S040/AC-03"],
          behaviors: [
            { key: "componer", summary: "se registra la nota y la ejecución sigue" },
            { key: "refinar", summary: "se vuelve a spec-refine" },
          ],
        },
        draft: {
          schema: "workline.decision-note/v1",
          decision: "AC-03 se satisface con el rótulo",
          reason: "la cosecha ya direcciona el rótulo",
          supersedes_assertions: ["S040/AC-03"],
          supersedes_note: null,
          scope: "functional",
          consumers: [PLAN_PATH],
          evidence_preserved: [],
          evidence_invalidated: [],
          obligations: [],
          resume_point: "F1/T1.1",
          date: "2026-09-01",
        },
      },
    });
    if (!prepared.ok || prepared.kind !== "prepared") {
      throw new Error(`esperaba una decisión preparada, vino ${JSON.stringify(prepared)}`);
    }
    return prepared.baseline.digest;
  };

  it("con un sello FUNCIONAL, tablero y nota pinean el mismo digest", async () => {
    const fs = memWorkspace(planDoc(FUNCTIONAL_SEAL));
    const board = await memIndex(fs);
    const reported = board.plans[0]?.baseline;
    expect(reported).toMatchObject({ status: "aligned" });
    expect(await pinned(fs)).toBe((reported as { digest: string }).digest);
  });

  it("con un sello LEGADO byte-exacto también, y ahí está el silencio que se cierra", async () => {
    // Si el índice reportara el byte-exacto para un sello legado, una nota
    // registrada un segundo después dispararía `CONTRACT_BASELINE_ABSENT` sobre
    // un baseline que nadie movió, y el plan no cerraría nunca.
    const fs = memWorkspace(planDoc(LEGACY_SEAL));
    const board = await memIndex(fs);
    const reported = board.plans[0]?.baseline;
    expect(reported).toMatchObject({ status: "aligned" });
    expect(await pinned(fs)).toBe((reported as { digest: string }).digest);
    expect((reported as { digest: string }).digest).not.toBe(specBaselineDigest(SPEC));
  });
});

describe("migración del lado NOTA — la dualidad también cubre lo ya publicado", () => {
  const NOTE_PATH = `/cwd/${noteIndexPath("docs/decisions", "040", "valvula")}`;

  it("una nota pineada byte-exacta sobre una spec intacta compone, y el plan CIERRA", async () => {
    // El otro extremo de la comparación: el tablero pasa el digest FUNCIONAL
    // como baseline de la composición, y toda nota publicada antes de este lote
    // pineó el byte-exacto. Sin la lectura dual el plan queda `inconsistent`
    // para siempre sobre una spec que nadie tocó, y sin salida: la nota
    // sustituta que el mensaje pide tampoco se puede preparar.
    const planText = closedPlanDoc(LEGACY_SEAL);
    const fs = memWorkspace(planText);
    fs.file(NOTE_PATH, noteChain(planText, specBaselineDigest(SPEC), "S040/AC-01"));

    const plan = (await memIndex(fs)).plans[0];
    expect(plan?.baseline).toEqual({ status: "aligned", digest: functionalSpecDigest(SPEC) });
    expect(plan?.contract?.applied).toEqual(["DEC-001"]);
    expect(plan?.contract?.assertions).toEqual([
      { id: "S040/AC-01", state: "amended", by: "DEC-001" },
      { id: "S040/AC-02", state: "baseline", by: null },
      { id: "S040/AC-03", state: "baseline", by: null },
    ]);
    expect(plan?.reconciliation).toEqual({ pending: [], resume_point: null, closable: true });
    expect(plan?.plan_state).toBe("done");
  });

  it("y si la spec se movió FUNCIONALMENTE sigue bloqueando: no es un cheque en blanco", async () => {
    // El plan se re-sella contra la spec nueva, así que está alineado; la nota
    // vieja, en cambio, decidió sobre otro documento y eso se sigue reportando.
    const planText = closedPlanDoc(
      `> Baseline: ${SPEC_PATH}@${functionalSpecDigest(FUNCTIONAL_CHANGE)}`,
    );
    const fs = memWorkspace(planText, FUNCTIONAL_CHANGE);
    fs.file(NOTE_PATH, noteChain(planText, specBaselineDigest(SPEC), "S040/AC-01"));

    const plan = (await memIndex(fs)).plans[0];
    expect(plan?.baseline.status).toBe("aligned");
    expect(plan?.reconciliation?.closable).toBe(false);
    expect(plan?.reconciliation?.pending[0]?.text).toContain("CONTRACT_BASELINE_ABSENT");
    expect(plan?.plan_state).toBe("inconsistent");
  });

  it("y el servicio que prepara una decisión lee la cadena igual que el tablero", async () => {
    // La paridad, del otro lado: si `preparePlanExecDecision` no aceptara la
    // nota vieja, el gate de la desviación no podría preparar NINGUNA decisión
    // nueva en ese workspace — el mismo silencio, un paso antes.
    const planText = planDoc(LEGACY_SEAL);
    const fs = memWorkspace(planText);
    fs.file(NOTE_PATH, noteChain(planText, specBaselineDigest(SPEC), "S040/AC-01"));

    const prepared = await preparePlanExecDecision(fs, {
      root: "/cwd",
      session: "151-valvula-plan-exec",
      plan: PLAN_PATH,
      value: {
        question: {
          assertions: ["S040/AC-03"],
          behaviors: [
            { key: "componer", summary: "se registra la nota y la ejecución sigue" },
            { key: "refinar", summary: "se vuelve a spec-refine" },
          ],
        },
        draft: {
          schema: "workline.decision-note/v1",
          decision: "AC-03 se satisface con el rótulo",
          reason: "la cosecha ya direcciona el rótulo",
          supersedes_assertions: ["S040/AC-03"],
          supersedes_note: null,
          scope: "functional",
          consumers: [PLAN_PATH],
          evidence_preserved: [],
          evidence_invalidated: [],
          obligations: [],
          resume_point: "F1/T1.1",
          date: "2026-09-01",
        },
      },
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.kind).toBe("prepared");
  });
});

describe("criterios AC-nn — el rótulo de la doctrina es direccionable", () => {
  it("un rótulo `- [ ] AC-01:` deriva el id de la spec que lo enuncia", () => {
    expect(parseSpecCriteria(SPEC, "040")).toEqual(["S040/AC-01", "S040/AC-02", "S040/AC-03"]);
  });

  it("tildado y en negritas también: `- [x] **AC-02**:`", () => {
    const bold = SPEC.replace("- [ ] AC-02:", "- [x] **AC-02**:");
    expect(parseSpecCriteria(bold, "040")).toContain("S040/AC-02");
  });

  it("la forma vieja completa y el rótulo producen el MISMO id, y no se cuenta dos veces", () => {
    const full = SPEC.replace("- [ ] AC-01:", "- [ ] **S040/AC-01:**").replace(
      "THEN el plan sigue alineado.",
      "THEN vale S040/AC-01.",
    );
    expect(parseSpecCriteria(full, "040")).toEqual(["S040/AC-01", "S040/AC-02", "S040/AC-03"]);
  });

  it("une la mención con segmento (`S013/AC-CAP-01`) sin duplicar nada", () => {
    const mixed = SPEC.replace(
      "## Scenarios",
      "## Scenarios\n\nEsto hereda S013/AC-CAP-01 y vuelve a citar S040/AC-03.",
    );
    expect(parseSpecCriteria(mixed, "040")).toEqual([
      "S040/AC-01",
      "S040/AC-02",
      "S040/AC-03",
      "S013/AC-CAP-01",
    ]);
  });

  it("sin `specNumber` la respuesta es byte-idéntica a la de siempre: sólo menciones", () => {
    expect(parseSpecCriteria(SPEC)).toEqual([]);
    const mixed = `${SPEC}\n- S013/AC-CAP-01 — heredado.\n`;
    expect(parseSpecCriteria(mixed)).toEqual(["S013/AC-CAP-01"]);
  });

  it("un rótulo FUERA de la sección de criterios no deriva nada", () => {
    const elsewhere = SPEC.replace(
      "- ¿hace falta un comando de re-sello?",
      "- [ ] AC-09: ¿hace falta un comando de re-sello?",
    );
    expect(parseSpecCriteria(elsewhere, "040")).not.toContain("S040/AC-09");
  });

  it("un rótulo dentro de un fence tampoco: ahí se cita la plantilla", () => {
    const fenced = SPEC.replace(
      "- [ ] AC-01:",
      "```\n- [ ] AC-99: ejemplo de la doctrina.\n```\n\n- [ ] AC-01:",
    );
    const ids = parseSpecCriteria(fenced, "040");
    expect(ids).not.toContain("S040/AC-99");
    expect(ids).toContain("S040/AC-01");
  });

  it("un correlativo de 4 dígitos no forma un id válido: no deriva, y no falla", () => {
    expect(parseSpecCriteria(SPEC, "1040")).toEqual([]);
  });

  it("una `## Acceptance criteria` REPETIDA deriva los rótulos de todos sus bloques", () => {
    const split = SPEC.replace(
      "## Scenarios",
      "## Acceptance criteria\n\n- [ ] AC-04: el tablero reporta siempre el digest funcional.\n\n## Scenarios",
    );
    // El sello ya digiere los dos bloques (arriba: «una sección repetida se
    // concatena»). Si la cosecha leyera sólo el primero, AC-04 sería contrato y
    // no sería direccionable a la vez: toda nota que lo enmiende bloquea con
    // `CONTRACT_ASSERTION_ABSENT` sobre un criterio que la spec enuncia, y el
    // plan queda `inconsistent` para siempre.
    expect(functionalSpecPayload(split)[ACCEPTANCE_CRITERIA_KEY]).toContain("AC-04");
    expect(parseSpecCriteria(split, "040")).toEqual([
      "S040/AC-01",
      "S040/AC-02",
      "S040/AC-03",
      "S040/AC-04",
    ]);
  });

  it("un rótulo con `*` o `+` de viñeta también deriva: el sello no mira el marcador", () => {
    // El sello digiere TODA línea de la sección, cualquiera sea su viñeta. Si la
    // cosecha anclara sólo en `-`, `* [ ] AC-02:` sería contrato y no sería
    // direccionable a la vez, y toda nota que lo enmiende moriría en
    // `CONTRACT_ASSERTION_ABSENT` sobre un criterio que su spec enuncia.
    const starred = SPEC.replace("- [ ] AC-02:", "* [ ] AC-02:").replace(
      "- [ ] AC-03:",
      "+ [x] **AC-03**:",
    );
    expect(functionalSpecPayload(starred)[ACCEPTANCE_CRITERIA_KEY]).toContain("AC-02");
    expect(parseSpecCriteria(starred, "040")).toEqual(["S040/AC-01", "S040/AC-02", "S040/AC-03"]);
  });

  it("el rótulo cierra en límite de token: EARS y la raya también derivan", () => {
    // La doctrina RECOMIENDA EARS (`AC-01 WHEN … THEN …`) y este proyecto escribe
    // `AC-01 — resultado`. Exigir `:` o `.` pegado al rótulo sellaría las dos
    // formas como contrato dejándolas indireccionables: el mismo defecto que la
    // viñeta de arriba, un nivel más abajo.
    const ears = SPEC.replace("- [ ] AC-01:", "- [ ] AC-01 WHEN el plan cambia THEN").replace(
      "- [ ] AC-02:",
      "- [ ] AC-02 — la spec no cambia",
    );
    expect(functionalSpecPayload(ears)[ACCEPTANCE_CRITERIA_KEY]).toContain("AC-02");
    expect(parseSpecCriteria(ears, "040")).toEqual(["S040/AC-01", "S040/AC-02", "S040/AC-03"]);
    // Y lo que no forma un id sigue sin derivar: el límite no es "cualquier cosa".
    const glued = SPEC.replace("- [ ] AC-01:", "- [ ] AC-01abc:");
    expect(parseSpecCriteria(glued, "040")).toEqual(["S040/AC-02", "S040/AC-03"]);
  });

  it("y el checklist se localiza como lo localiza el sello: un `###` homónimo no lo es", () => {
    const nested = SPEC.replace(
      "- ¿hace falta un comando de re-sello?",
      "### Acceptance criteria\n\n- [ ] AC-09: ¿hace falta un comando de re-sello?",
    );
    // Un H3 bajo `## Open questions` no entra al payload, así que tampoco puede
    // enunciar un criterio: sellar y direccionar leen la MISMA sección.
    expect(functionalSpecPayload(nested)[ACCEPTANCE_CRITERIA_KEY]).not.toContain("AC-09");
    expect(parseSpecCriteria(nested, "040")).not.toContain("S040/AC-09");
  });

  it("el NIVEL es contrato: un checklist entero en `###` no sella ni es direccionable", () => {
    // Congela la conducta que hoy es INTENCIONAL —el allowlist mira sólo H2— con
    // su consecuencia completa a la vista, que el caso de arriba no muestra: acá
    // el checklist NO es un homónimo bajo una sección editorial, es el único que
    // la spec tiene, anidado bajo otro `##`. Reescribir la promesa («se redondea»
    // → «se TRUNCA y se cobra el doble») NO mueve el digest y todos los planes
    // derivados siguen `aligned`, y el fallback de payload vacío no la rescata
    // porque `## Requirement` sí está en H2. Quien acepte el nivel en el
    // allowlist romperá el corte de `## Scenarios` (sus `### Scenario:`), así que
    // la defensa vive en la doctrina: acá queda pineado el precio de desviarse.
    const h3 = [
      "# Spec 099 — el redondeo",
      "",
      "## Requirement",
      "",
      "El precio se muestra con dos decimales.",
      "",
      "## Contract",
      "",
      "### Acceptance criteria",
      "",
      "- [ ] AC-01: el precio se redondea a 2 decimales.",
      "",
    ].join("\n");
    const rewritten = h3.replace(
      "el precio se redondea a 2 decimales.",
      "el precio se TRUNCA y se cobra el doble.",
    );
    expect(Object.keys(functionalSpecPayload(h3))).toEqual(["requirement"]);
    expect(functionalSpecDigest(rewritten)).toBe(functionalSpecDigest(h3));
    expect(parseSpecCriteria(h3, "099")).toEqual([]);
    // Y no es el fallback de payload vacío el que lo tapa: hay payload real.
    expect(functionalSpecDigest(h3)).not.toBe(specBaselineDigest(h3));
    // El mismo criterio en `##` SÍ sella y SÍ es direccionable.
    const h2 = h3.replace("### Acceptance criteria", "## Acceptance criteria");
    expect(functionalSpecDigest(h2.replace("se redondea a 2", "se TRUNCA a 2"))).not.toBe(
      functionalSpecDigest(h2),
    );
    expect(parseSpecCriteria(h2, "099")).toEqual(["S099/AC-01"]);
  });
});

// ── la ida completa, sobre una corrida real de plan-exec ──────────────────────

const fs = new NodeFileSystem();
const SESSION = "151-valvula-plan-exec";
const CODE = "151";
const ALIAS = "acme";
const WORKSPACE_BLOCK = `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

La válvula.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| ${ALIAS} | /tmp/acme | main |

## Status

- Ramas de trabajo actuales:
  - ${ALIAS}: main
<!-- AGENT-WORKFLOW-PROJECT-END -->
`;

/** El plan de la corrida: sellado funcional y con sus fuentes declaradas. */
const RUN_PLAN = `# Plan 041 — la válvula

> Derived from ${SPEC_PATH}
> Baseline: ${SPEC_PATH}@${functionalSpecDigest(SPEC)}
> Estado: open
> Límite de ejecución: checkout

## Origin

Spec 040.

## Tasks

### F1 — sellar lo funcional
> Estado: pendiente
> Fuentes: ${ALIAS}

- [ ] T1.1 — sellar el digest funcional _(fuentes: ${ALIAS})_
`;

/** La pregunta y el borrador que el agente declara al reconocer la desviación. */
const DECISION_PAYLOAD = {
  question: {
    assertions: ["S040/AC-03"],
    behaviors: [
      { key: "componer", summary: "se registra la nota y la ejecución sigue" },
      { key: "refinar", summary: "se vuelve a spec-refine" },
    ],
  },
  draft: {
    schema: "workline.decision-note/v1",
    decision: "AC-03 se satisface direccionando el rótulo, sin tocar la spec ni el plan",
    reason: "la cosecha de criterios ya deriva el id desde el rótulo",
    supersedes_assertions: ["S040/AC-03"],
    supersedes_note: null,
    scope: "functional",
    consumers: [PLAN_PATH],
    evidence_preserved: ["F1/T1.1 como historia"],
    evidence_invalidated: [],
    obligations: [],
    resume_point: "F1/T1.1",
    date: "2026-09-01",
  },
};

describe("la ida completa de la válvula, sobre una corrida real", () => {
  let workdir: string;
  let paths: PathsService;
  let env: FakeEnv;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-valvula-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    env = new FakeEnv(workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — la válvula\n\n## Objective\nejecutar el plan 041\n",
      "utf8",
    );
    await writeFile(join(workdir, "CLAUDE.md"), WORKSPACE_BLOCK, "utf8");
    await mkdir(join(workdir, "docs", "specs"), { recursive: true });
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(join(workdir, SPEC_PATH), SPEC, "utf8");
    await writeFile(join(workdir, PLAN_PATH), RUN_PLAN, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
  }

  async function answer(body: unknown, approval: string | null = null) {
    const result = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify(body),
      approval,
    });
    if (!result.ok) throw new Error(`un rechazo de negocio viaja ok:true: ${result.failure.code}`);
    return result.directive;
  }

  type Resolved = Awaited<ReturnType<typeof current>>["resolved"];

  function resultFor(resolved: Resolved): Record<string, unknown> {
    const action = resolved.action;
    if (action === null) throw new Error("esta frontera no nombra ninguna acción");
    const declared = effectsOf(resolved.stopped as FlowDecision);
    return {
      input_digest: resolved.seal,
      outcome: "completed",
      invocation: action.invocation,
      validations: action.evidence.map((id) => ({
        id,
        passed: true,
        detail: `salida real de ${id}`,
        ...(id === "workline.source-bounded"
          ? {
              proof: {
                kind: "inspection" as const,
                source: "workspace",
                relative_cwd: ".",
                checkout_digest: "test-checkout",
                invocation: { artifact: "tests/unit/spec-functional.test.ts" },
              },
            }
          : {}),
      })),
      effects: { planned: [...declared], approved: [], applied: [...declared] },
      output: null,
    };
  }

  /** Lo que la frontera vigente admite, con la desviación declarada donde va. */
  function bodyFor(resolved: Resolved, decision: unknown): Record<string, unknown> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") return resultFor(resolved);
    if (resolved.kind === "semantic") {
      const vocabulary = stopped.signals ?? [];
      const signals = [
        "plan.deviation-composable",
        "plan.closure-lineage",
        "plan.closure-intent",
        "plan.closure-impact",
        "plan.closure-recoverable",
      ].filter((signal) => vocabulary.includes(signal));
      const decisions =
        stopped.scopes_sources === true
          ? { plan: PLAN_PATH, sources: [ALIAS] }
          : stopped.id === "plan-exec.deviation-recognition" && decision !== null
            ? { paso: stopped.id, decision }
            : { paso: stopped.id };
      return { input_digest: resolved.seal, signals, decisions };
    }
    return { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" };
  }

  /** Contesta la frontera vigente UNA vez; un rechazo corta el recorrido acá. */
  async function step(resolved: Resolved, decision: unknown): Promise<void> {
    const stopped = resolved.stopped as FlowDecision;
    const approval =
      resolved.kind === "authorization"
        ? effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? [])
        : null;
    const directive = await answer(
      approval === null
        ? bodyFor(resolved, decision)
        : { input_digest: resolved.seal, choice: "Autorizar el efecto" },
      approval,
    );
    const error = directive.error ?? null;
    if (error !== null) throw new Error(`${stopped.id} rechazó: ${error.code} — ${error.message}`);
  }

  /** Adopta y contesta hasta que la corrida se pare en `id`. */
  async function walkTo(id: string, decision: unknown = null): Promise<void> {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "plan-exec", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    for (let taken = 0; taken < 40; taken += 1) {
      const { resolved } = await current();
      if (resolved.stopped === null || resolved.stopped.id === id) return;
      await step(resolved, decision);
    }
    throw new Error(`el recorrido nunca llegó a '${id}'`);
  }

  const board = () => buildWorklineIndex(fs, env, paths, { now: NOW });
  const planOf = async () => (await board()).plans.find((plan) => plan.number === "041");

  it("una spec con SÓLO rótulos AC-nn deja registrar la nota: compone y no bloquea", async () => {
    await walkTo("plan-exec.deviation-gate", DECISION_PAYLOAD);
    const gate = await current();
    expect(gate.resolved.kind).toBe("human");
    expect(gate.resolved.choices.map((choice) => choice.label)).toContain(
      "Registrar la decisión y seguir",
    );

    const directive = await answer({
      input_digest: gate.resolved.seal,
      choice: "Registrar la decisión y seguir",
    });
    expect(directive.error ?? null).toBeNull();

    // La nota quedó publicada fuera de la spec y del plan…
    const notes = await readFile(
      join(workdir, "docs/decisions/040-decisions-valvula.json"),
      "utf8",
    );
    expect(JSON.parse(notes).notes[0].supersedes_assertions).toEqual(["S040/AC-03"]);
    // …ni la spec ni el plan se tocaron…
    expect(await readFile(join(workdir, SPEC_PATH), "utf8")).toBe(SPEC);
    expect(await readFile(join(workdir, PLAN_PATH), "utf8")).toBe(RUN_PLAN);
    // …y el contrato COMPONE: la afirmación quedó enmendada y el plan cerrable.
    const plan = await planOf();
    expect(plan?.baseline.status).toBe("aligned");
    expect(plan?.contract?.assertions).toEqual([
      { id: "S040/AC-01", state: "baseline", by: null },
      { id: "S040/AC-02", state: "baseline", by: null },
      { id: "S040/AC-03", state: "amended", by: "DEC-001" },
    ]);
    expect(plan?.reconciliation).toEqual({ pending: [], resume_point: null, closable: true });
  });

  it("y una edición editorial de la spec después NO rompe la composición ni el sello", async () => {
    await walkTo("plan-exec.deviation-gate", DECISION_PAYLOAD);
    const gate = await current();
    await answer({
      input_digest: gate.resolved.seal,
      choice: "Registrar la decisión y seguir",
    });

    await writeFile(join(workdir, SPEC_PATH), EDITORIAL, "utf8");
    const plan = await planOf();
    expect(plan?.baseline.status).toBe("aligned");
    expect(plan?.contract?.applied).toEqual(["DEC-001"]);
    expect(plan?.reconciliation?.closable).toBe(true);
  });

  it("y con una nota LEGADA ya publicada la válvula sigue abierta de punta a punta", async () => {
    // El caso de los workspaces que YA registraron una decisión: su nota pineó
    // los bytes exactos. Si la composición no la aceptara, la corrida se caería
    // en `deviation-recognition` (no se prepara ninguna decisión nueva) o —peor—
    // `commitDecision` escribiría la nota nueva para recién después negarse a
    // componer la cadena a la que acaba de entrar.
    await mkdir(join(workdir, "docs", "decisions"), { recursive: true });
    const chainPath = join(workdir, "docs/decisions/040-decisions-valvula.json");
    await writeFile(chainPath, noteChain(RUN_PLAN, specBaselineDigest(SPEC), "S040/AC-01"), "utf8");

    await walkTo("plan-exec.deviation-gate", DECISION_PAYLOAD);
    const gate = await current();
    const directive = await answer({
      input_digest: gate.resolved.seal,
      choice: "Registrar la decisión y seguir",
    });
    expect(directive.error ?? null).toBeNull();

    const chain = JSON.parse(await readFile(chainPath, "utf8"));
    expect(chain.notes.map((note: { id: string }) => note.id)).toEqual(["DEC-001", "DEC-002"]);
    const plan = await planOf();
    expect(plan?.contract?.applied).toEqual(["DEC-001", "DEC-002"]);
    expect(plan?.reconciliation?.closable).toBe(true);
  });

  it("el handoff a spec-refine nombra la spec, no el comando pelado", async () => {
    await walkTo("plan-exec.deviation-gate", DECISION_PAYLOAD);
    const gate = await current();
    await answer({ input_digest: gate.resolved.seal, choice: "Volver a spec-refine" });

    const after = await current();
    expect(after.state.handoff?.command).toBe(`/w:spec-refine ${SPEC_PATH}`);
    expect(after.state.handoff?.destination).toBe("spec-refine");
  });

  it("con el plan ilegible degrada al comando pelado: una escalación no se bloquea", async () => {
    await walkTo("plan-exec.deviation-gate", DECISION_PAYLOAD);
    const gate = await current();
    await rm(join(workdir, PLAN_PATH));
    await answer({ input_digest: gate.resolved.seal, choice: "Volver a spec-refine" });

    expect((await current()).state.handoff?.command).toBe("/w:spec-refine");
  });

  it("el handoff a plan-refine sigue llevando su plan", async () => {
    await walkTo("plan-exec.deviation-gate", DECISION_PAYLOAD);
    const gate = await current();
    await answer({ input_digest: gate.resolved.seal, choice: "Volver a plan-refine" });

    expect((await current()).state.handoff?.command).toBe(`/w:plan-refine ${PLAN_PATH}`);
  });
});
