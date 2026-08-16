// Hecho y preferencia no los decide el mismo juez (T5.3 del plan 032, S033/AC-06).
//
// La evidencia resuelve hechos: cuando deja UNA conducta en pie no hay nada que
// preferir y no se pregunta. Cuando quedan varias, lo que queda es una
// preferencia y la elige la persona — salvo que el mismo linaje ya tenga una
// decisión durable que responda esta misma pregunta y cuyas premisas sigan
// vigentes, porque volver a preguntar sería pedirle a alguien que se repita.
//
// Las premisas NO se re-derivan acá: una nota que sobrevivió a la composición de
// F3 fue compuesta sobre el baseline vigente, sobre afirmaciones que la spec
// sigue enunciando, y sin que nadie la sustituyera. Los tests lo comprueban
// componiendo de verdad, no fabricando un contrato a mano.

import { describe, expect, it } from "vitest";
import { type DecisionQuestion, resolveDecision } from "../../src/domain/decision-choice.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  computeNoteDigest,
} from "../../src/domain/decision-note.js";
import {
  type BaselineInput,
  type EffectiveContract,
  composeEffectiveContract,
} from "../../src/domain/effective-contract.js";

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

const BASELINE: BaselineInput = {
  ...SPEC,
  criteria: ["S033/AC-01", "S033/AC-02", "S033/AC-03"],
};

function note(over: Partial<DecisionNote> = {}): DecisionNote {
  const body: Omit<DecisionNote, "digest"> = {
    schema: NOTE_SCHEMA,
    id: "DEC-001",
    lineage: { spec: SPEC, plan: PLAN, execution: { session: "131-x", phase: "F5" } },
    decision: "el gate se detiene y ofrece cuatro salidas",
    reason: "la elegibilidad es cierre y no tamaño",
    supersedes_assertions: ["S033/AC-01"],
    supersedes_note: null,
    scope: "plan-only",
    consumers: [PLAN.path],
    evidence_preserved: [],
    evidence_invalidated: [],
    obligations: [],
    resume_point: "F5/T5.1",
    date: "2026-08-16",
    ...over,
  };
  return { ...body, digest: computeNoteDigest(body) };
}

/** Compone de verdad: un contrato que no compone no es un contrato. */
function contractOf(chain: readonly DecisionNote[]): EffectiveContract {
  const composed = composeEffectiveContract(BASELINE, chain);
  if (composed.status !== "composed") {
    throw new Error(`la cadena de prueba no compone: ${JSON.stringify(composed.failures)}`);
  }
  return composed.contract;
}

const TWO: DecisionQuestion = {
  assertions: ["S033/AC-01"],
  behaviors: [
    { key: "detener", summary: "el gate se detiene y ofrece salidas" },
    { key: "seguir", summary: "el gate registra y sigue" },
  ],
};

describe("resolveDecision — la evidencia resuelve hechos", () => {
  it("no pregunta cuando queda una sola conducta en pie", () => {
    const resolution = resolveDecision(
      { assertions: ["S033/AC-01"], behaviors: [{ key: "detener", summary: "única en pie" }] },
      contractOf([]),
      [],
    );

    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") throw new Error("esperaba settled");
    expect(resolution.behavior.key).toBe("detener");
  });

  it("una nota previa NO puede pisar un hecho que la evidencia acaba de establecer", () => {
    // La nota decide "seguir" y está vigente; la evidencia dejó sólo "detener".
    const previous = note({ decision: "seguir" });
    const resolution = resolveDecision(
      { assertions: ["S033/AC-01"], behaviors: [{ key: "detener", summary: "única en pie" }] },
      contractOf([previous]),
      [previous],
    );

    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") throw new Error("esperaba settled");
    expect(resolution.behavior.key).toBe("detener");
  });
});

describe("resolveDecision — la preferencia la elige la persona", () => {
  it("pregunta cuando quedan varias conductas y ninguna nota previa las cubre", () => {
    const resolution = resolveDecision(TWO, contractOf([]), []);

    expect(resolution.kind).toBe("ask");
    if (resolution.kind !== "ask") throw new Error("esperaba ask");
    expect(resolution.behaviors).toHaveLength(2);
    expect(resolution.why).toContain("ninguna decisión durable previa");
  });

  it("reusa una decisión durable previa inequívoca sin volver a preguntar", () => {
    const previous = note();
    const resolution = resolveDecision(TWO, contractOf([previous]), [previous]);

    expect(resolution.kind).toBe("reused");
    if (resolution.kind !== "reused") throw new Error("esperaba reused");
    expect(resolution.note).toBe("DEC-001");
    expect(resolution.decision).toBe("el gate se detiene y ofrece cuatro salidas");
  });

  it("una nota SUSTITUIDA dejó de ser premisa vigente y no se reusa", () => {
    const first = note();
    const second = note({
      id: "DEC-002",
      decision: "el gate registra y sigue",
      supersedes_note: "DEC-001",
      supersedes_assertions: ["S033/AC-02"],
      date: "2026-08-17",
    });

    // Sólo DEC-002 queda vigente, y no cubre AC-01: nadie responde la pregunta.
    const contract = contractOf([first, second]);
    expect(contract.applied).toEqual(["DEC-002"]);

    const resolution = resolveDecision(TWO, contract, [first, second]);
    expect(resolution.kind).toBe("ask");
  });

  it("una nota que cubre sólo PARTE de la pregunta no es reuso, y lo dice", () => {
    const partial = note({ supersedes_assertions: ["S033/AC-01"] });
    const resolution = resolveDecision(
      { assertions: ["S033/AC-01", "S033/AC-02"], behaviors: TWO.behaviors },
      contractOf([partial]),
      [partial],
    );

    // Decidir por silencio la mitad restante sería exactamente la
    // preferencia-desde-la-evidencia que esta función existe para impedir.
    expect(resolution.kind).toBe("ask");
    if (resolution.kind !== "ask") throw new Error("esperaba ask");
    expect(resolution.why).toContain("DEC-001 decide sobre parte");
    expect(resolution.why).toContain("deja el resto sin decidir");
  });

  it("dos notas vigentes que deciden partes distintas son ambiguas, y las nombra a las dos", () => {
    const first = note({ supersedes_assertions: ["S033/AC-01"] });
    const second = note({
      id: "DEC-002",
      supersedes_assertions: ["S033/AC-02"],
      decision: "otra cosa",
      date: "2026-08-17",
    });
    // Las dos componen: no se superponen sobre ninguna afirmación.
    const contract = contractOf([first, second]);
    expect(contract.applied).toEqual(["DEC-001", "DEC-002"]);

    const resolution = resolveDecision(
      { assertions: ["S033/AC-01", "S033/AC-02"], behaviors: TWO.behaviors },
      contract,
      [first, second],
    );

    expect(resolution.kind).toBe("ask");
    if (resolution.kind !== "ask") throw new Error("esperaba ask");
    expect(resolution.why).toContain("DEC-001 y DEC-002");
    expect(resolution.why).toContain("ninguna responde la pregunta entera");
  });

  it("una nota que NO está vigente en el contrato no se reusa aunque venga en la cadena", () => {
    const inForce = note({ supersedes_assertions: ["S033/AC-01"] });
    const stranger = note({
      id: "DEC-009",
      supersedes_assertions: ["S033/AC-01"],
      decision: "una decisión de otro contrato",
      date: "2026-08-17",
    });

    // El contrato sólo aplicó la primera; la cadena trae las dos.
    const contract = contractOf([inForce]);
    const resolution = resolveDecision(TWO, contract, [inForce, stranger]);

    expect(resolution.kind).toBe("reused");
    if (resolution.kind !== "reused") throw new Error("esperaba reused");
    expect(resolution.note).toBe("DEC-001");
  });
});

describe("resolveDecision — lo que ya no es una preferencia", () => {
  it("una pregunta sin afirmaciones no se puede componer y no llega a la persona", () => {
    const resolution = resolveDecision(
      { assertions: [], behaviors: TWO.behaviors },
      contractOf([]),
      [],
    );

    expect(resolution.kind).toBe("unresolvable");
    if (resolution.kind !== "unresolvable") throw new Error("esperaba unresolvable");
    expect(resolution.why).toContain("no nombra ninguna afirmación");
    expect(resolution.action).toContain("S033/AC-05");
  });

  it("cero conductas en pie escala: ofrecer un menú vacío no es preguntar", () => {
    const resolution = resolveDecision(
      { assertions: ["S033/AC-01"], behaviors: [] },
      contractOf([]),
      [],
    );

    expect(resolution.kind).toBe("unresolvable");
    if (resolution.kind !== "unresolvable") throw new Error("esperaba unresolvable");
    expect(resolution.why).toContain("descartó todas las conductas");
    expect(resolution.action).toContain("escalá con el paquete");
  });
});
