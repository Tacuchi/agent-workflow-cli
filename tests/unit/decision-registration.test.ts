// Nota, efectos y punto de reanudación: juntos o nada (T5.4 del plan 032,
// S033/AC-12).
//
// Validación de fase de F5, sobre un workspace real y no sobre un doble:
//
// - las intercalaciones en que un baseline cambia entre la vista previa y el
//   registro fallan cerrado y conservan la decisión con lo que hay que revalidar;
// - el reintento idéntico es idempotente;
// - un rechazo deja CERO bytes escritos;
// - la segunda confirmación no aparece;
// - y una autorización no alcanza a ningún efecto fuera de los previsualizados.
//
// El disco es real a propósito: `applyLocalProposal` toma el lock del workspace y
// publica con rollback byte-exacto, y un doble en memoria comprobaría mi
// imitación de esas dos cosas en vez de las dos cosas.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  commitDecision,
  prepareDecision,
} from "../../src/application/decision-registration-service.js";
import type { PrepareDecisionInput } from "../../src/application/decision-registration-service.js";
import { applyLocalProposal } from "../../src/application/local-proposal.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { DecisionNote } from "../../src/domain/decision-note.js";
import { grantFor } from "../../src/domain/decision-preview.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const SPEC_PATH = "docs/specs/033-spec-x.md";
const PLAN_PATH = "docs/plans/032-plan-x.md";
const INDEX_PATH = "docs/decisions/033-decisions-x.json";

const SPEC_TEXT = [
  "# 033 — spec de prueba",
  "",
  "- [ ] **S033/AC-01 — una.** texto",
  "- [ ] **S033/AC-02 — otra.** texto",
  "",
].join("\n");
const PLAN_TEXT = "# 032 — plan de prueba\n";

/** Cada archivo bajo el workspace con su digest — para afirmar «cero bytes». */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(`${rel}=${baseDigest(readFileSync(join(root, dir, entry.name), "utf8"))}`);
    }
  };
  walk(".", "");
  return out;
}

describe("registrar una decisión", () => {
  let root: string;
  let fs: NodeFileSystem;
  let paths: PathsService;

  const draft = (over: Partial<DecisionNote> = {}): PrepareDecisionInput["draft"] => ({
    schema: "workline.decision-note/v1",
    lineage: {
      spec: { path: SPEC_PATH, number: "033", digest: `sha256:${baseDigest(SPEC_TEXT)}` },
      plan: { path: PLAN_PATH, number: "032", digest: `sha256:${baseDigest(PLAN_TEXT)}` },
      execution: { session: "131-x", phase: "F5" },
    },
    decision: "el gate se detiene y ofrece cuatro salidas",
    reason: "la elegibilidad es cierre y no tamaño",
    supersedes_assertions: ["S033/AC-02"],
    supersedes_note: null,
    scope: "functional",
    consumers: [PLAN_PATH],
    evidence_preserved: [],
    evidence_invalidated: [],
    obligations: ["revalidar el recorrido PLAN"],
    resume_point: "F5/T5.4",
    date: "2026-08-16",
    ...over,
  });

  const input = (over: Partial<PrepareDecisionInput> = {}): PrepareDecisionInput => ({
    root,
    operation: "plan-exec.decision-registration",
    indexPath: INDEX_PATH,
    baseline: {
      path: SPEC_PATH,
      number: "033",
      digest: `sha256:${baseDigest(SPEC_TEXT)}`,
      criteria: ["S033/AC-01", "S033/AC-02"],
    },
    draft: draft(),
    ...over,
  });

  const tree = (): string[] => snapshot(root);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "decision-reg-"));
    fs = new NodeFileSystem();
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(join(root, SPEC_PATH), SPEC_TEXT);
    writeFileSync(join(root, PLAN_PATH), PLAN_TEXT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("publica la nota con su punto de reanudación adentro, en una sola transición", async () => {
    const prepared = await prepareDecision(fs, input());
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("esperaba prepared");

    // Antes de commitear no hay un solo byte de la decisión.
    expect(tree().some((e) => e.startsWith(INDEX_PATH))).toBe(false);

    const committed = await commitDecision(fs, paths, root, prepared.prepared);
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error("esperaba ok");

    expect(committed.result.note.id).toBe("DEC-001");
    expect(committed.result.already_applied).toBe(false);
    expect(committed.result.written).toEqual([INDEX_PATH]);
    expect(committed.result.resume_point).toBe("F5/T5.4");

    // El punto de reanudación NO puede separarse de la nota: es un campo suyo.
    const written = JSON.parse(readFileSync(join(root, INDEX_PATH), "utf8"));
    expect(written.notes).toHaveLength(1);
    expect(written.notes[0].resume_point).toBe("F5/T5.4");
    expect(written.notes[0].digest).toBe(committed.result.note.digest);
  });

  it("la vista previa muestra las ocho cosas y su sello cubre los bytes que se escriben", async () => {
    const prepared = await prepareDecision(fs, input());
    if (prepared.status !== "prepared") throw new Error("esperaba prepared");
    const { preview } = prepared.prepared;

    expect(preview.baseline.path).toBe(SPEC_PATH);
    expect(preview.effective_change).toEqual([
      { assertion: "S033/AC-02", from: "baseline", to: "amended", by: "DEC-001" },
    ]);
    expect(preview.consumers).toEqual([PLAN_PATH]);
    expect(preview.impact).toEqual({ scope: "functional", assertions: 1, consumers: 1 });
    expect(preview.evidence).toEqual({ preserved: [], invalidated: [] });
    expect(preview.obligations).toEqual(["revalidar el recorrido PLAN"]);
    expect(preview.resume_point).toBe("F5/T5.4");
    expect(preview.effects.entries).toEqual([
      { path: INDEX_PATH, bytes: expect.any(Number), overwrite: false },
    ]);

    await commitDecision(fs, paths, root, prepared.prepared);
    const onDisk = readFileSync(join(root, INDEX_PATH), "utf8");
    // Lo que se enseñó y lo que se escribió son los MISMOS bytes.
    expect(Buffer.byteLength(onDisk, "utf8")).toBe(preview.effects.entries[0]?.bytes);
    expect(onDisk).toContain(prepared.prepared.note.digest);
  });

  it("un reintento idéntico recupera el mismo resultado sin volver a decidir", async () => {
    const first = await prepareDecision(fs, input());
    if (first.status !== "prepared") throw new Error("esperaba prepared");
    await commitDecision(fs, paths, root, first.prepared);
    const after = tree();

    // El mismo borrador otra vez: la cadena ya lo tiene, así que no hay nada
    // que preguntar y no se acuña un DEC-002 duplicado.
    const again = await prepareDecision(fs, input());
    expect(again.status).toBe("already");
    if (again.status !== "already") throw new Error("esperaba already");
    expect(again.note.id).toBe("DEC-001");
    expect(again.resume_point).toBe("F5/T5.4");
    expect(tree()).toEqual(after);
  });

  it("re-commitear la misma propuesta preparada es idempotente y no escribe de nuevo", async () => {
    const prepared = await prepareDecision(fs, input());
    if (prepared.status !== "prepared") throw new Error("esperaba prepared");
    await commitDecision(fs, paths, root, prepared.prepared);
    const after = tree();

    const retry = await commitDecision(fs, paths, root, prepared.prepared);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("esperaba ok");
    expect(retry.result.already_applied).toBe(true);
    expect(retry.result.written).toEqual([]);
    expect(tree()).toEqual(after);
  });

  it("una decisión DISTINTA sobre el mismo linaje sí se acuña como nota nueva", async () => {
    const first = await prepareDecision(fs, input());
    if (first.status !== "prepared") throw new Error("esperaba prepared");
    await commitDecision(fs, paths, root, first.prepared);

    const other = await prepareDecision(
      fs,
      input({ draft: draft({ supersedes_assertions: ["S033/AC-01"], reason: "otra razón" }) }),
    );
    expect(other.status).toBe("prepared");
    if (other.status !== "prepared") throw new Error("esperaba prepared");
    expect(other.prepared.note.id).toBe("DEC-002");
    // Y su destino ya existe: la vista previa lo dice como reemplazo.
    expect(other.prepared.preview.effects.entries[0]?.overwrite).toBe(true);
    expect(other.prepared.preview.effects.classes).toEqual(["mutate_overwrite"]);
  });
});

describe("intercalaciones: lo que cambia entre la vista previa y el registro", () => {
  let root: string;
  let fs: NodeFileSystem;
  let paths: PathsService;

  const baseInput = (): PrepareDecisionInput => ({
    root,
    operation: "plan-exec.decision-registration",
    indexPath: INDEX_PATH,
    baseline: {
      path: SPEC_PATH,
      number: "033",
      digest: `sha256:${baseDigest(SPEC_TEXT)}`,
      criteria: ["S033/AC-01", "S033/AC-02"],
    },
    draft: {
      schema: "workline.decision-note/v1",
      lineage: {
        spec: { path: SPEC_PATH, number: "033", digest: `sha256:${baseDigest(SPEC_TEXT)}` },
        plan: { path: PLAN_PATH, number: "032", digest: `sha256:${baseDigest(PLAN_TEXT)}` },
        execution: { session: "131-x", phase: "F5" },
      },
      decision: "se detiene",
      reason: "cierre y no tamaño",
      supersedes_assertions: ["S033/AC-02"],
      supersedes_note: null,
      scope: "functional",
      consumers: [PLAN_PATH],
      evidence_preserved: [],
      evidence_invalidated: [],
      obligations: [],
      resume_point: "F5/T5.4",
      date: "2026-08-16",
    },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "decision-race-"));
    fs = new NodeFileSystem();
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(join(root, SPEC_PATH), SPEC_TEXT);
    writeFileSync(join(root, PLAN_PATH), PLAN_TEXT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("la spec cambia entre previsualizar y registrar: falla cerrado y conserva la decisión", async () => {
    const prepared = await prepareDecision(fs, baseInput());
    if (prepared.status !== "prepared") throw new Error("esperaba prepared");

    writeFileSync(join(root, SPEC_PATH), `${SPEC_TEXT}\n- [ ] **S033/AC-03 — tercera.** nueva\n`);

    const committed = await commitDecision(fs, paths, root, prepared.prepared);
    expect(committed.ok).toBe(false);
    if (committed.ok) throw new Error("esperaba un rechazo");
    expect(committed.failure.code).toBe("PROPOSAL_BASE_STALE");
    // La decisión sobrevive al rechazo, con lo que hay que revalidar.
    expect(committed.decision.id).toBe("DEC-001");
    expect(committed.decision.decision).toBe("se detiene");
    expect(committed.revalidate).toContain(SPEC_PATH);
    expect(committed.revalidate).toContain(PLAN_PATH);
    // Cero bytes: el índice nunca nació.
    expect(readdirSync(join(root, "docs"))).not.toContain("decisions");
  });

  it("el plan cambia entre previsualizar y registrar: también falla cerrado", async () => {
    const prepared = await prepareDecision(fs, baseInput());
    if (prepared.status !== "prepared") throw new Error("esperaba prepared");

    writeFileSync(join(root, PLAN_PATH), `${PLAN_TEXT}una línea más\n`);

    const committed = await commitDecision(fs, paths, root, prepared.prepared);
    expect(committed.ok).toBe(false);
    if (committed.ok) throw new Error("esperaba un rechazo");
    expect(committed.failure.code).toBe("PROPOSAL_BASE_STALE");
    expect(readdirSync(join(root, "docs"))).not.toContain("decisions");
  });

  it("otra nota entra en la cadena entremedio: falla cerrado y no la pisa", async () => {
    const first = await prepareDecision(fs, baseInput());
    if (first.status !== "prepared") throw new Error("esperaba prepared");

    // Otra corrida prepara y registra una decisión distinta sobre el mismo linaje.
    const intruder = baseInput();
    const other = await prepareDecision(fs, {
      ...intruder,
      draft: { ...intruder.draft, supersedes_assertions: ["S033/AC-01"], reason: "otra" },
    });
    if (other.status !== "prepared") throw new Error("esperaba prepared");
    const landed = await commitDecision(fs, paths, root, other.prepared);
    expect(landed.ok).toBe(true);

    // La primera se preparó contra un índice que no existía; ahora existe, así
    // que su escritura aditiva caería sobre bytes de otro.
    const committed = await commitDecision(fs, paths, root, first.prepared);
    expect(committed.ok).toBe(false);
    if (committed.ok) throw new Error("esperaba un rechazo");
    expect(committed.failure.code).toBe("PUBLISH_TARGET_EXISTS");
    expect(committed.decision.id).toBe("DEC-001");

    // Y la nota del intruso sigue exactamente donde estaba: nada se pisó.
    const index = JSON.parse(readFileSync(join(root, INDEX_PATH), "utf8"));
    expect(index.notes).toHaveLength(1);
    expect(index.notes[0].reason).toBe("otra");
  });

  it("un rechazo deja cero bytes: preparar sella, compone y no toca el disco", async () => {
    const before = snapshot(root);
    const prepared = await prepareDecision(fs, baseInput());

    // Preparar hace todo el trabajo — lee, acuña el correlativo, compone el
    // contrato, sella la propuesta — y aun así el workspace es byte-idéntico.
    // La persona dijo que no: nadie llama a `commitDecision`.
    if (prepared.status !== "prepared") throw new Error("esperaba prepared");
    expect(prepared.prepared.note.id).toBe("DEC-001");
    expect(snapshot(root)).toEqual(before);
  });

  it("el permiso de la vista previa no alcanza a otros bytes", async () => {
    const prepared = await prepareDecision(fs, baseInput());
    if (prepared.status !== "prepared") throw new Error("esperaba prepared");
    const grant = grantFor(prepared.prepared.preview);
    expect(grant.digest).toBe(prepared.prepared.preview.proposal.digest);
    expect(grant.destinations).toEqual([INDEX_PATH]);

    // Una propuesta con otros bytes tiene otro sello, así que este permiso no
    // la nombra. Se comprueba aplicándolo de verdad sobre la otra propuesta:
    // `applyLocalProposal` compara el sello y no la intención.
    const intruder = baseInput();
    const other = await prepareDecision(fs, {
      ...intruder,
      draft: { ...intruder.draft, reason: "otra razón distinta" },
    });
    if (other.status !== "prepared") throw new Error("esperaba prepared");
    expect(other.prepared.preview.proposal.digest).not.toBe(grant.digest);

    const before = snapshot(root);
    const applied = await applyLocalProposal(fs, paths, {
      root,
      proposal: other.prepared.preview.proposal,
      approval: { digest: grant.digest, granted: grant.classes },
      selfAuthorized: [],
    });

    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error("esperaba un rechazo");
    expect(applied.failure.code).toBe("PROPOSAL_APPROVAL_MISMATCH");
    expect(applied.applied).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("una decisión que no se puede componer no llega a pedir autorización", () => {
  let root: string;
  let fs: NodeFileSystem;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "decision-block-"));
    fs = new NodeFileSystem();
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(join(root, SPEC_PATH), SPEC_TEXT);
    writeFileSync(join(root, PLAN_PATH), PLAN_TEXT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const withDraft = (over: Partial<PrepareDecisionInput["draft"]>): PrepareDecisionInput => ({
    root,
    operation: "plan-exec.decision-registration",
    indexPath: INDEX_PATH,
    baseline: {
      path: SPEC_PATH,
      number: "033",
      digest: `sha256:${baseDigest(SPEC_TEXT)}`,
      criteria: ["S033/AC-01", "S033/AC-02"],
    },
    draft: {
      schema: "workline.decision-note/v1",
      lineage: {
        spec: { path: SPEC_PATH, number: "033", digest: `sha256:${baseDigest(SPEC_TEXT)}` },
        plan: { path: PLAN_PATH, number: "032", digest: `sha256:${baseDigest(PLAN_TEXT)}` },
        execution: { session: "131-x", phase: "F5" },
      },
      decision: "se detiene",
      reason: "cierre y no tamaño",
      supersedes_assertions: ["S033/AC-02"],
      supersedes_note: null,
      scope: "functional",
      consumers: [PLAN_PATH],
      evidence_preserved: [],
      evidence_invalidated: [],
      obligations: [],
      resume_point: "F5/T5.4",
      date: "2026-08-16",
      ...over,
    },
  });

  it("sustituir una afirmación que la spec no enuncia bloquea antes de la vista previa", async () => {
    const prepared = await prepareDecision(
      fs,
      withDraft({ supersedes_assertions: ["S033/AC-99"] }),
    );

    expect(prepared.status).toBe("blocked");
    if (prepared.status !== "blocked") throw new Error("esperaba blocked");
    expect(prepared.failures.map((f) => f.code)).toContain("CONTRACT_ASSERTION_ABSENT");
    expect(readdirSync(join(root, "docs"))).not.toContain("decisions");
  });

  it("una nota incompleta se rechaza con el código de su campo, no con uno genérico", async () => {
    const prepared = await prepareDecision(fs, withDraft({ resume_point: "" }));

    expect(prepared.status).toBe("blocked");
    if (prepared.status !== "blocked") throw new Error("esperaba blocked");
    expect(prepared.failures.map((f) => f.code)).toContain("NOTE_RESUME_POINT_MISSING");
  });

  it("un linaje que ya no está en el disco se rechaza en vez de sellar sobre nada", async () => {
    rmSync(join(root, PLAN_PATH));
    const prepared = await prepareDecision(fs, withDraft({}));

    expect(prepared.status).toBe("blocked");
    if (prepared.status !== "blocked") throw new Error("esperaba blocked");
    expect(prepared.failures.map((f) => f.code)).toContain("DECISION_BASE_ABSENT");
  });
});
