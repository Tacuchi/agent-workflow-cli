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
  normalizeObligations,
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
    obligations: [
      { text: "revalidar F3 contra el contrato compuesto", kind: "compensation", declared: true },
    ],
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

// ─────────────────────────────────────────────────────────────────────────────
// La clase de una obligación (plan 042 · F1 · S042/AC-03 y S042/AC-04).
//
// Dos formas y un solo sello. La forma de texto es la que quedó publicada antes
// de que las clases existieran y se LEE como compensación —la mitad segura—;
// la forma con clase es la única que la vía de escritura acepta. El digest se
// calcula sobre el registro TAL COMO SE ESCRIBIÓ, así que ninguna nota ya
// publicada cambia de sello por haber ganado un lector nuevo.

describe("las obligaciones llevan clase, y las ya publicadas siguen leyéndose", () => {
  const PATH = "docs/decisions/033-decisions-x.json";
  /** El registro tal como quedó en disco antes de que las clases existieran. */
  const legacy = (): Record<string, unknown> => {
    const text = "revalidar el recorrido PLAN completo";
    const digest = computeNoteDigest({
      ...draft(),
      obligations: normalizeObligations([text]) ?? [],
    });
    return { ...draft(), obligations: [text], digest };
  };

  it("una nota en forma de texto se lee como compensación NO declarada", () => {
    const read = validateDecisionNote(legacy());

    expect(read.ok).toBe(true);
    expect(read.value?.obligations).toEqual([
      { text: "revalidar el recorrido PLAN completo", kind: "compensation", declared: false },
    ]);
  });

  it("y conserva su digest: leerla distinto no la re-sella", () => {
    const raw = legacy();
    const read = validateDecisionNote(raw);

    expect(read.ok).toBe(true);
    expect(read.value?.digest).toBe(raw.digest);
  });

  it("volver a escribirla devuelve la obligación con los bytes que tenía", async () => {
    const fs = new MemFs({ lenient: true });
    const before = `${JSON.stringify({ schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [legacy()] }, null, 2)}\n`;
    fs.file(`/cwd/${PATH}`, before);
    const read = await readNoteIndex(fs, "/cwd", PATH, SPEC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // El escritor real, sobre lo que el lector devolvió: byte por byte lo mismo.
    expect(noteIndexArtifact(PATH, read.read.index).content).toBe(before);
  });

  it("una nota con clase declarada la conserva y se sella sobre { text, kind }", () => {
    const n = note({
      obligations: [{ text: "avisar a Producto y QA", kind: "handoff", declared: true }],
    });
    const read = validateDecisionNote(n);

    expect(read.ok).toBe(true);
    expect(read.value?.obligations).toEqual([
      { text: "avisar a Producto y QA", kind: "handoff", declared: true },
    ]);
    // El sello de la forma con clase NO es el de la forma de texto: son bytes
    // distintos, y por eso una no puede hacerse pasar por la otra.
    const asText = { ...draft(), obligations: ["avisar a Producto y QA"] };
    expect(read.value?.digest).not.toBe(
      computeNoteDigest(asText as unknown as Omit<DecisionNote, "digest">),
    );
  });

  it("una obligación que no es ni texto ni { text, kind } se rechaza con su código", () => {
    const read = validateDecisionNote(
      note({ obligations: [{ text: "x", kind: "otra" }] as never }),
    );

    expect(read.ok).toBe(false);
    expect(read.failures.map((f) => f.code)).toContain("NOTE_OBLIGATIONS_INVALID");
  });

  it("anexar una nota NUEVA sin clase se rechaza nombrando las dos clases", () => {
    const index: DecisionIndex = { schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [] };
    const incoming = validateDecisionNote(legacy());
    expect(incoming.ok).toBe(true);
    if (!incoming.ok || incoming.value === null) return;

    const appended = appendNote(index, incoming.value);

    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.failures.map((f) => f.code)).toContain("NOTE_OBLIGATION_KIND_MISSING");
    expect(appended.failures[0]?.action).toContain("compensation");
    expect(appended.failures[0]?.action).toContain("handoff");
  });

  it("y una con clase entra sin problema: la tolerancia es de lectura, no de escritura", () => {
    const index: DecisionIndex = { schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [] };
    const classed = note({
      obligations: [{ text: "revalidar F2 completo", kind: "compensation", declared: true }],
    });

    expect(appendNote(index, classed).ok).toBe(true);
  });

  it("re-sellar una nota ya leída no le mueve el sello, en ninguna de las dos formas", () => {
    const empty = (): DecisionIndex => ({ schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [] });

    for (const value of [
      ["revalidar el recorrido PLAN completo"],
      [{ text: "avisar a Producto y QA", kind: "handoff" }],
    ]) {
      const written = sealNote(empty(), {
        ...draft(),
        obligations: value,
      } as unknown as Omit<DecisionNote, "id" | "digest">);
      const read = validateDecisionNote(written);
      expect(read.ok).toBe(true);
      if (!read.ok || read.value === null) return;

      // Volver a sellar lo que el lector devolvió da el mismo digest: leer y
      // escribir son la misma forma, y una vuelta más no re-sella nada.
      expect(sealNote(empty(), read.value).digest).toBe(written.digest);
    }
  });
});

describe("la vía de escritura no se cae ante un borrador mal formado", () => {
  const index = (): DecisionIndex => ({ schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [] });
  const withObligations = (value: unknown) => {
    const { obligations: _drop, ...rest } = draft();
    return { ...rest, obligations: value } as unknown as Omit<DecisionNote, "id" | "digest">;
  };

  const cases: Array<[string, unknown]> = [
    ["ausentes", undefined],
    ["nulas", null],
    ["que no son lista", "revalidar F3"],
    ["con una entrada nula", [null]],
    ["con una entrada numérica", [42]],
    ["con una clase inventada", [{ text: "x", kind: "urgente" }]],
  ];

  it.each(cases)("obligaciones %s: rechazo con código, nunca una excepción", (_name, value) => {
    const sealed = sealNote(index(), withObligations(value));
    const appended = appendNote(index(), sealed);

    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.failures.every((f) => f.code.length > 0 && f.action.length > 0)).toBe(true);
    expect(appended.failures.map((f) => f.code)).toContain(
      Array.isArray(value) ? "NOTE_OBLIGATIONS_INVALID" : "NOTE_OBLIGATIONS_MISSING",
    );
  });

  it("un registro que se dice NO declarado no compra su clase con decirla", () => {
    const forged = { text: "revalidar F3", kind: "handoff", declared: false };
    const body = { ...draft(), obligations: normalizeObligations([forged]) ?? [] };
    const read = validateDecisionNote({ ...body, digest: computeNoteDigest(body) });

    // Sella como texto suelto —esa es su forma de disco— así que leerlo como
    // traspaso pondría a dos superficies a discrepar sobre los mismos bytes.
    expect(read.ok).toBe(true);
    expect(read.value?.obligations).toEqual([
      { text: "revalidar F3", kind: "compensation", declared: false },
    ]);
  });

  it("con clases mezcladas, el rechazo nombra sólo las que no la declararon", () => {
    const mixed = validateDecisionNote({
      ...draft(),
      obligations: [
        { text: "avisar a Producto y QA", kind: "handoff" },
        "revalidar el recorrido PLAN completo",
      ],
      digest: computeNoteDigest({
        ...draft(),
        obligations:
          normalizeObligations([
            { text: "avisar a Producto y QA", kind: "handoff" },
            "revalidar el recorrido PLAN completo",
          ]) ?? [],
      }),
    });
    expect(mixed.ok).toBe(true);
    if (!mixed.ok || mixed.value === null) return;

    const appended = appendNote({ schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [] }, mixed.value);

    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    const message = appended.failures[0]?.message ?? "";
    expect(message).toContain("revalidar el recorrido PLAN completo");
    expect(message).not.toContain("avisar a Producto y QA");
  });
});

describe("una cadena MIXTA conserva cada nota en la forma con la que se publicó", () => {
  const PATH = "docs/decisions/033-decisions-x.json";

  it("la legada sigue siendo texto suelto y la nueva { text, kind }, y todo verifica", async () => {
    const legacyBody = {
      ...draft(),
      obligations: normalizeObligations(["revalidar el recorrido PLAN completo"]) ?? [],
    };
    const published: DecisionNote = { ...legacyBody, digest: computeNoteDigest(legacyBody) };

    const chain: DecisionIndex = { schema: NOTE_INDEX_SCHEMA, spec: SPEC, notes: [published] };
    const incoming = sealNote(chain, {
      ...draft({ date: "2026-08-17" }),
      obligations: [{ text: "avisar a Producto y QA", kind: "handoff", declared: true }],
    });
    const appended = appendNote(chain, incoming);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const fs = new MemFs({ lenient: true });
    const written = noteIndexArtifact(PATH, appended.index);
    fs.file(`/cwd/${PATH}`, written.content);

    const parsed = JSON.parse(written.content) as { notes: Array<{ obligations: unknown }> };
    expect(parsed.notes[0]?.obligations).toEqual(["revalidar el recorrido PLAN completo"]);
    expect(parsed.notes[1]?.obligations).toEqual([
      { text: "avisar a Producto y QA", kind: "handoff" },
    ]);

    // Y la cadena entera vuelve a leerse, con los dos sellos intactos y los
    // mismos bytes: anexar no reescribió la nota que ya estaba publicada.
    const read = await readNoteIndex(fs, "/cwd", PATH, SPEC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.read.index.notes.map((n) => n.digest)).toEqual([published.digest, incoming.digest]);
    expect(noteIndexArtifact(PATH, read.read.index).content).toBe(written.content);
  });
});
