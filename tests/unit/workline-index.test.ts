import { describe, expect, it } from "vitest";
import { noteIndexPath, sealNote } from "../../src/application/decision-note-service.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { parseSpecRelation } from "../../src/application/parsers/spec-relation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { type DecisionNote, NOTE_SCHEMA } from "../../src/domain/decision-note.js";
import {
  FLOW_RUN_STATE_FILE,
  newRunState,
  serializeRunState,
  withScope,
} from "../../src/domain/flow/run-state.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";
import {
  OWING_PLAN,
  OWING_TEXT,
  seedExecutedPlanOwingCompensation,
} from "../helpers/plan-obligation-fixtures.js";

const fakeEnv = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 6, 29, 12, 0, 0);

function paths(): PathsService {
  return new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
}

function index(fs: MemFs) {
  return buildWorklineIndex(fs, fakeEnv, paths(), { now: NOW });
}

// ── spec→plan evidence ───────────────────────────────────────────────────────

describe("parseSpecRelation — level 1: the Derived from header", () => {
  it("reads the spec number out of the header blockquote", () => {
    const plan =
      "# Plan 009 — x\n\n> Derived from docs/specs/012-spec-x.md\n\n## Origin\n\n- nada\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "012",
      evidence: "derived-from",
    });
  });

  it("tolerates the backticked path older plans wrote", () => {
    const plan =
      "# Plan 001\n\n> Derived from `docs/specs/002-spec-retomar.md`\n\n## Origin\n\n- x\n";
    expect(parseSpecRelation(plan)).toMatchObject({ status: "declared", number: "002" });
  });

  it("ignores a Derived from that appears in the body, not the header", () => {
    const plan =
      "# Plan 004\n\n## Origin\n\n- nada\n\n## Notes\n\nDerived from docs/specs/007-spec-y.md\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });
});

describe("parseSpecRelation — level 2: an explicit path inside ## Origin", () => {
  it("resolves when the header carries no Derived from", () => {
    const plan = "# Plan 002\n\n## Origin\n\n- Spec: docs/specs/003-spec-minimality.md\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "003",
      evidence: "origin-path",
    });
  });

  it("never outranks the header declaration", () => {
    const plan =
      "# Plan 009\n\n> Derived from docs/specs/012-spec-x.md\n\n## Origin\n\n- ver docs/specs/003-spec-otra.md\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "012",
      evidence: "derived-from",
    });
  });
});

describe("parseSpecRelation — level 3: a Spec NNN reference inside ## Origin", () => {
  it("accepts an unambiguous reference as the weakest evidence", () => {
    const plan =
      "# Plan 008\n\n## Origin\n\nSpec 011 (`ready-for-plan`), refinada en la sesión 047.\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "011",
      evidence: "spec-reference",
    });
  });

  // The scoping that matters: plans routinely name sibling specs under
  // `## Dependencies` ("la spec 009 consumirá…"). That is not provenance.
  it("ignores a spec named outside ## Origin", () => {
    const plan =
      "# Plan 009\n\n## Origin\n\n- planificado a mano\n\n## Dependencies\n\n- la spec 009 consumirá esto\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });

  it("does not read a bare number as a spec reference", () => {
    const plan = "# Plan 009\n\n## Origin\n\nRefinada en la sesión 047, baseline 044.\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });
});

describe("parseSpecRelation — contradictions and silence", () => {
  it("reports ambiguous when the header names two different specs", () => {
    const plan =
      "# Plan\n\n> Derived from docs/specs/003-spec-a.md and docs/specs/004-spec-b.md\n\n## Origin\n\n- x\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "ambiguous",
      numbers: ["003", "004"],
      evidence: "derived-from",
    });
  });

  it("reports ambiguous when ## Origin names two different spec paths", () => {
    const plan = "# Plan\n\n## Origin\n\n- docs/specs/003-spec-a.md\n- docs/specs/009-spec-b.md\n";
    expect(parseSpecRelation(plan)).toMatchObject({ status: "ambiguous", evidence: "origin-path" });
  });

  it("collapses the same spec named twice into one declaration", () => {
    const plan =
      "# Plan\n\n## Origin\n\n- docs/specs/003-spec-a.md\n- otra vez docs/specs/003-spec-a.md\n";
    expect(parseSpecRelation(plan)).toMatchObject({ status: "declared", number: "003" });
  });

  // The whole reason this parser exists: the old association matched by slug.
  it("never infers a relation from a matching slug", () => {
    const plan = "# Plan foo\n\n## Origin\n\n- trabajo sobre foo\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });
});

// ── the index ────────────────────────────────────────────────────────────────

function workspace(): MemFs {
  const fs = new MemFs();
  fs.file("/cwd/.workflow/sessions/.keep", "");
  return fs;
}

const READY = "---\nstatus: ready-for-plan\n---\n\n# Spec\n";
const DRAFT = "---\nstatus: draft\n---\n\n# Spec\n";

describe("buildWorklineIndex — the spec→plan relation drives what is unplanned", () => {
  it("does not fall back to literal docs paths when [docs] is invalid", async () => {
    const fs = workspace();
    fs.file("/cwd/.workflow/skills.toml", '[docs]\nplan = "knowledge/plans"\n');
    fs.file("/cwd/docs/specs/001-spec-a.md", READY);
    fs.file("/cwd/docs/plans/001-plan-a.md", "# Plan\n\n## Tasks\n- [ ] T1\n");

    const out = await index(fs);
    expect(out.docs_canon_error).toContain("todavía no admite un destino personalizado");
    expect(out.specs).toEqual([]);
    expect(out.plans).toEqual([]);
  });

  it("drops a spec from the pipeline once a plan proves it derives from it", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n> Derived from docs/specs/003-spec-a.md\n\n## Tasks\n- [x] T1\n",
    );
    const out = await index(fs);

    expect(out.plans[0]?.spec).toEqual({
      status: "resolved",
      number: "003",
      file: "docs/specs/003-spec-a.md",
      evidence: "derived-from",
    });
    expect(out.pipeline).toEqual([]);
  });

  it("keeps the spec pending when the plan proves nothing", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);
    fs.file("/cwd/docs/plans/001-plan-a.md", "# Plan\n\n> Estado: done\n\n## Tasks\n- [x] T1\n");
    const out = await index(fs);

    expect(out.plans[0]?.spec).toEqual({ status: "unknown", reason: "no-evidence" });
    expect(out.pipeline.map((p) => p.kind)).toEqual(["spec-unplanned"]);
  });

  it("keeps the spec pending when the plan's evidence is ambiguous", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);
    fs.file("/cwd/docs/specs/004-spec-b.md", READY);
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n\n## Origin\n\n- docs/specs/003-spec-a.md\n- docs/specs/004-spec-b.md\n\n## Tasks\n- [x] T1\n",
    );
    const out = await index(fs);

    expect(out.plans[0]?.spec).toMatchObject({ status: "ambiguous" });
    expect(out.pipeline.map((p) => p.number)).toEqual(["003", "004"]);
  });

  it("reports spec-not-found when the declared spec is not in the workspace", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n> Derived from docs/specs/099-spec-ghost.md\n\n## Tasks\n- [x] T1\n",
    );
    const out = await index(fs);
    expect(out.plans[0]?.spec).toEqual({ status: "unknown", reason: "spec-not-found" });
  });
});

describe("buildWorklineIndex — pipeline order", () => {
  // La cuarta clase salió del pipeline de trabajo del usuario: la mecánica de
  // sesión la maneja el workline central, así que un checkpoint suelto se reporta
  // como aviso y deja de competir con un plan abierto por la atención de alguien.
  it("ranks unrefined spec → unplanned spec → open plan, y la sesión suelta va al aviso", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-draft.md", DRAFT);
    fs.file("/cwd/docs/specs/002-spec-ready.md", READY);
    fs.file("/cwd/docs/plans/005-plan-open.md", "# Plan\n\n## Tasks\n- [ ] T1\n");
    fs.file(
      "/cwd/.workflow/sessions/010-suelta-quick/SESSION.md",
      "# SESSION\n\n## Objective\nalgo suelto\n\n## Origin\n- prompt directo\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/010-suelta-quick/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- x\n",
    );

    const out = await index(fs);
    expect(out.pipeline.map((p) => p.kind)).toEqual([
      "spec-unrefined",
      "spec-unplanned",
      "plan-open",
    ]);
    expect(out.loose_sessions).toEqual(["010-suelta-quick"]);
  });

  it("puts a started plan ahead of an untouched one", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/plans/002-plan-untouched.md", "# Plan\n\n## Tasks\n- [ ] T1\n- [ ] T2\n");
    fs.file("/cwd/docs/plans/008-plan-started.md", "# Plan\n\n## Tasks\n- [x] T1\n- [ ] T2\n");

    const out = await index(fs);
    // 008 outranks 002 despite the higher number: progress beats numbering.
    expect(out.pipeline.map((p) => p.number)).toEqual(["008", "002"]);
    expect(out.pipeline[0]?.started).toBe(true);
  });

  it("leaves same-priority candidates tied instead of breaking by date", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-vieja.md", DRAFT, new Date(2020, 0, 1));
    fs.file("/cwd/docs/specs/002-spec-nueva.md", DRAFT, new Date(2026, 6, 28));

    const out = await index(fs);
    expect(out.pipeline).toHaveLength(2);
    expect(new Set(out.pipeline.map((p) => p.priority))).toEqual(new Set([1]));
  });

  it("excludes a done plan and keeps an inconsistent one", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/plans/001-plan-done.md", "# Plan\n\n> Estado: done\n\n## Tasks\n- [x] T1\n");
    fs.file(
      "/cwd/docs/plans/002-plan-inconsistent.md",
      "# Plan\n\n> Estado: done\n\n## Tasks\n- [x] T1\n- [ ] T2\n",
    );

    const out = await index(fs);
    expect(out.plans.map((p) => p.plan_state)).toEqual(["done", "inconsistent"]);
    expect(out.pipeline.map((p) => p.number)).toEqual(["002"]);
  });

  it("does not treat a session whose Origin names a doc as an orphan checkpoint", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/.workflow/sessions/011-x-plan-exec/SESSION.md",
      "# SESSION\n\n## Objective\nejecutar\n\n## Origin\n- docs/plans/005-plan-open.md\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/011-x-plan-exec/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- x\n",
    );

    const out = await index(fs);
    expect(out.sessions[0]?.linked_doc).toBe("docs/plans/005-plan-open.md");
    expect(out.pipeline).toEqual([]);
  });

  it("ignores a closed session even when it holds a checkpoint", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/.workflow/sessions/012-cerrada-quick/SESSION.md",
      "# SESSION\n\n## Objective\nx\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/012-cerrada-quick/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- x\n",
    );
    fs.file("/cwd/.workflow/sessions/012-cerrada-quick/.closed", "");

    const out = await index(fs);
    expect(out.pipeline).toEqual([]);
  });
});

// ── per-item detail: derived once, in one order ──────────────────────────────

/**
 * The precedence a pending item's `next` follows, one case per link.
 *
 * The chain used to live in `resume-service`, which computed it for the head of
 * the pipeline and its ties only — so `status`, which lists them all, said
 * nothing. Moving it here is the point of the change, and its order is the part
 * that must survive the move: a plan holding both a blocked phase and a pending
 * reconciliation still reports the blocked phase, and one whose baseline nobody
 * can prove is never told to "continue with the first unvalidated phase".
 */

const D_SPEC = "docs/specs/033-spec-detalle.md";
const D_PLAN = "docs/plans/032-plan-detalle.md";

const D_SPEC_TEXT = [
  "---",
  "status: ready-for-plan",
  "---",
  "",
  "# Spec 033 — detalle",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] S033/AC-01 — una.",
  "- [ ] S033/AC-02 — otra.",
  "",
].join("\n");

const D_DIGEST = `sha256:${baseDigest(D_SPEC_TEXT)}`;

/** A plan over two phases, with whatever header lines and phase states the case needs. */
function detailPlan(
  options: {
    header?: readonly string[];
    f1?: string;
    f2?: string;
    design?: boolean;
  } = {},
): string {
  const lines = [
    "# Plan 032 — detalle",
    "",
    `> Derived from ${D_SPEC}`,
    ...(options.header ?? [`> Baseline: ${D_SPEC}@${D_DIGEST}`, "> Estado: open"]),
    "> Límite de ejecución: checkout",
    "",
  ];
  if (options.design === true) {
    lines.push(
      "## Design references",
      "",
      "- package: `DES-001@r2`",
      "  baseline_hint: `docs/designs/999-design-inexistente`",
      `  digest: \`sha256:${"2".repeat(64)}\``,
      "",
    );
  }
  lines.push(
    "## Tasks",
    "",
    "### F1 — la primera",
    `> Estado: ${options.f1 ?? "validada"}`,
    ...(options.f1 === "bloqueada" ? ["> Bloqueo: falta aplicar la migración 014"] : []),
    "",
    "- [x] T1.1 — hecho _(fuentes: workspace)_",
    "",
    "### F2 — la segunda",
    `> Estado: ${options.f2 ?? "pendiente"}`,
    "",
    `- [${options.f2 === "validada" ? "x" : " "}] T2.1 — queda _(fuentes: workspace)_`,
    "",
  );
  return lines.join("\n");
}

/** The workspace of a single spec and a single plan, plus optional extra files. */
function detailWorkspace(planText: string, specText = D_SPEC_TEXT): MemFs {
  const fs = new MemFs({ lenient: true });
  fs.file("/cwd/.workflow/sessions/.keep", "");
  fs.file(`/cwd/${D_SPEC}`, specText);
  fs.file(`/cwd/${D_PLAN}`, planText);
  return fs;
}

/** The pending note chain the reconciliation link needs, written where the index reads it. */
function seedObligation(fs: MemFs, planText: string): void {
  const chain = {
    schema: "workline.decision-index/v1" as const,
    spec: { path: D_SPEC, number: "033" },
    notes: [] as DecisionNote[],
  };
  const note = sealNote(chain, {
    schema: NOTE_SCHEMA,
    lineage: {
      // Una nota pinea el digest FUNCIONAL, que es el que el tablero reporta
      // para un plan alineado — incluso cuando su sello es el legado exacto.
      spec: { path: D_SPEC, number: "033", digest: functionalSpecDigest(D_SPEC_TEXT) },
      plan: { path: D_PLAN, number: "032", digest: `sha256:${baseDigest(planText)}` },
      execution: { session: "134-x", phase: "F1" },
    },
    decision: "F1 ya no satisface el contrato",
    reason: "la afirmación que probaba cambió",
    supersedes_assertions: ["S033/AC-01"],
    supersedes_note: null,
    scope: "functional",
    consumers: [D_PLAN],
    evidence_preserved: ["F1/T1.1 como historia"],
    evidence_invalidated: ["F1/T1.1 como prueba"],
    obligations: [{ text: "revalidar F1", kind: "compensation", declared: true }],
    resume_point: "F1/T1.1",
    date: "2026-07-29",
  });
  fs.file(
    `/cwd/${noteIndexPath("docs/decisions", "033", "detalle")}`,
    JSON.stringify({ ...chain, notes: [note] }),
  );
}

/** The detail of the plan item, which is the only pending item in these fixtures. */
async function planItem(fs: MemFs) {
  const out = await index(fs);
  const item = out.pipeline.find((p) => p.file === D_PLAN);
  if (item === undefined)
    throw new Error(`el plan no está en el pipeline: ${JSON.stringify(out.pipeline)}`);
  return item;
}

describe("derivePipeline — cada eslabón de la precedencia, en su orden", () => {
  it("1 · un diseño irresoluble gana a todo lo demás, y es obligación", async () => {
    const item = await planItem(detailWorkspace(detailPlan({ design: true, f1: "bloqueada" })));
    expect(item.detail.next).toContain("DISEÑO IRRESOLUBLE DES-001@r2");
    expect(item.detail.obligation).toBe(true);
  });

  it("2 · una fase bloqueada gana a la reconciliación pendiente y bloquea el route", async () => {
    const text = detailPlan({ f1: "bloqueada" });
    const fs = detailWorkspace(text);
    seedObligation(fs, text);

    const item = await planItem(fs);
    expect(item.detail.next).toBe("BLOQUEADA F1 — falta aplicar la migración 014");
    expect(item.detail.obligation).toBe(true);
    expect(item.action).toMatchObject({
      kind: "blocked",
      command: null,
      code: "WORKLINE_PLAN_PHASE_BLOCKED",
    });
  });

  it("2b · una fase bloqueada sin motivo declarado lo dice así", async () => {
    const text = detailPlan({ f1: "bloqueada" }).replace(
      "> Bloqueo: falta aplicar la migración 014\n",
      "",
    );
    const item = await planItem(detailWorkspace(text));
    expect(item.detail.next).toBe("BLOQUEADA F1 — sin motivo declarado");
  });

  it("3 · la reconciliación pendiente gana al plan inconsistente, con salida ejecutable", async () => {
    // `done` con una fase pendiente es justo lo que hace `inconsistent`: si la
    // obligación no ganara, el tablero mandaría a reparar un plan que no está roto.
    const text = detailPlan({ header: [`> Baseline: ${D_SPEC}@${D_DIGEST}`, "> Estado: done"] });
    const fs = detailWorkspace(text);
    seedObligation(fs, text);

    const item = await planItem(fs);
    expect(item.detail.next).toContain("COMPENSACIÓN VIGENTE por DEC-001 — revalidar F1");
    // El punto es el del plan HOY. La nota dijo F1/T1.1 y F1 está validada: ese
    // punto queda en el detalle de la obligación y no se ofrece como destino.
    expect(item.detail.next).toContain("retomá en F2 — la segunda");
    expect(item.detail.next).not.toContain("F1/T1.1");
    expect(item.detail.obligation).toBe(true);
    // Y nunca `command: null` por reconciliación: sin corrida abierta sobre el
    // plan, la salida es el comando que lo salda.
    expect(item.action).toEqual({
      kind: "continue",
      command: `aw settle prepare ${D_PLAN}`,
      mode: "settlement",
    });
    expect(item.command).toBe(`aw settle prepare ${D_PLAN}`);
  });

  it("4 · un legacy inconsistente sigue ejecutable en modo compatible, sin afirmar baseline", async () => {
    const item = await planItem(detailWorkspace(detailPlan({ header: ["> Estado: done"] })));
    expect(item.detail.next).toBe(
      "el plan se declara done pero sus contadores no lo respaldan: reconciliar las tareas y fases acreditadas desde plan-exec",
    );
    expect(item.detail.obligation).toBe(false);
    expect(item.detail.warning?.code).toBe("WORKLINE_BASELINE_LEGACY_UNSEALED");
    expect(item.action).toEqual({
      kind: "continue",
      command: `/w:plan-exec ${D_PLAN}`,
      mode: "compatible",
    });
  });

  it("5 · un baseline sin sello es warning de compatibilidad, no bloqueo", async () => {
    const item = await planItem(
      detailWorkspace(detailPlan({ header: ["> Estado: open"], f2: "validada" })),
    );
    expect(item.detail.next).toBe("todo ejecutado: falta la validación final y el cierre");
    expect(item.detail.obligation).toBe(false);
    expect(item.detail.warning?.message).toContain("SIN SELLO DE BASELINE");
    expect(item.action).toMatchObject({ kind: "continue", mode: "compatible" });
  });

  it("5b · un baseline divergente entrega exactamente a plan-refine", async () => {
    const item = await planItem(detailWorkspace(detailPlan(), D_SPEC_TEXT.replace("una.", "una,")));
    expect(item.detail.next).toContain("BASELINE DIVERGENTE");
    expect(item.detail.obligation).toBe(true);
    expect(item.action).toEqual({
      kind: "handoff",
      command: `/w:plan-refine ${D_PLAN}`,
      destination: "plan-refine",
      code: "WORKLINE_BASELINE_DIVERGENT",
    });
  });

  it("5c · baseline malformado o spec ausente siempre bloquean, incluso si el plan es inconsistente", async () => {
    const malformed = await planItem(
      detailWorkspace(
        detailPlan({
          header: [`> Baseline: ${D_SPEC}@no-es-un-sello`, "> Estado: done"],
        }),
      ),
    );
    expect(malformed.action).toMatchObject({
      kind: "blocked",
      command: null,
      code: "WORKLINE_BASELINE_MALFORMED",
    });

    const missingSpec = await planItem(
      detailWorkspace(
        detailPlan({
          header: [
            "> Derived from docs/specs/999-spec-ausente.md",
            "> Baseline: docs/specs/999-spec-ausente.md@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "> Estado: done",
          ],
        }),
      ),
    );
    expect(missingSpec.action).toMatchObject({
      kind: "blocked",
      command: null,
      code: "WORKLINE_BASELINE_SPEC_ABSENT",
    });
  });

  it("6 · con todo validado y el sello alineado, lo que falta es la validación final", async () => {
    const item = await planItem(detailWorkspace(detailPlan({ f2: "validada" })));
    expect(item.detail.next).toBe("todo ejecutado: falta la validación final y el cierre");
    expect(item.detail.obligation).toBe(false);
    expect(item.detail.progress).toBe("2/2 tareas (100%) · fases 2/2");
  });

  it("7 · y si queda fase por validar, el paso es continuar por ella", async () => {
    const item = await planItem(detailWorkspace(detailPlan()));
    expect(item.detail.next).toBe("continuar por la primera fase no validada");
    expect(item.detail.obligation).toBe(false);
  });
});

describe("derivePipeline — de una spec pendiente se dice su status y sus preguntas", () => {
  it("y nada que exija correr el motor del refine", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/specs/015-spec-borrador.md",
      "---\nstatus: draft\n---\n\n# Spec\n\n## Open questions\n\n- ¿una?\n- ¿dos?\n",
    );

    const out = await index(fs);
    expect(out.pipeline[0]?.detail).toEqual({
      objective: "spec 015 — borrador",
      progress: "status draft, 2 pregunta(s) abierta(s)",
      next: "refinar hasta ready-for-plan",
      obligation: false,
    });
    // El tablero muestra UNA línea por ítem, así que el status y la cuenta de
    // preguntas que AC-05 le debe a una spec viajan en el título que ya imprime.
    expect(out.pipeline[0]?.summary).toBe("spec 015 — draft · 2 pregunta(s) abierta(s)");
  });

  it("una spec refinada y sin plan dice que le falta generarlo", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/016-spec-lista.md", READY);

    const out = await index(fs);
    expect(out.pipeline[0]).toMatchObject({
      kind: "spec-unplanned",
      summary: "spec 016 — ready-for-plan · 0 pregunta(s) abierta(s)",
      detail: {
        progress: "status ready-for-plan, 0 pregunta(s) abierta(s)",
        next: "generar su plan",
        obligation: false,
      },
    });
  });
});

// ── the loose session leaves the pipeline and becomes a notice ───────────────

describe("buildWorklineIndex — una sesión suelta es un aviso, no trabajo del usuario", () => {
  function looseWorkspace(): MemFs {
    const fs = workspace();
    fs.file(
      "/cwd/.workflow/sessions/013-suelta-quick/SESSION.md",
      "# SESSION\n\n## Objective\nalgo suelto\n\n## Origin\n- prompt directo\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/013-suelta-quick/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- algo\n\n## Pending / Next\n- seguir\n",
    );
    return fs;
  }

  it("sale del pipeline y se reporta por su carpeta en loose_sessions", async () => {
    const out = await index(looseWorkspace());
    expect(out.pipeline).toEqual([]);
    expect(out.loose_sessions).toEqual(["013-suelta-quick"]);
  });

  it("no compite con un plan abierto: el plan es el único pendiente", async () => {
    const fs = looseWorkspace();
    fs.file("/cwd/docs/plans/005-plan-abierto.md", "# Plan\n\n## Tasks\n- [ ] T1\n");

    const out = await index(fs);
    expect(out.pipeline.map((p) => p.kind)).toEqual(["plan-open"]);
    expect(out.loose_sessions).toEqual(["013-suelta-quick"]);
  });

  it("una sesión con documento asociado no es suelta", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/.workflow/sessions/014-x-plan-exec/SESSION.md",
      "# SESSION\n\n## Objective\nejecutar\n\n## Origin\n- docs/plans/005-plan-x.md\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/014-x-plan-exec/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- x\n",
    );

    const out = await index(fs);
    expect(out.loose_sessions).toEqual([]);
  });
});

// Una cadena de decisiones ILEGIBLE no es «sin obligaciones» (plan 042 · F1).
//
// El código decía esto mismo en un comentario y hacía lo contrario: caía a lista
// vacía, así que un índice corrupto se leía como pizarra limpia y dejaba cerrar
// un plan sobre compensación que nadie podía leer. Se reporta como lo que es —
// trabajo debido — y su acción es repararlo, porque repararlo ES el trabajo.

describe("una cadena ilegible deja el plan sin cerrar, nombrando el archivo", () => {
  const seedUnreadable = (fs: MemFs): void => {
    fs.file(`/cwd/${noteIndexPath("docs/decisions", "033", "detalle")}`, "{ esto no es json");
  };
  /** Un plan CERRADO: todas sus casillas, sus dos fases validadas y su cierre. */
  const donePlan = (): string =>
    detailPlan({
      f2: "validada",
      header: [
        `> Baseline: ${D_SPEC}@${D_DIGEST}`,
        "> Estado: done",
        "> Cierre: 2026-07-29 · sesión 134",
      ],
    });

  it("el plan cerrado deja de leerse cerrable y su pendiente nombra el índice", async () => {
    const text = donePlan();
    const fs = detailWorkspace(text);
    seedUnreadable(fs);

    const out = await index(fs);
    const plan = out.plans.find((p) => p.file === D_PLAN);

    expect(plan?.reconciliation?.closable).toBe(false);
    expect(plan?.reconciliation?.pending[0]?.text).toContain("NOTE_INDEX_UNREADABLE");
    expect(plan?.reconciliation?.pending[0]?.text).toContain(
      noteIndexPath("docs/decisions", "033", "detalle"),
    );
    // Una pendiente fabricada no tiene punto que ninguna nota haya declarado, y
    // decirlo así es lo que impide que se lea como uno. La reparación viaja en
    // su propio campo, que es el que las salidas nombran.
    expect(plan?.reconciliation?.pending[0]?.declared_point).toBe(
      "sin nota: la pendiente la fabrica la composición",
    );
    expect(plan?.reconciliation?.pending[0]?.repair).toContain("reparalo a mano");
    // El documento dice `done` y el contrato no se puede leer: eso es `inconsistent`.
    expect(plan?.plan_state).toBe("inconsistent");
  });

  it("y una cadena legible sobre el mismo plan lo deja cerrar", async () => {
    const text = donePlan();
    const fs = detailWorkspace(text);

    const plan = (await index(fs)).plans.find((p) => p.file === D_PLAN);

    expect(plan?.reconciliation?.closable).toBe(true);
    expect(plan?.plan_state).toBe("done");
  });
});

// F4 · T4.2 — la fila de un plan con compensación vigente. Salía `blocked` con
// `command: null`, que es un rechazo sin salida: el tablero decía que no se
// puede y no decía por dónde. Lo que se fija es que la salida existe siempre y
// que es la correcta de las dos según haya o no una corrida abierta.
describe("el ítem de un plan con compensación vigente siempre trae comando", () => {
  const OWING_SESSION = "144-deuda-plan-exec";

  function owing(): MemFs {
    const fs = new MemFs();
    fs.file("/cwd/.workflow/sessions/.keep", "");
    seedExecutedPlanOwingCompensation(fs);
    return fs;
  }

  /** Una sesión activa con una corrida de `plan-exec` fija sobre este plan. */
  function withOpenRun(fs: MemFs, folder = OWING_SESSION): MemFs {
    fs.file(
      `/cwd/.workflow/sessions/${folder}/SESSION.md`,
      "# SESSION\n\n## Objective\nejecutar\n\n## Type\nexec\n",
    );
    const run = withScope(newRunState("plan-exec", folder), {
      plan: OWING_PLAN,
      sources: ["workspace"],
    });
    fs.file(`/cwd/.workflow/sessions/${folder}/${FLOW_RUN_STATE_FILE}`, serializeRunState(run));
    return fs;
  }

  async function owingItem(fs: MemFs) {
    const out = await index(fs);
    const item = out.pipeline.find((row) => row.file === OWING_PLAN);
    if (item === undefined) throw new Error("el plan no está en el pipeline");
    return item;
  }

  it("sin corrida abierta el comando es el que salda el plan", async () => {
    const item = await owingItem(owing());

    expect(item.detail.next).toContain("COMPENSACIÓN VIGENTE por DEC-001");
    expect(item.detail.next).toContain(OWING_TEXT);
    expect(item.detail.obligation).toBe(true);
    expect(item.command).toBe(`aw settle prepare ${OWING_PLAN}`);
    expect(item.action.kind).toBe("continue");
  });

  it("con una corrida abierta sobre el plan el comando es el de ESA corrida", async () => {
    const item = await owingItem(withOpenRun(owing()));

    // La corrida abierta manda: `aw settle` se niega debajo de ella, así que
    // ofrecerlo sería ofrecer un comando que rechaza.
    expect(item.command).toBe(`aw flow advance --code ${OWING_SESSION}`);
    expect(item.action).toMatchObject({ kind: "continue", mode: "settlement" });
  });

  it("una sesión abierta de OTRO flujo no se vuelve la dueña del plan", async () => {
    const fs = owing();
    fs.file(
      "/cwd/.workflow/sessions/900-otra-cosa-quick/SESSION.md",
      "# SESSION\n\n## Objective\notra cosa\n\n## Type\nquick\n",
    );
    fs.file(
      `/cwd/.workflow/sessions/900-otra-cosa-quick/${FLOW_RUN_STATE_FILE}`,
      serializeRunState(newRunState("quick", "900-otra-cosa-quick")),
    );

    const out = await index(fs);
    const plan = out.plans.find((p) => p.file === OWING_PLAN);
    const item = out.pipeline.find((row) => row.file === OWING_PLAN);

    // Ninguna corrida de otro flujo fija un plan, así que ninguna lo tiene: el
    // tablero mandaba a adoptar la corrida de un tercero para saldar este plan.
    expect(plan?.holding_run).toBeNull();
    expect(item?.command).toBe(`aw settle prepare ${OWING_PLAN}`);
  });

  it("con la cadena ilegible el tablero nombra la reparación, no una fase", async () => {
    const fs = owing();
    // La cadena del linaje, corrompida: el contrato no compone, así que la
    // pendiente es la propia negativa y el plan no es cerrable.
    fs.file(`/cwd/${noteIndexPath("docs/decisions", "043", "deuda")}`, "{ esto no es json");

    const out = await index(fs);
    const plan = out.plans.find((row) => row.file === OWING_PLAN);
    const item = out.pipeline.find((row) => row.file === OWING_PLAN);

    expect(plan?.contract).toBeNull();
    expect(plan?.reconciliation?.closable).toBe(false);
    expect(item?.detail.next).toContain("LINAJE ILEGIBLE");
    // La frase que sirve: reparar el índice. Antes de esta prueba el tablero
    // decía «retomá en el cierre del plan» sobre un JSON roto.
    expect(item?.detail.next).toContain("reparalo a mano");
    expect(item?.detail.next).not.toContain("retomá en");
    // Y la fila sigue siendo una salida, no un bloqueo sin comando: un contrato
    // que no compone tiene una reparación, y una reparación es algo que se hace.
    expect(item?.action.kind).toBe("continue");
    expect(item?.command).not.toBeNull();
  });

  it("ninguna fila del tablero queda sin comando por reconciliación", async () => {
    for (const fs of [owing(), withOpenRun(owing())]) {
      const out = await index(fs);
      for (const item of out.pipeline) {
        // Ningún código de bloqueo del tablero habla de reconciliación: la
        // situación dejó de ser un bloqueo y pasó a ser una salida.
        const blocked = item.action.kind === "blocked" ? item.action.code : "";
        expect(blocked).not.toContain("RECONCILIATION");
      }
      const item = out.pipeline.find((row) => row.file === OWING_PLAN);
      expect(item?.command).not.toBeNull();
    }
  });
});
