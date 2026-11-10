// Spec 066, AC-13 y D09: `aw discard` marca la spec o el plan como `abandoned`
// sin borrarlo y sin tocar documentos compartidos con otros planes.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

const SPEC = "docs/specs/003-spec-cupones.md";
const PLAN_A = "docs/plans/010-plan-cupones-web.md";
const PLAN_B = "docs/plans/011-plan-cupones-app.md";

const plan = (number: string) =>
  [
    `# Plan ${number} — cupones`,
    "",
    `> Derived from ${SPEC}`,
    "> Estado: ready",
    "",
    "## Tasks",
    "",
    "- [ ] T1.1 — aplicar el cupón",
    "",
  ].join("\n");

describe("aw discard marca abandoned sin borrar", () => {
  let hub: DocFlowHub;
  beforeEach(() => {
    hub = docFlowHub();
    writeFileSync(
      join(hub.root, SPEC),
      "---\nstatus: ready-for-plan\n---\n\n# Spec 003 — Cupones\n",
    );
    writeFileSync(join(hub.root, PLAN_A), plan("010"));
    writeFileSync(join(hub.root, PLAN_B), plan("011"));
    hub.checkpoint("docs");
  });
  afterEach(() => hub.dispose());

  const discard = (target: string) => {
    const prepared = hub.aw(["discard", "prepare", target]);
    expect(prepared.status, JSON.stringify(prepared.json)).toBe(0);
    expect(hub.changed()).toEqual([]);
    const preview = dataOf(prepared.json);
    return {
      preview,
      apply: () => hub.aw(["discard", "apply", target, "--approval", preview.digest as string]),
    };
  };

  it("un plan queda abandoned en su sitio; su spec y el plan hermano no cambian", () => {
    const specBefore = readFileSync(join(hub.root, SPEC), "utf8");
    const siblingBefore = readFileSync(join(hub.root, PLAN_B), "utf8");
    const { preview, apply } = discard("plan:010");
    expect(preview).toMatchObject({ kind: "plan", target: PLAN_A, from: "ready", to: "abandoned" });
    expect(apply().status).toBe(0);

    expect(existsSync(join(hub.root, PLAN_A))).toBe(true);
    expect(readFileSync(join(hub.root, PLAN_A), "utf8")).toContain("> Estado: abandoned");
    expect(readFileSync(join(hub.root, SPEC), "utf8")).toBe(specBefore);
    expect(readFileSync(join(hub.root, PLAN_B), "utf8")).toBe(siblingBefore);
    expect(hub.changed()).toEqual([PLAN_A]);

    const board = dataOf(hub.aw(["status", "--detail"]).json);
    const plans = board.plans as { number: string; plan_state: string }[];
    expect(plans.find((item) => item.number === "010")?.plan_state).toBe("abandoned");
    const pending = (board.pipeline as { number: string }[]).map((item) => item.number);
    expect(pending).not.toContain("010");
    expect(pending).toContain("011");
  });

  it("una spec queda abandoned y sus planes vivos se nombran sin tocarse", () => {
    const { preview, apply } = discard("spec:003");
    expect(preview).toMatchObject({ kind: "spec", target: SPEC, from: "ready-for-plan" });
    expect(preview.untouched).toEqual([PLAN_A, PLAN_B]);
    expect(apply().status).toBe(0);
    expect(readFileSync(join(hub.root, SPEC), "utf8")).toMatch(/^---\nstatus: abandoned\n---/);
    expect(hub.changed()).toEqual([SPEC]);
    expect(hub.sessionResidue()).toEqual([]);
  });

  it("un documento cambiado después de la vista previa no se escribe", () => {
    const { apply } = discard("plan:010");
    writeFileSync(join(hub.root, PLAN_A), plan("010").replace("aplicar", "editado"));
    const before = readFileSync(join(hub.root, PLAN_A), "utf8");
    const refused = apply();
    expect(refused.status).toBe(1);
    expect((refused.json.error as { code: string }).code).toBe("DOC_CHANGED_SINCE_READ");
    expect(readFileSync(join(hub.root, PLAN_A), "utf8")).toBe(before);
  });
});
