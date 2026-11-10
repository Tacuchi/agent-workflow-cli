// Spec 066, AC-01, AC-02 y AC-04: spec-new, spec-refine, plan-new y plan-refine
// corren por `aw flow read`/`aw flow save` sobre un hub temporal sin crear
// `.workflow/sessions/`, `.flow-run.json` ni `.flow-attempts`, y cada recorrido
// deja en el diff del hub sólo el documento de su flujo.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

const SPEC = [
  "# Spec NNN — Cupones",
  "",
  "## Requirement",
  "",
  "El carrito acepta un cupón.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] AC-01: un cupón vigente descuenta el total.",
  "",
].join("\n");

const plan = (spec: string, closure: string) =>
  [
    "# Plan PPP — cupones",
    "",
    `> Derived from ${spec}`,
    "> Límite de ejecución: checkout",
    "",
    "## Tasks",
    "",
    "### F1 — El carrito acepta un cupón",
    "> Estado: pendiente",
    "> Fuentes: app",
    "",
    "**Resultado:** el total baja con un cupón vigente.",
    "- [ ] T1.1 — aplicar el cupón _(fuentes: app)_",
    `**Validación de fase:** ${closure}`,
    "**Condición de salida:** `npx vitest run tests/cupon.test.ts` pasa.",
    "",
    "## Execution batches",
    "",
    "- B1 · isolated · F1",
    "",
    "## Validations",
    "",
    "- AC-01: `npx vitest run tests/cupon.test.ts` cubre el descuento.",
    "",
  ].join("\n");

describe("flujos de documento sin sesión", () => {
  let hub: DocFlowHub;
  beforeEach(() => {
    hub = docFlowHub();
  });
  afterEach(() => hub.dispose());

  /** read → preview → approve, the whole save in the conversation. */
  const save = (flow: string, content: string, extra: string[] = []) => {
    const doc = extra.includes("--doc") ? extra[extra.indexOf("--doc") + 1] : undefined;
    const read = hub.aw(["flow", "read", "--flow", flow, ...(doc ? ["--doc", doc] : [])]);
    expect(read.status, JSON.stringify(read.json)).toBe(0);
    const digest = dataOf(read.json).read_digest as string;
    const preview = hub.aw(
      ["flow", "save", "--flow", flow, "--read-digest", digest, ...extra],
      content,
    );
    expect(preview.status, JSON.stringify(preview.json)).toBe(0);
    expect(dataOf(preview.json).status).toBe("preview");
    // Nothing is written by a preview.
    expect(hub.changed()).toEqual([]);
    const approval = dataOf(preview.json).approval as string;
    const written = hub.aw(
      ["flow", "save", "--flow", flow, "--read-digest", digest, "--approval", approval, ...extra],
      content,
    );
    expect(written.status, JSON.stringify(written.json)).toBe(0);
    return dataOf(written.json);
  };

  it("recorre spec-new, spec-refine, plan-new y plan-refine dejando sólo su documento", () => {
    const created = save("spec-new", SPEC, ["--slug", "cupones"]);
    expect(created).toMatchObject({ path: "docs/specs/001-spec-cupones.md", state: "draft" });
    expect(hub.changed()).toEqual(["docs/specs/001-spec-cupones.md"]);
    const specPath = "docs/specs/001-spec-cupones.md";
    expect(readFileSync(join(hub.root, specPath), "utf8")).toContain("# Spec 001 — Cupones");
    hub.checkpoint("spec-new");

    const refined = save(
      "spec-refine",
      readFileSync(join(hub.root, specPath), "utf8").replace(
        "descuenta el total",
        "descuenta el 10% del total",
      ),
      ["--doc", specPath],
    );
    expect(refined).toMatchObject({ path: specPath, state: "ready-for-plan" });
    expect(hub.changed()).toEqual([specPath]);
    expect(readFileSync(join(hub.root, specPath), "utf8")).toMatch(
      /^---\nstatus: ready-for-plan\n---/,
    );
    hub.checkpoint("spec-refine");

    const planned = save("plan-new", plan(specPath, "`npx vitest run tests/cupon.test.ts` pasa."), [
      "--doc",
      specPath,
      "--slug",
      "cupones",
    ]);
    expect(planned).toMatchObject({ path: "docs/plans/001-plan-cupones.md", state: "ready" });
    expect(hub.changed()).toEqual(["docs/plans/001-plan-cupones.md"]);
    const planText = readFileSync(join(hub.root, "docs/plans/001-plan-cupones.md"), "utf8");
    expect(planText).toContain("# Plan 001 — cupones");
    expect(planText).toContain("> Estado: ready");
    expect(planText).toMatch(/> Baseline: docs\/specs\/001-spec-cupones\.md@sha256:/);
    hub.checkpoint("plan-new");

    const planPath = "docs/plans/001-plan-cupones.md";
    const reshaped = save(
      "plan-refine",
      planText.replace("aplicar el cupón", "aplicar el cupón vigente"),
      ["--doc", planPath],
    );
    expect(reshaped).toMatchObject({ path: planPath, state: "ready" });
    expect(hub.changed()).toEqual([planPath]);

    expect(hub.sessionResidue()).toEqual([]);
  });

  it("un rechazo de forma no cuesta nada: el mismo envío corregido se acepta", () => {
    const created = save("spec-new", SPEC, ["--slug", "cupones"]);
    hub.checkpoint("spec");
    const specPath = created.path as string;
    save("spec-refine", readFileSync(join(hub.root, specPath), "utf8"), ["--doc", specPath]);
    hub.checkpoint("refine");

    const read = hub.aw(["flow", "read", "--flow", "plan-new", "--doc", specPath]);
    const digest = dataOf(read.json).read_digest as string;
    const bad = plan(specPath, "la rúbrica queda verde.");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = hub.aw(
        [
          "flow",
          "save",
          "--flow",
          "plan-new",
          "--doc",
          specPath,
          "--slug",
          "cupones",
          "--read-digest",
          digest,
        ],
        bad,
      );
      expect(refused.status).toBe(1);
      expect((refused.json.error as { code: string }).code).toBe("DOC_FLOW_PLAN_GRAMMAR");
    }
    const good = hub.aw(
      [
        "flow",
        "save",
        "--flow",
        "plan-new",
        "--doc",
        specPath,
        "--slug",
        "cupones",
        "--read-digest",
        digest,
      ],
      plan(specPath, "`npx vitest run tests/cupon.test.ts` pasa."),
    );
    expect(good.status).toBe(0);
    expect(dataOf(good.json).status).toBe("preview");
    expect(hub.changed()).toEqual([]);
    expect(hub.sessionResidue()).toEqual([]);
  });

  it("un plan del modelo de sesiones no se refina: se pide migrar el hub", () => {
    const path = "docs/plans/007-plan-viejo.md";
    writeFileSync(join(hub.root, path), "# Plan 007 — viejo\n\n> Estado: open\n\n## Tasks\n");
    const read = hub.aw(["flow", "read", "--flow", "plan-refine", "--doc", path]);
    expect(read.status).toBe(1);
    expect((read.json.error as { code: string }).code).toBe("HUB_MIGRATION_REQUIRED");
    expect(JSON.stringify(read.json)).toContain("aw hub-migrate");
  });
});
