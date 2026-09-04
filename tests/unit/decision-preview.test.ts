// La vista previa muestra las ocho cosas y sella exactamente lo que muestra
// (T5.1 y T5.2 del plan 032, S033/AC-07).
//
// Lo que se comprueba acá no es el formato sino dos propiedades:
//
// 1. Todo lo que se ve está DERIVADO del contrato compuesto de F3 y de la nota
//    sellada. Una vista previa redactada al lado del cambio es una segunda
//    descripción del cambio, y en cuanto las dos discrepan la persona aprueba la
//    agradable. Acá, cambiar cualquier cosa material cambia el sello.
// 2. La autorización que produce la elección es el sello que se mostró y nada
//    más ancho — por construcción, porque `grantFor` la deriva de la propia
//    vista previa. Por eso no hay una segunda confirmación: no queda nada sobre
//    lo que pudiera preguntar.

import { describe, expect, it } from "vitest";
import { EFFECT_CLASSES } from "../../src/domain/capability/effects.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  computeNoteDigest,
} from "../../src/domain/decision-note.js";
import {
  DECISION_EFFECT_CLASSES,
  buildDecisionPreview,
  grantFor,
} from "../../src/domain/decision-preview.js";
import type { DecisionPreview } from "../../src/domain/decision-preview.js";
import {
  type BaselineInput,
  type EffectiveContract,
  composeEffectiveContract,
} from "../../src/domain/effective-contract.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { authorizeTransition } from "../../src/domain/flow/authorization.js";
import type { ProposalArtifact } from "../../src/domain/proposal.js";

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
const INDEX_PATH = "docs/decisions/033-decisions-x.json";

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
    supersedes_assertions: ["S033/AC-02"],
    supersedes_note: null,
    scope: "functional",
    consumers: [PLAN.path, "docs/plans/031-plan-y.md"],
    evidence_preserved: ["tests/unit/flow-authority.test.ts"],
    evidence_invalidated: ["tests/unit/deviation-gate.test.ts::salto"],
    obligations: [
      { text: "revalidar el recorrido PLAN completo", kind: "compensation", declared: true },
    ],
    resume_point: "F5/T5.1",
    date: "2026-08-16",
    ...over,
  };
  return { ...body, digest: computeNoteDigest(body) };
}

function contractOf(chain: readonly DecisionNote[]): EffectiveContract {
  const composed = composeEffectiveContract(BASELINE, chain);
  if (composed.status !== "composed") {
    throw new Error(`la cadena de prueba no compone: ${JSON.stringify(composed.failures)}`);
  }
  return composed.contract;
}

/** Los bytes reales que se publican: el índice CON la nota adentro. */
function indexBytes(...notes: readonly DecisionNote[]): string {
  return `${JSON.stringify({ schema: "workline.decision-index/v1", spec: SPEC, notes }, null, 2)}\n`;
}

const CONTENT = indexBytes(note());

function preview(
  over: {
    artifacts?: readonly ProposalArtifact[];
    subject?: DecisionNote;
    contract?: EffectiveContract;
  } = {},
): DecisionPreview {
  const subject = over.subject ?? note();
  const built = buildDecisionPreview({
    operation: "plan-exec.decision-registration",
    contract: over.contract ?? contractOf([subject]),
    note: subject,
    artifacts: over.artifacts ?? [
      { path: INDEX_PATH, content: indexBytes(subject), overwrite: false },
    ],
    bases: [
      { path: SPEC.path, digest: "sha256:aa" },
      { path: PLAN.path, digest: "sha256:bb" },
    ],
  });
  if (built.status !== "previewed") {
    throw new Error(`esperaba una vista previa: ${JSON.stringify(built.failures)}`);
  }
  return built.preview;
}

describe("buildDecisionPreview — las ocho cosas que la decisión necesita", () => {
  it("muestra las ocho, y cada una derivada del contrato o de la nota", () => {
    const subject = note();
    const view = preview({ subject });

    // 1 · sobre qué bytes se decide
    expect(view.baseline).toEqual(SPEC);
    // 2 · qué cambia el contrato, afirmación por afirmación
    expect(view.effective_change).toEqual([
      { assertion: "S033/AC-02", from: "baseline", to: "amended", by: "DEC-001" },
    ]);
    // 3 · a quién más alcanza
    expect(view.consumers).toEqual([PLAN.path, "docs/plans/031-plan-y.md"]);
    // 4 · hasta dónde llega
    expect(view.impact).toEqual({ scope: "functional", assertions: 1, consumers: 2 });
    // 5 · qué evidencia sobrevive y cuál deja de contar
    expect(view.evidence).toEqual({
      preserved: ["tests/unit/flow-authority.test.ts"],
      invalidated: ["tests/unit/deviation-gate.test.ts::salto"],
    });
    // 6 · qué trabajo nace
    expect(view.obligations).toEqual([
      { text: "revalidar el recorrido PLAN completo", kind: "compensation", declared: true },
    ]);
    // 7 · desde dónde sigue la ejecución
    expect(view.resume_point).toBe("F5/T5.1");
    // 8 · destino, peso y si reemplaza
    expect(view.effects.entries).toEqual([
      { path: INDEX_PATH, bytes: Buffer.byteLength(CONTENT, "utf8"), overwrite: false },
    ]);
    expect(view.effects.classes).toEqual(["local_additive"]);
    expect(subject.resume_point).toBe(view.resume_point);
  });

  it("un destino que ya existe se muestra como reemplazo y sube la clase de efecto", () => {
    const view = preview({
      artifacts: [{ path: INDEX_PATH, content: CONTENT, overwrite: true }],
    });

    expect(view.effects.entries[0]?.overwrite).toBe(true);
    expect(view.effects.classes).toEqual(["mutate_overwrite"]);
    // Reemplazar es lo único que no se auto-autoriza: es lo que se aprueba.
    expect(view.proposal.requires_approval).toEqual(["mutate_overwrite"]);
  });

  it("una afirmación que otra nota YA había enmendado no se presenta como si viniera del baseline", () => {
    const first = note({ supersedes_assertions: ["S033/AC-02"] });
    const second = note({
      id: "DEC-002",
      supersedes_note: "DEC-001",
      supersedes_assertions: ["S033/AC-02"],
      decision: "corrige la anterior",
      date: "2026-08-17",
    });
    // La cadena entera: DEC-001 queda sustituida, DEC-002 es la vigente.
    const contract = contractOf([first, second]);
    const view = preview({ subject: second, contract });

    expect(contract.applied).toEqual(["DEC-002"]);
    expect(view.effective_change).toEqual([
      { assertion: "S033/AC-02", from: "baseline", to: "amended", by: "DEC-002" },
    ]);
  });
});

describe("buildDecisionPreview — se bloquea antes que mostrar de menos", () => {
  it("rechaza una vista previa sin ningún destino", () => {
    const built = buildDecisionPreview({
      operation: "x",
      contract: contractOf([]),
      note: note(),
      artifacts: [],
      bases: [],
    });

    expect(built.status).toBe("blocked");
    if (built.status !== "blocked") throw new Error("esperaba blocked");
    expect(built.failures.map((f) => f.code)).toContain("PREVIEW_NO_ARTIFACTS");
  });

  it("rechaza previsualizar sobre un baseline distinto del que compuso el contrato", () => {
    const drifted = note({
      lineage: {
        spec: { ...SPEC, digest: `sha256:${"9".repeat(64)}` },
        plan: PLAN,
        execution: { session: "131-x", phase: "F5" },
      },
    });
    const built = buildDecisionPreview({
      operation: "x",
      contract: contractOf([]),
      note: drifted,
      artifacts: [{ path: INDEX_PATH, content: CONTENT, overwrite: false }],
      bases: [],
    });

    expect(built.status).toBe("blocked");
    if (built.status !== "blocked") throw new Error("esperaba blocked");
    expect(built.failures.map((f) => f.code)).toContain("PREVIEW_BASELINE_DRIFTED");
  });

  it("rechaza mostrar una nota que el contrato no aplicó", () => {
    const built = buildDecisionPreview({
      operation: "x",
      contract: contractOf([]),
      note: note(),
      artifacts: [{ path: INDEX_PATH, content: CONTENT, overwrite: false }],
      bases: [],
    });

    expect(built.status).toBe("blocked");
    if (built.status !== "blocked") throw new Error("esperaba blocked");
    const codes = built.failures.map((f) => f.code);
    expect(codes).toContain("PREVIEW_NOTE_NOT_COMPOSED");
  });

  it("rechaza sellar bytes que no contienen la nota que se está mostrando", () => {
    const subject = note();
    const built = buildDecisionPreview({
      operation: "x",
      contract: contractOf([subject]),
      note: subject,
      // Bytes plausibles, con el id adentro y sin el sello: seis de las ocho
      // secciones se leerían de un record que la propuesta no lleva.
      artifacts: [
        { path: INDEX_PATH, content: `{"notes":[{"id":"DEC-001"}]}\n`, overwrite: false },
      ],
      bases: [],
    });

    expect(built.status).toBe("blocked");
    if (built.status !== "blocked") throw new Error("esperaba blocked");
    expect(built.failures.map((f) => f.code)).toContain("PREVIEW_NOTE_NOT_SEALED");
  });

  it("cada bloqueo trae su acción correctiva, nunca sólo el diagnóstico", () => {
    const built = buildDecisionPreview({
      operation: "x",
      contract: contractOf([]),
      note: note(),
      artifacts: [],
      bases: [],
    });

    if (built.status !== "blocked") throw new Error("esperaba blocked");
    expect(built.failures.length).toBeGreaterThan(0);
    for (const failure of built.failures) {
      expect(failure.action.length).toBeGreaterThan(0);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });
});

describe("una decisión jamás cubre efectos destructivos ni de red externa", () => {
  it("el vocabulario de la vista previa deja fuera exactamente esas dos clases", () => {
    expect([...DECISION_EFFECT_CLASSES]).toEqual(["local_additive", "mutate_overwrite"]);
    expect(DECISION_EFFECT_CLASSES).not.toContain("destructive");
    expect(DECISION_EFFECT_CLASSES).not.toContain("network_external");
    // Y no por olvido: las otras dos del taxón tampoco están.
    const outside = EFFECT_CLASSES.filter((c) => !DECISION_EFFECT_CLASSES.includes(c));
    expect(outside).toEqual(["read_only", "execute", "network_external", "destructive"]);
  });

  it("ninguna combinación de artefactos alcanza una clase prohibida: sólo crea o reemplaza", () => {
    for (const overwrite of [true, false]) {
      const view = preview({ artifacts: [{ path: INDEX_PATH, content: CONTENT, overwrite }] });
      for (const cls of view.effects.classes) {
        expect(DECISION_EFFECT_CLASSES).toContain(cls);
      }
      for (const cls of view.proposal.requires_approval) {
        expect(cls).not.toBe("destructive");
        expect(cls).not.toBe("network_external");
      }
    }
  });
});

describe("grantFor — una sola autorización, sobre el sello que se mostró", () => {
  const row = (id: string): FlowDecision =>
    ({ id, authority: "human", effects: ["mutate_overwrite"] }) as unknown as FlowDecision;

  it("la elección autoriza exactamente los efectos previsualizados y nada más ancho", () => {
    const view = preview({ artifacts: [{ path: INDEX_PATH, content: CONTENT, overwrite: true }] });
    const grant = grantFor(view);

    expect(grant.digest).toBe(view.proposal.digest);
    expect(grant.destinations).toEqual([INDEX_PATH]);
    expect(grant.classes).toEqual(view.proposal.requires_approval);
  });

  it("no aparece una segunda confirmación: con ese permiso la frontera no pide nada más", () => {
    const view = preview({ artifacts: [{ path: INDEX_PATH, content: CONTENT, overwrite: true }] });
    const verdict = authorizeTransition(row("plan-exec.decision-registration"), [grantFor(view)], {
      digest: view.proposal.digest,
      scope: view.proposal.scope,
      effects: view.proposal.effects,
    });

    expect(verdict.missing).toEqual([]);
    expect(verdict.seal).toBe(view.proposal.digest);
    expect(verdict.covered).toContain("mutate_overwrite");
  });

  it("ese permiso NO alcanza a otros bytes: el sello de otra propuesta queda sin cubrir", () => {
    const shown = preview({ artifacts: [{ path: INDEX_PATH, content: CONTENT, overwrite: true }] });
    const other = preview({
      artifacts: [{ path: INDEX_PATH, content: `${CONTENT}otra cosa\n`, overwrite: true }],
    });

    expect(other.proposal.digest).not.toBe(shown.proposal.digest);
    const verdict = authorizeTransition(row("plan-exec.decision-registration"), [grantFor(shown)], {
      digest: other.proposal.digest,
      scope: other.proposal.scope,
      effects: other.proposal.effects,
    });

    expect(verdict.missing).toEqual(["mutate_overwrite"]);
  });

  it("un cambio material en cualquiera de las ocho cosas produce un sello distinto", () => {
    const base = preview();
    const otherResume = preview({ subject: note({ resume_point: "F6/T6.1" }) });
    const otherObligations = preview({
      subject: note({
        obligations: [{ text: "otra obligación", kind: "compensation", declared: true }],
      }),
    });
    const otherDestination = preview({
      artifacts: [{ path: "docs/decisions/otro.json", content: CONTENT, overwrite: false }],
    });

    const seals = [base, otherResume, otherObligations, otherDestination].map(
      (v) => v.proposal.digest,
    );
    expect(new Set(seals).size).toBe(4);
  });
});
