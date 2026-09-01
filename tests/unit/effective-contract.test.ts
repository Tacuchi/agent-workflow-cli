// El contrato efectivo se compone o se bloquea, nunca se adivina (F3 del plan 032).
//
// Una nota que compone mal es peor que ninguna: si la composición admitiera una
// superposición sin referencia explícita, dos lecturas distintas del mismo
// contrato convivirían en silencio, cada una internamente coherente y una de
// ellas equivocada. Por eso bloquea antes que resolver por precedencia
// implícita — «gana la más nueva» sería una respuesta inventada.
//
// Validación de fase de F3: pruebas de propiedades y adversariales — permutar el
// orden de notas independientes converge al mismo contrato; superposición,
// ausencia y contradicción producen su bloqueo y su acción correctiva; y un
// barrido verifica que no queda ninguna otra ruta que derive un contrato
// efectivo por su cuenta.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  computeNoteDigest,
} from "../../src/domain/decision-note.js";
import {
  type BaselineInput,
  composeEffectiveContract,
} from "../../src/domain/effective-contract.js";

const SPEC_DIGEST = `sha256:${"1".repeat(64)}`;
const SPEC = { path: "docs/specs/033-spec-x.md", number: "033", digest: SPEC_DIGEST };
const PLAN = {
  path: "docs/plans/032-plan-x.md",
  number: "032",
  digest: `sha256:${"2".repeat(64)}`,
};

const BASELINE: BaselineInput = {
  ...SPEC,
  criteria: ["S033/AC-01", "S033/AC-02", "S033/AC-03", "S033/AC-04"],
};

function note(over: Partial<DecisionNote> = {}): DecisionNote {
  const body: Omit<DecisionNote, "digest"> = {
    schema: NOTE_SCHEMA,
    id: "DEC-001",
    lineage: { spec: SPEC, plan: PLAN, execution: { session: "131-x", phase: "F4" } },
    decision: "compone",
    reason: "el linaje funcional se conserva",
    supersedes_assertions: [],
    supersedes_note: null,
    scope: "plan-only",
    consumers: [PLAN.path],
    evidence_preserved: [],
    evidence_invalidated: [],
    obligations: [],
    resume_point: "F4/T4.1",
    date: "2026-08-16",
    ...over,
  };
  return { ...body, digest: computeNoteDigest(body) };
}

/** Todas las permutaciones de una lista corta. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i] as T, ...tail]);
  }
  return out;
}

describe("F3 — propiedad: el orden de llegada no cambia el contrato", () => {
  const a = note({
    id: "DEC-001",
    supersedes_assertions: ["S033/AC-01"],
    obligations: ["o1"],
    date: "2026-08-10",
  });
  const b = note({
    id: "DEC-002",
    supersedes_assertions: ["S033/AC-02"],
    obligations: ["o2"],
    date: "2026-08-11",
  });
  const c = note({
    id: "DEC-003",
    supersedes_assertions: ["S033/AC-03"],
    obligations: ["o3"],
    date: "2026-08-12",
  });

  it("las 6 permutaciones de 3 notas independientes convergen al mismo contrato", () => {
    const results = permutations([a, b, c]).map((chain) =>
      JSON.stringify(composeEffectiveContract(BASELINE, chain)),
    );
    expect(new Set(results).size).toBe(1);
  });

  it("y ese contrato aplica las tres en orden de fecha, no de llegada", () => {
    const composed = composeEffectiveContract(BASELINE, [c, a, b]);
    expect(composed.status).toBe("composed");
    if (composed.status !== "composed") return;
    expect(composed.contract.applied).toEqual(["DEC-001", "DEC-002", "DEC-003"]);
    expect(composed.contract.obligations).toEqual([
      { text: "o1", by: "DEC-001" },
      { text: "o2", by: "DEC-002" },
      { text: "o3", by: "DEC-003" },
    ]);
  });

  it("una afirmación sin nota queda `baseline`; una con nota queda `amended` con su causa", () => {
    const composed = composeEffectiveContract(BASELINE, [a]);
    expect(composed.status).toBe("composed");
    if (composed.status !== "composed") return;
    expect(composed.contract.assertions).toEqual([
      { id: "S033/AC-01", state: "amended", by: "DEC-001" },
      { id: "S033/AC-02", state: "baseline", by: null },
      { id: "S033/AC-03", state: "baseline", by: null },
      { id: "S033/AC-04", state: "baseline", by: null },
    ]);
  });

  it("sin notas, el contrato es el baseline y nada más", () => {
    const composed = composeEffectiveContract(BASELINE, []);
    expect(composed.status).toBe("composed");
    if (composed.status !== "composed") return;
    expect(composed.contract.applied).toEqual([]);
    expect(composed.contract.assertions.every((x) => x.state === "baseline")).toBe(true);
  });
});

describe("F3 — adversarial: superposición", () => {
  const first = note({ id: "DEC-001", supersedes_assertions: ["S033/AC-01"], date: "2026-08-10" });
  const second = note({ id: "DEC-002", supersedes_assertions: ["S033/AC-01"], date: "2026-08-11" });

  it("dos notas vigentes sobre la misma afirmación BLOQUEAN, no gana la más nueva", () => {
    const composed = composeEffectiveContract(BASELINE, [first, second]);
    expect(composed.status).toBe("blocked");
    if (composed.status !== "blocked") return;
    expect(composed.failures.map((f) => f.code)).toContain("CONTRACT_OVERLAP");
    expect(composed.failures[0]?.action).toContain("sustituya explícitamente a DEC-001");
  });

  it("bloquea en las dos permutaciones: no es un artefacto del orden de llegada", () => {
    for (const chain of [
      [first, second],
      [second, first],
    ]) {
      expect(composeEffectiveContract(BASELINE, chain).status).toBe("blocked");
    }
  });

  it("con la referencia explícita compone, y sólo la sustituta queda vigente", () => {
    const fixed = note({
      id: "DEC-002",
      supersedes_assertions: ["S033/AC-01"],
      supersedes_note: "DEC-001",
      date: "2026-08-11",
    });
    const composed = composeEffectiveContract(BASELINE, [first, fixed]);
    expect(composed.status).toBe("composed");
    if (composed.status !== "composed") return;
    expect(composed.contract.applied).toEqual(["DEC-002"]);
    expect(composed.contract.assertions[0]).toEqual({
      id: "S033/AC-01",
      state: "amended",
      by: "DEC-002",
    });
  });
});

describe("F3 — adversarial: ausencia", () => {
  it("una nota que sustituye una afirmación que la spec no enuncia bloquea", () => {
    const ghost = note({ supersedes_assertions: ["S033/AC-99"] });
    const composed = composeEffectiveContract(BASELINE, [ghost]);
    expect(composed.status).toBe("blocked");
    if (composed.status !== "blocked") return;
    expect(composed.failures[0]?.code).toBe("CONTRACT_ASSERTION_ABSENT");
    expect(composed.failures[0]?.action).toContain(SPEC.path);
  });

  it("una nota sellada contra otros bytes de la spec bloquea: decidió en otro lado", () => {
    const stale = note({
      lineage: {
        spec: { ...SPEC, digest: `sha256:${"9".repeat(64)}` },
        plan: PLAN,
        execution: { session: "131-x", phase: "F4" },
      },
    });
    const composed = composeEffectiveContract(BASELINE, [stale]);
    expect(composed.status).toBe("blocked");
    if (composed.status !== "blocked") return;
    expect(composed.failures[0]?.code).toBe("CONTRACT_BASELINE_ABSENT");
  });

  it("una nota pineada al digest LEGADO compone mientras la spec no se mueva", () => {
    // Toda nota publicada ANTES del payload funcional pineó los bytes exactos de
    // la spec, porque era lo que el baseline significaba entonces. Sin esta
    // lectura dual, el `CONTRACT_BASELINE_ABSENT` de arriba cae sobre una spec
    // que NADIE tocó, y de ahí no hay salida dentro del producto: la nota
    // sustituta que el mensaje pide no se puede preparar (esta misma composición
    // corre primero), editar el JSON a mano rompe el sello de la nota, y
    // «volvé la spec a su baseline sellado» nombra una edición que no existió.
    const legacy = `sha256:${"a".repeat(64)}`;
    const pinned = note({
      supersedes_assertions: ["S033/AC-01"],
      lineage: {
        spec: { ...SPEC, digest: legacy },
        plan: PLAN,
        execution: { session: "131-x", phase: "F4" },
      },
    });
    const composed = composeEffectiveContract({ ...BASELINE, legacy_digest: legacy }, [pinned]);

    expect(composed.status).toBe("composed");
    if (composed.status !== "composed") return;
    expect(composed.contract.applied).toEqual(["DEC-001"]);
    expect(composed.contract.assertions[0]).toEqual({
      id: "S033/AC-01",
      state: "amended",
      by: "DEC-001",
    });
    // Y el contrato sigue reportando el digest VIGENTE, no el que la nota pineó.
    expect(composed.contract.spec.digest).toBe(SPEC_DIGEST);
  });

  it("pero el legado de ENTONCES no vale: la tolerancia dura lo que la spec intacta", () => {
    const pinned = note({
      lineage: {
        spec: { ...SPEC, digest: `sha256:${"a".repeat(64)}` },
        plan: PLAN,
        execution: { session: "131-x", phase: "F4" },
      },
    });
    // `legacy_digest` son los bytes de la spec COMO SE LEE HOY: si cambiaron, la
    // nota decidió sobre otro documento y eso sigue siendo un bloqueo.
    const composed = composeEffectiveContract(
      { ...BASELINE, legacy_digest: `sha256:${"b".repeat(64)}` },
      [pinned],
    );

    expect(composed.status).toBe("blocked");
    if (composed.status !== "blocked") return;
    expect(composed.failures[0]?.code).toBe("CONTRACT_BASELINE_ABSENT");
  });

  it("todo bloqueo trae su acción correctiva, nunca sólo su queja", () => {
    const composed = composeEffectiveContract(BASELINE, [
      note({ supersedes_assertions: ["S033/AC-99"] }),
    ]);
    if (composed.status !== "blocked") throw new Error("esperaba bloqueo");
    expect(composed.failures.every((f) => f.action.trim().length > 0)).toBe(true);
  });
});

describe("F3 — adversarial: contradicción", () => {
  it("una nota que conserva e invalida la misma evidencia bloquea", () => {
    const selfContradictory = note({
      evidence_preserved: ["tests/unit/x.test.ts"],
      evidence_invalidated: ["tests/unit/x.test.ts"],
    });
    const composed = composeEffectiveContract(BASELINE, [selfContradictory]);
    expect(composed.status).toBe("blocked");
    if (composed.status !== "blocked") return;
    expect(composed.failures[0]?.code).toBe("CONTRACT_CONTRADICTION");
  });

  it("dos notas vigentes que discrepan sobre la misma evidencia bloquean, nombrando ambas", () => {
    const keeper = note({
      id: "DEC-001",
      evidence_preserved: ["tests/unit/x.test.ts"],
      date: "2026-08-10",
    });
    const dropper = note({
      id: "DEC-002",
      evidence_invalidated: ["tests/unit/x.test.ts"],
      date: "2026-08-11",
    });
    const composed = composeEffectiveContract(BASELINE, [keeper, dropper]);
    expect(composed.status).toBe("blocked");
    if (composed.status !== "blocked") return;
    const failure = composed.failures.find((f) => f.code === "CONTRACT_CONTRADICTION");
    expect(failure?.message).toContain("DEC-001");
    expect(failure?.message).toContain("DEC-002");
  });

  it("una nota sustituida ya no contradice: sale de las vigentes", () => {
    const keeper = note({
      id: "DEC-001",
      evidence_preserved: ["tests/unit/x.test.ts"],
      date: "2026-08-10",
    });
    const dropper = note({
      id: "DEC-002",
      supersedes_note: "DEC-001",
      evidence_invalidated: ["tests/unit/x.test.ts"],
      date: "2026-08-11",
    });
    const composed = composeEffectiveContract(BASELINE, [keeper, dropper]);
    expect(composed.status).toBe("composed");
    if (composed.status !== "composed") return;
    expect(composed.contract.evidence_invalidated).toEqual(["tests/unit/x.test.ts"]);
    expect(composed.contract.evidence_preserved).toEqual([]);
  });
});

describe("F3 — barrido: una sola función deriva el contrato efectivo", () => {
  const SRC = join(process.cwd(), "src");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("nadie llama a `effectiveNotes` fuera de la composición y del módulo que la define", () => {
    const callers = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /\beffectiveNotes\s*\(/.test(text);
    });
    // Sólo el módulo que la exporta y el que compone: cualquier tercero estaría
    // derivando su propia lectura de las notas vigentes.
    expect(
      callers
        .map((f) =>
          f
            .slice(SRC.length + 1)
            .split("\\")
            .join("/"),
        )
        .sort(),
    ).toEqual(["domain/decision-note.ts", "domain/effective-contract.ts"]);
  });

  it("nadie compone un contrato salvo llamando a `composeEffectiveContract`", () => {
    const definers = sourceFiles(SRC).filter((file) =>
      /function\s+composeEffectiveContract\b/.test(readFileSync(file, "utf8")),
    );
    expect(definers).toHaveLength(1);
  });
});
