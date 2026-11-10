// Spec 066, AC-08 — escenario «dos instancias sobre el mismo plan»: la instancia A
// leyó el plan, la B lo escribió después, y A se detiene antes de escribir con
// DOC_CHANGED_SINCE_READ sin cambiar un byte.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

const PLAN = "docs/plans/012-plan-cupones.md";

const planText = (task: string) =>
  [
    "# Plan 012 — cupones",
    "",
    "> Standalone: prueba de concurrencia",
    "> Estado: ready",
    "> Límite de ejecución: checkout",
    "",
    "## Tasks",
    "",
    "### F1 — El carrito acepta un cupón",
    "> Estado: pendiente",
    "> Fuentes: app",
    "",
    "**Resultado:** el total baja.",
    `- [ ] T1.1 — ${task} _(fuentes: app)_`,
    "**Validación de fase:** `npx vitest run tests/cupon.test.ts` pasa.",
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

describe("detección de cambio desde la lectura (AC-08)", () => {
  let hub: DocFlowHub;
  beforeEach(() => {
    hub = docFlowHub();
    writeFileSync(join(hub.root, PLAN), planText("aplicar el cupón"));
    hub.checkpoint("plan");
  });
  afterEach(() => hub.dispose());

  const read = () =>
    dataOf(hub.aw(["flow", "read", "--flow", "plan-refine", "--doc", PLAN]).json)
      .read_digest as string;

  const save = (digest: string, content: string) => {
    const base = ["flow", "save", "--flow", "plan-refine", "--doc", PLAN, "--read-digest", digest];
    const preview = dataOf(hub.aw(base, content).json);
    return hub.aw([...base, "--approval", preview.approval as string], content);
  };

  it("dos instancias sobre el mismo plan: la que leyó antes se detiene y no cambia ningún byte", () => {
    const instanceA = read();
    const instanceB = read();
    expect(instanceA).toBe(instanceB);

    const writtenByB = save(instanceB, planText("aplicar el cupón vigente"));
    expect(writtenByB.status).toBe(0);
    const afterB = readFileSync(join(hub.root, PLAN), "utf8");

    const refusedA = save(instanceA, planText("aplicar el cupón del día"));
    expect(refusedA.status).toBe(1);
    expect((refusedA.json.error as { code: string }).code).toBe("DOC_CHANGED_SINCE_READ");
    expect(JSON.stringify(refusedA.json)).toContain("cambió desde que esta instancia lo leyó");
    expect(readFileSync(join(hub.root, PLAN), "utf8")).toBe(afterB);
  });

  it("una edición sin commit de otra instancia también cuenta como cambio", () => {
    const digest = read();
    writeFileSync(join(hub.root, PLAN), planText("editado a mano"));
    const before = readFileSync(join(hub.root, PLAN), "utf8");
    const refused = save(digest, planText("aplicar el cupón vigente"));
    expect((refused.json.error as { code: string }).code).toBe("DOC_CHANGED_SINCE_READ");
    expect(readFileSync(join(hub.root, PLAN), "utf8")).toBe(before);
  });

  it("una aprobación de otros bytes no escribe", () => {
    const digest = read();
    const base = ["flow", "save", "--flow", "plan-refine", "--doc", PLAN, "--read-digest", digest];
    const preview = dataOf(hub.aw(base, planText("uno")).json);
    const mismatched = hub.aw([...base, "--approval", preview.approval as string], planText("dos"));
    expect((mismatched.json.error as { code: string }).code).toBe("DOC_FLOW_APPROVAL_MISMATCH");
    expect(hub.changed()).toEqual([]);
  });
});
