// La nota de decisión como artefacto contractual durable (F2 del plan 032).
//
// Una nota es autoritativa o no existe. Eso son dos reglas: completa o
// rechazada —cada campo ausente con su propio código, porque «la nota es
// inválida» manda a releer el record entero y `NOTE_RESUME_POINT_MISSING` manda
// a la única línea que falta—, y append-only: corregir una nota publica OTRA que
// la sustituye por referencia, nunca reescribe la anterior.
//
// Y la invariante que le da forma a todo: la nota vive FUERA de lo que decide.
// Guardada dentro de su spec o de su plan cambiaría el digest de ese documento,
// así que el contrato enmendado dejaría de ser el contrato que se enmendó.
//
// Validación de fase de F2, en su orden:
//   1. una nota completa vuelve a leerse idéntica;
//   2. quitar cada campo obligatorio produce su código propio y ninguna escritura;
//   3. los bytes de la spec y del plan son idénticos antes y después de publicar;
//   4. dos notas del mismo linaje conservan un orden determinista;
//   5. un intento de reescribir una nota publicada se rechaza.

import { describe, expect, it } from "vitest";
import {
  type DecisionIndex,
  NOTE_INDEX_SCHEMA,
  appendNote,
  checkNoBaselineRewrite,
  nextNoteId,
  noteIndexArtifact,
  noteIndexPath,
  readNoteIndex,
  sealNote,
} from "../../src/application/decision-note-service.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  computeNoteDigest,
  effectiveNotes,
  orderNotes,
  validateDecisionNote,
} from "../../src/domain/decision-note.js";
import { MemFs } from "../helpers/mem-fs.js";

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

const LINEAGE = { spec: SPEC, plan: PLAN, execution: { session: "131-x-plan-exec", phase: "F4" } };

function draft(over: Partial<DecisionNote> = {}): Omit<DecisionNote, "digest"> {
  return {
    schema: NOTE_SCHEMA,
    id: "DEC-001",
    lineage: LINEAGE,
    decision: "El gate compone la decisión en vez de escalar.",
    reason: "La divergencia conserva el linaje funcional y su impacto es enumerable.",
    supersedes_assertions: ["S033/AC-05"],
    supersedes_note: null,
    scope: "plan-only",
    consumers: [PLAN.path],
    evidence_preserved: ["tests/unit/lineage.test.ts"],
    evidence_invalidated: [],
    obligations: ["revalidar F3 contra el contrato compuesto"],
    resume_point: "F4/T4.2",
    date: "2026-08-16",
    ...over,
  };
}

function note(over: Partial<DecisionNote> = {}): DecisionNote {
  const body = draft(over);
  return { ...body, digest: computeNoteDigest(body) };
}

/** Lo que `sealNote` acepta: el cuerpo SIN id ni digest, que los pone la cadena. */
function body(over: Partial<DecisionNote> = {}): Omit<DecisionNote, "id" | "digest"> {
  const { id: _id, ...rest } = draft(over);
  return rest;
}

describe("F2.1 — una nota completa vuelve a leerse idéntica", () => {
  it("valida y devuelve exactamente lo que se selló", () => {
    const n = note();
    const read = validateDecisionNote(n);
    expect(read.failures).toEqual([]);
    expect(read.ok).toBe(true);
    expect(read.value).toEqual(n);
  });

  it("sobrevive al viaje por JSON sin cambiar un byte", () => {
    const n = note();
    const round = validateDecisionNote(JSON.parse(JSON.stringify(n)));
    expect(round.value).toEqual(n);
    expect(computeNoteDigest(draft())).toBe(n.digest);
  });

  it("el sello es sobre el CONTENIDO: cambiar una palabra lo cambia", () => {
    expect(computeNoteDigest(draft({ reason: "otra razón" }))).not.toBe(computeNoteDigest(draft()));
  });

  it("una nota reescrita en su sitio se detecta por su propio digest", () => {
    const tampered = { ...note(), decision: "otra cosa" };
    const read = validateDecisionNote(tampered);
    expect(read.ok).toBe(false);
    expect(read.failures.map((f) => f.code)).toContain("NOTE_DIGEST_MISMATCH");
  });
});

describe("F2.2 — quitar cada campo obligatorio produce su código propio", () => {
  const cases: Array<[keyof DecisionNote, string]> = [
    ["lineage", "NOTE_LINEAGE_MISSING"],
    ["decision", "NOTE_DECISION_MISSING"],
    ["reason", "NOTE_REASON_MISSING"],
    ["supersedes_assertions", "NOTE_ASSERTIONS_MISSING"],
    ["scope", "NOTE_SCOPE_INVALID"],
    ["consumers", "NOTE_CONSUMERS_MISSING"],
    ["evidence_preserved", "NOTE_EVIDENCE_PRESERVED_MISSING"],
    ["evidence_invalidated", "NOTE_EVIDENCE_INVALIDATED_MISSING"],
    ["obligations", "NOTE_OBLIGATIONS_MISSING"],
    ["resume_point", "NOTE_RESUME_POINT_MISSING"],
    ["date", "NOTE_DATE_INVALID"],
    ["digest", "NOTE_DIGEST_MISSING"],
  ];

  it.each(cases)("sin '%s' rechaza con %s", (field, code) => {
    const broken: Record<string, unknown> = { ...note() };
    delete broken[field];
    const read = validateDecisionNote(broken);
    expect(read.ok).toBe(false);
    expect(read.value).toBeNull();
    expect(read.failures.map((f) => f.code)).toContain(code);
  });

  it("cada código es distinto: ninguno se apoya en un genérico", () => {
    const codes = cases.map(([, code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("todo rechazo trae su acción, no sólo su queja", () => {
    const read = validateDecisionNote({ ...note(), resume_point: "  " });
    expect(read.failures.every((f) => f.action.length > 0)).toBe(true);
  });

  it("el estado de ejecución del linaje tiene su propio código", () => {
    const withoutExecution: Record<string, unknown> = { ...note() };
    withoutExecution.lineage = { spec: SPEC, plan: PLAN };
    const read = validateDecisionNote(withoutExecution);
    expect(read.failures.map((f) => f.code)).toContain("NOTE_EXECUTION_STATE_MISSING");
  });

  it("un baseline sin digest se rechaza: decidiría sobre un nombre, no sobre bytes", () => {
    const read = validateDecisionNote(
      note({ lineage: { ...LINEAGE, spec: { ...SPEC, digest: "no" } } }),
    );
    expect(read.failures.map((f) => f.code)).toContain("NOTE_LINEAGE_DIGEST_INVALID");
  });

  it("las afirmaciones usan la gramática de criterio que ya existe, no una segunda", () => {
    const read = validateDecisionNote(note({ supersedes_assertions: ["criterio 5"] }));
    expect(read.failures.map((f) => f.code)).toContain("NOTE_ASSERTIONS_INVALID");
  });

  it("un formato desconocido corre solo y primero, sin reportar sinsentidos derivados", () => {
    const read = validateDecisionNote({ schema: "otra/v9" });
    expect(read.failures.map((f) => f.code)).toEqual(["NOTE_SCHEMA_UNKNOWN"]);
  });
});

describe("F2.3 — registrar una nota no reescribe su baseline", () => {
  it("una propuesta que incluyera la spec o el plan se rechaza nombrando cuál", () => {
    const failures = checkNoBaselineRewrite(
      [{ path: "docs/decisions/033-decisions-x.json" }, { path: SPEC.path }, { path: PLAN.path }],
      LINEAGE,
    );
    expect(failures.map((f) => f.code)).toEqual([
      "NOTE_REWRITES_BASELINE",
      "NOTE_REWRITES_BASELINE",
    ]);
    expect(failures[0]?.message).toContain(SPEC.path);
    expect(failures[1]?.message).toContain(PLAN.path);
  });

  it("una propuesta que sólo escribe el índice pasa", () => {
    expect(
      checkNoBaselineRewrite([{ path: "docs/decisions/033-decisions-x.json" }], LINEAGE),
    ).toEqual([]);
  });

  it("el artefacto publicado no contiene la ruta de la spec ni la del plan como destino", () => {
    const index: DecisionIndex = { schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [note()] };
    const artifact = noteIndexArtifact(noteIndexPath("docs/decisions", "033", "x"), index);
    expect(artifact.path).toBe("docs/decisions/033-decisions-x.json");
    expect(checkNoBaselineRewrite([artifact], LINEAGE)).toEqual([]);
  });
});

describe("F2.4 — dos notas del mismo linaje conservan un orden determinista", () => {
  const a = note({ id: "DEC-001", date: "2026-08-16" });
  const b = note({ id: "DEC-002", date: "2026-08-16" });
  const c = note({ id: "DEC-003", date: "2026-08-15" });

  it("por fecha y, a igual fecha, por correlativo", () => {
    expect(orderNotes([b, a, c]).map((n) => n.id)).toEqual(["DEC-003", "DEC-001", "DEC-002"]);
  });

  it("el orden no depende de en qué orden llegaron", () => {
    const one = orderNotes([a, b, c]).map((n) => n.id);
    const two = orderNotes([c, b, a]).map((n) => n.id);
    const three = orderNotes([b, c, a]).map((n) => n.id);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
  });

  it("el correlativo ordena por número, no por texto", () => {
    const ten = note({ id: "DEC-010" });
    const nine = note({ id: "DEC-009" });
    expect(orderNotes([ten, nine]).map((n) => n.id)).toEqual(["DEC-009", "DEC-010"]);
  });

  it("vigentes = las que nadie sustituyó después", () => {
    const fix = note({ id: "DEC-002", supersedes_note: "DEC-001" });
    expect(effectiveNotes([a, fix]).map((n) => n.id)).toEqual(["DEC-002"]);
  });
});

describe("F2.5 — una nota publicada no se reescribe", () => {
  const index = (): DecisionIndex => ({ schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [note()] });

  it("volver a publicar el mismo id se rechaza y manda a sustituir", () => {
    const result = appendNote(index(), note({ decision: "corregida" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("NOTE_ALREADY_PUBLISHED");
    expect(result.failures.find((f) => f.code === "NOTE_ALREADY_PUBLISHED")?.action).toContain(
      "sustituya",
    );
  });

  it("corregir es publicar otra nota que nombra a la anterior", () => {
    const base = index();
    const fix = sealNote(base, body({ supersedes_note: "DEC-001" }));
    const result = appendNote(base, fix);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.notes.map((n) => n.id)).toEqual(["DEC-001", "DEC-002"]);
    // La nota vieja sigue byte-idéntica dentro del índice: se agregó, no se editó.
    expect(result.index.notes[0]).toEqual(base.notes[0]);
    expect(effectiveNotes(result.index.notes).map((n) => n.id)).toEqual(["DEC-002"]);
  });

  it("sustituir una nota que no está en el linaje se rechaza", () => {
    const base = index();
    const orphan = sealNote(base, body({ supersedes_note: "DEC-077" }));
    const result = appendNote(base, orphan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("NOTE_SUPERSEDES_ABSENT");
  });

  it("el id lo asigna la cadena, no quien escribe la nota", () => {
    const base = index();
    expect(nextNoteId(base)).toBe("DEC-002");
    expect(sealNote(base, body()).id).toBe("DEC-002");
  });
});

describe("el índice por linaje se lee del workspace", () => {
  const PATH = "docs/decisions/033-decisions-x.json";

  it("un linaje sin cadena todavía devuelve una vacía, y dice que no existe", async () => {
    const read = await readNoteIndex(new MemFs({ lenient: true }), "/cwd", PATH, SPEC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.read).toEqual({
      index: { schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [] },
      exists: false,
    });
  });

  it("una cadena publicada vuelve a leerse con sus notas en orden", async () => {
    const fs = new MemFs({ lenient: true });
    const index: DecisionIndex = {
      schema: NOTE_INDEX_SCHEMA,
      spec: SPEC,
      notes: [note({ id: "DEC-002" }), note({ id: "DEC-001" })],
    };
    fs.file(`/cwd/${PATH}`, noteIndexArtifact(PATH, index).content);
    const read = await readNoteIndex(fs, "/cwd", PATH, SPEC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.read.exists).toBe(true);
    expect(read.read.index.notes.map((n) => n.id)).toEqual(["DEC-001", "DEC-002"]);
  });

  it("una nota corrupta en el índice se reporta, no se descarta en silencio", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file(
      `/cwd/${PATH}`,
      JSON.stringify({
        schema: NOTE_INDEX_SCHEMA,
        spec: SPEC,
        notes: [{ ...note(), reason: "x" }],
      }),
    );
    const read = await readNoteIndex(fs, "/cwd", PATH, SPEC);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failures.map((f) => f.code)).toContain("NOTE_DIGEST_MISMATCH");
    expect(read.failures[0]?.message).toContain("notes[0]");
  });

  it("un índice ilegible se reporta con su causa", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file(`/cwd/${PATH}`, "{ no es json");
    const read = await readNoteIndex(fs, "/cwd", PATH, SPEC);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failures[0]?.code).toBe("NOTE_INDEX_UNREADABLE");
  });
});
