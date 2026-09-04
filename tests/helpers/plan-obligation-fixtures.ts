/**
 * Planes con una obligación VIVA, sembrados donde el tablero los lee.
 *
 * Viven acá porque las superficies tienen que proyectar el mismo hecho por la
 * misma derivación, y eso sólo se prueba pidiéndoles a todas lo mismo sobre el
 * mismo workspace: un fixture por superficie es exactamente el hueco por el que
 * `status`, `resume` y el rechazo del sello llegaron a describir distinto un
 * mismo bloqueo.
 */

import {
  noteIndexArtifact,
  noteIndexPath,
  sealNote,
} from "../../src/application/decision-note-service.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  type NoteObligation,
} from "../../src/domain/decision-note.js";
import { baseDigest } from "../../src/domain/proposal.js";
import type { MemFs } from "./mem-fs.js";

// ── el plan CERRADO cuyo traspaso sigue vigente (F4/T4.3) ────────────────────

export const HANDOFF_SPEC = "docs/specs/041-spec-traspaso.md";
export const HANDOFF_PLAN = "docs/plans/040-plan-traspaso.md";
/** El trabajo que quedó en manos de afuera, en las palabras de la nota. */
export const HANDOFF_TEXT = "Producto y QA validan el flujo nuevo en la demo del jueves";
/** La cadena del linaje, para el caso complementario: sin ella no se debe nada. */
export const HANDOFF_CHAIN = noteIndexPath("docs/decisions", "041", "traspaso");

// ── el plan EJECUTADO que debe compensación (F4/T4.2 y T4.4) ─────────────────

export const OWING_SPEC = "docs/specs/043-spec-deuda.md";
export const OWING_PLAN = "docs/plans/044-plan-deuda.md";
/** La compensación que retiene el cierre, en las palabras de la nota. */
export const OWING_TEXT = "revalidar F1 contra el criterio nuevo";

/**
 * Un plan cerrado, con su spec refinada y un traspaso declarado vigente.
 *
 * La clase va declarada: lo que se prueba es la visibilidad de un traspaso, no
 * la lectura de una nota legada — eso lo fija la tabla de correspondencia.
 */
export function seedClosedPlanWithHandoff(fs: MemFs, assurance?: string): void {
  seed(fs, {
    ...(assurance === undefined ? {} : { assurance }),
    spec: { path: HANDOFF_SPEC, number: "041", slug: "traspaso" },
    plan: { path: HANDOFF_PLAN, number: "040", state: "done", phase: "validada" },
    note: { text: HANDOFF_TEXT, kind: "handoff", declared: true },
    session: "140-traspaso-plan-exec",
  });
}

/**
 * El MISMO traspaso sobre un plan que todavía no cerró.
 *
 * Sellado y con su cadena legible —si no, no habría reconciliación y la prueba
 * pasaría sin ejercitar nada—, pero con su fase abierta: un traspaso no bloquea,
 * así que este plan tiene que seguir ejecutándose por su ruta normal.
 */
export function seedOpenPlanWithHandoff(fs: MemFs): void {
  seed(fs, {
    spec: { path: HANDOFF_SPEC, number: "041", slug: "traspaso" },
    plan: { path: HANDOFF_PLAN, number: "040", state: "open", phase: "pendiente" },
    note: { text: HANDOFF_TEXT, kind: "handoff", declared: true },
    session: "140-traspaso-plan-exec",
  });
}

/**
 * Un plan ABIERTO con todo validado y tildado, que debe una compensación.
 *
 * Es la forma exacta que tiene una corrida cuando llega a `plan-exec.plan-done`:
 * los contadores cuadran —así que el rechazo no puede ser el de los contadores—
 * y lo único que retiene el sello es la obligación.
 */
export function seedExecutedPlanOwingCompensation(fs: MemFs): void {
  seed(fs, {
    spec: { path: OWING_SPEC, number: "043", slug: "deuda" },
    plan: { path: OWING_PLAN, number: "044", state: "open", phase: "validada" },
    note: { text: OWING_TEXT, kind: "compensation", declared: true },
    session: "144-deuda-plan-exec",
  });
}

interface Fixture {
  spec: { path: string; number: string; slug: string };
  plan: { path: string; number: string; state: "open" | "done"; phase: "validada" | "pendiente" };
  /** `> Assurance:` del preámbulo, para el cierre que no se verificó. */
  assurance?: string;
  note: NoteObligation;
  session: string;
}

function seed(fs: MemFs, fixture: Fixture): void {
  const specText = [
    // Refinada y con su plan derivado: así la spec no entra al pipeline por su
    // cuenta y lo único pendiente del workspace es la obligación.
    "---",
    "status: ready-for-plan",
    "---",
    "",
    `# ${fixture.spec.number} — spec fixture`,
    "",
    "## Acceptance criteria",
    "",
    `- [ ] **S${fixture.spec.number}/AC-01 — una.** texto`,
    "",
  ].join("\n");
  // Con la fase validada todo cuadra —tareas y fases— así que ningún rechazo
  // puede atribuirse a los contadores; con la fase pendiente el plan es
  // simplemente uno abierto con trabajo por delante.
  const done = fixture.plan.phase === "validada";
  const planText = [
    `# ${fixture.plan.number} — plan fixture`,
    "",
    `> Derived from: ${fixture.spec.path}`,
    `> Baseline: ${fixture.spec.path}@sha256:${baseDigest(specText)}`,
    `> Estado: ${fixture.plan.state}`,
    ...(fixture.plan.state === "done" ? ["> Cierre: cerrado con su evidencia"] : []),
    ...(fixture.assurance === undefined ? [] : [`> Assurance: ${fixture.assurance}`]),
    "",
    "## Tasks",
    "",
    "### F1 — la única fase",
    `> Estado: ${fixture.plan.phase}`,
    "",
    "**Trabajo:**",
    done ? "- [x] T1.1 — hecho y validado" : "- [ ] T1.1 — falta",
    "",
  ].join("\n");
  fs.file(`/cwd/${fixture.spec.path}`, specText);
  fs.file(`/cwd/${fixture.plan.path}`, planText);

  const index = {
    schema: "workline.decision-index/v1" as const,
    spec: { path: fixture.spec.path, number: fixture.spec.number },
    notes: [] as DecisionNote[],
  };
  const sealed = sealNote(index, {
    schema: NOTE_SCHEMA,
    lineage: {
      spec: {
        path: fixture.spec.path,
        number: fixture.spec.number,
        digest: functionalSpecDigest(specText),
      },
      plan: {
        path: fixture.plan.path,
        number: fixture.plan.number,
        digest: `sha256:${baseDigest(planText)}`,
      },
      execution: { session: fixture.session, phase: "F1" },
    },
    decision: "el resultado de F1 ya no satisface el contrato vigente",
    reason: "la afirmación que probaba cambió",
    supersedes_assertions: [`S${fixture.spec.number}/AC-01`],
    supersedes_note: null,
    scope: "functional",
    consumers: [fixture.plan.path],
    evidence_preserved: ["F1/T1.1 como historia"],
    evidence_invalidated: [],
    obligations: [fixture.note],
    // La nota apunta a F1/T1.1, y F1 está VALIDADA: es el punto que ninguna
    // superficie debe ofrecer como lugar al que volver.
    resume_point: "F1/T1.1",
    date: "2026-07-20",
  });
  // Por el escritor real: una serialización a mano rompería el sello.
  const artifact = noteIndexArtifact(
    noteIndexPath("docs/decisions", fixture.spec.number, fixture.spec.slug),
    { ...index, notes: [sealed] },
  );
  fs.file(`/cwd/${artifact.path}`, artifact.content);
}
