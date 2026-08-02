import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DesignManifest, validateDesignManifest } from "../../src/domain/design/manifest.js";
import {
  findHistoryLoss,
  historyLossFailure,
  planNextRevision,
} from "../../src/domain/design/revision.js";

const RAW = readFileSync(
  fileURLToPath(new URL("../fixtures/design/manifest-maximal.json", import.meta.url)),
  "utf8",
);

function manifest(apply?: (m: Record<string, unknown>) => void): DesignManifest {
  const doc = JSON.parse(RAW) as Record<string, unknown>;
  apply?.(doc);
  const result = validateDesignManifest(doc);
  if (!result.ok || result.value === null) {
    throw new Error(`el fixture no valida: ${result.failures[0]?.message}`);
  }
  return result.value;
}

const DOC = "docs/designs/001-design-alta/design-manifest.json";

describe("planNextRevision — la siguiente revisión es otro archivo", () => {
  it("continúa la línea de un artefacto existente", () => {
    // El fixture tiene FLW-001 en r1 y r2.
    const plan = planNextRevision(manifest(), "flow", "FLW-001", "alta-miembro", DOC);
    if (!plan.ok) throw new Error(plan.failure.message);
    expect(plan.value.revision).toBe(3);
    expect(plan.value.path).toBe("flows/FLW-001-r003-alta-miembro.md");
    expect(plan.value.supersedes).toBe("DES-001/FLW-001@r2");
    expect(plan.value.preserves).toEqual([
      "flows/FLW-001-r001-alta-miembro.md",
      "flows/FLW-001-r002-alta-miembro.md",
    ]);
  });

  it("un artefacto nuevo nace en r1 y no supersede a nadie", () => {
    const plan = planNextRevision(manifest(), "screen", "SCR-009", "detalle-miembro", DOC);
    if (!plan.ok) throw new Error(plan.failure.message);
    expect(plan.value.revision).toBe(1);
    expect(plan.value.path).toBe("screens/SCR-009-r001-detalle-miembro.md");
    expect(plan.value.supersedes).toBeNull();
    expect(plan.value.preserves).toEqual([]);
  });

  it("respeta el directorio y el sufijo de cada tipo", () => {
    const rule = planNextRevision(manifest(), "rule", "RUL-001", "densidad", DOC);
    const token = planNextRevision(manifest(), "token", "TOK-001", "base", DOC);
    const rendition = planNextRevision(manifest(), "rendition", "VIS-001", "alta", DOC);
    if (!rule.ok || !token.ok || !rendition.ok) throw new Error("esperaba tres planes");
    expect(rule.value.path).toBe("design-system/rules/RUL-001-r002-densidad.md");
    expect(token.value.path).toBe("tokens/TOK-001-r002-base.tokens.json");
    expect(rendition.value.path).toBe("renditions/VIS-001-r002-alta/rendition.json");
  });

  it("rechaza un slug que no es un slug", () => {
    const plan = planNextRevision(manifest(), "flow", "FLW-001", "Alta Miembro", DOC);
    if (plan.ok) throw new Error("esperaba un fallo");
    expect(plan.failure.message).toContain("no es un slug");
  });
});

describe("findHistoryLoss — publicar la siguiente no puede perder la anterior", () => {
  it("no reporta nada cuando solo se agrega una revisión", () => {
    const before = manifest();
    const after = manifest((m) => {
      (m.catalog as { screens: Array<Record<string, unknown>> }).screens.push({
        id: "SCR-001",
        revision: 2,
        path: "screens/SCR-001-r002-formulario-alta.md",
        supersedes: "DES-001/SCR-001@r1",
        maturity: "handoff",
      });
    });
    expect(findHistoryLoss(before, after)).toEqual([]);
  });

  it("caza una revisión que desapareció del catálogo", () => {
    const before = manifest();
    const after = manifest((m) => {
      const flows = (m.catalog as { flows: Array<Record<string, unknown>> }).flows;
      flows.shift();
      // Sin esto el manifest ni siquiera valida: el validador ya no admite un
      // 'supersedes' colgante. Es otra capa de la misma garantía.
      (flows[0] as Record<string, unknown>).supersedes = null;
      (m.currentness as Array<Record<string, unknown>>).length = 0;
    });
    // Dos pérdidas, y las dos son reales: r1 desapareció, y para que el manifest
    // siguiera validando hubo que reescribir el 'supersedes' de r2 — que es
    // exactamente la otra mitad de la misma mutación.
    const losses = findHistoryLoss(before, after);
    const removed = losses.find((l) => l.kind === "removed");
    expect(removed).toMatchObject({ ref: "DES-001/FLW-001@r1" });
    expect(losses.find((l) => l.field === "supersedes")).toMatchObject({
      ref: "DES-001/FLW-001@r2",
    });
    expect(historyLossFailure(removed as never, DOC).action).toContain("no se toca");
  });

  it("caza una revisión que cambió de path", () => {
    const before = manifest();
    const after = manifest((m) => {
      const flows = (m.catalog as { flows: Array<Record<string, unknown>> }).flows;
      flows[0] = { ...(flows[0] as Record<string, unknown>), path: "flows/FLW-001-r001-otro.md" };
    });
    const losses = findHistoryLoss(before, after);
    expect(losses[0]).toMatchObject({ kind: "moved" });
    expect(historyLossFailure(losses[0] as never, DOC).message).toContain("cambió de path");
  });

  // El caso más grave: mismos ids, mismos paths, otros bytes. Una referencia ya
  // escrita seguiría "resolviendo" hacia un contenido distinto.
  it("caza un baseline cuyo digest cambió sin cambiar de revisión", () => {
    const before = manifest();
    const after = manifest((m) => {
      const baselines = m.baselines as Array<Record<string, unknown>>;
      baselines[0] = {
        ...(baselines[0] as Record<string, unknown>),
        digest: `sha256:${"e".repeat(64)}`,
      };
    });
    const losses = findHistoryLoss(before, after);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ ref: "DES-001@r1", kind: "rewritten" });
    expect(historyLossFailure(losses[0] as never, DOC).code).toBe("DESIGN_HISTORY_MUTATED");
  });

  it("caza un baseline entero que se borró", () => {
    const before = manifest();
    const after = manifest((m) => {
      const baselines = m.baselines as Array<Record<string, unknown>>;
      baselines.shift();
      (baselines[0] as Record<string, unknown>).parent_baseline = null;
      // El revocation del fixture decide sobre r1: sin él, el manifest no valida.
      (m.governance as { revocations: unknown[] }).revocations = [];
    });
    expect(findHistoryLoss(before, after)[0]).toMatchObject({
      ref: "DES-001@r1",
      kind: "removed",
    });
  });
});

describe("findHistoryLoss — promover en el lugar también es mutar historia", () => {
  // `outline` y `handoff` significan cosas distintas para un gate. Promover la
  // revisión que alguien ya fijó cambia lo que esa referencia quiere decir.
  it("caza una revisión publicada que cambió de madurez sin cambiar de revisión", () => {
    const before = manifest();
    const after = manifest((m) => {
      const flows = (m.catalog as { flows: Array<Record<string, unknown>> }).flows;
      flows[0] = { ...(flows[0] as Record<string, unknown>), maturity: "handoff" };
    });
    const losses = findHistoryLoss(before, after);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({
      ref: "DES-001/FLW-001@r1",
      kind: "rewritten",
      field: "maturity",
    });
    expect(historyLossFailure(losses[0] as never, DOC).message).toContain("cambió de maturity");
  });

  it("caza un 'supersedes' reescrito sobre una revisión ya publicada", () => {
    const before = manifest();
    const after = manifest((m) => {
      const screens = (m.catalog as { screens: Array<Record<string, unknown>> }).screens;
      screens[0] = { ...(screens[0] as Record<string, unknown>), maturity: "outline" };
    });
    expect(findHistoryLoss(before, after)[0]).toMatchObject({ field: "maturity" });
  });
});

describe("los huecos de test que señaló el review gate", () => {
  /** Rewrite every `DES-001` the manifest cites, wherever it appears. */
  function swapEverywhere(node: unknown): void {
    if (Array.isArray(node)) {
      for (const v of node) swapEverywhere(v);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") record[key] = value.replace("DES-001", "DES-777");
      else swapEverywhere(value);
    }
  }

  it("cambiar la identidad del package es la mayor pérdida de historia", () => {
    const losses = findHistoryLoss(manifest(), manifest(swapEverywhere));
    expect(losses.find((l) => l.field === "id")).toMatchObject({
      before: "DES-001",
      after: "DES-777",
    });
  });

  it("un asset que sale del catálogo también es historia perdida", () => {
    const before = manifest();
    const after = manifest((m) => {
      (m.catalog as { assets: unknown[] }).assets = [];
    });
    expect(findHistoryLoss(before, after)[0]).toMatchObject({ kind: "removed" });
  });

  it("un record de gobierno que cambia de target reescribe lo que aprobó", () => {
    const before = manifest();
    const after = manifest((m) => {
      (m.governance as { reviews: Array<Record<string, unknown>> }).reviews[0].target =
        "DES-001@r1";
    });
    expect(findHistoryLoss(before, after)[0]).toMatchObject({
      ref: "REV-001",
      kind: "rewritten",
      field: "target",
    });
  });

  it("planNextRevision rechaza un id que no es un id: el id arma el path", () => {
    const plan = planNextRevision(manifest(), "flow", "../../evil", "alta", DOC);
    if (plan.ok) throw new Error("esperaba un fallo");
    expect(plan.failure.message).toContain("no es un id de flow");
  });
});
