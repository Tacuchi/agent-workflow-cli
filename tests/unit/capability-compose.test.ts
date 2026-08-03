import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import {
  COMPOSED_OPERATIONS,
  WORKLINE_FLOWS,
  type WorklineFlow,
  adoptDurableReference,
  composeCapability,
  composeGates,
  mayCompose,
} from "../../src/application/capability/compose.js";
import type { DispatchContext } from "../../src/application/capability/dispatcher.js";
import { dispatchCapability } from "../../src/application/capability/dispatcher.js";
import type { DesignIndex } from "../../src/application/design/design-index-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import { DESIGN_OPERATIONS } from "../../src/domain/design/capability.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const WORKSPACE = "/work";

function context(fs: MemFs = new MemFs()): DispatchContext {
  return {
    fs,
    env: new FakeEnv("/home/u", WORKSPACE),
    paths: new PathsService(normalizeNamespace("workflow"), "/home/u", WORKSPACE),
    workspace: WORKSPACE,
    host: "claude-code",
  };
}

const PACKAGE_INPUT: CapabilityInputValue = {
  name: "package",
  value: "DES-001",
  provenance: {
    kind: "reference",
    origin: "docs/designs",
    seal: null,
    sensitivity: "public",
  },
};

describe("el mapa flow → operación es exhaustivo y cerrado", () => {
  it("cubre los cinco flows y ninguno más", () => {
    expect(Object.keys(COMPOSED_OPERATIONS).sort()).toEqual([...WORKLINE_FLOWS].sort());
  });

  it("las entradas nombran operaciones que el descriptor declara", () => {
    const declared = new Set<string>(DESIGN_OPERATIONS);
    for (const [flow, entries] of Object.entries(COMPOSED_OPERATIONS)) {
      for (const entry of entries) {
        const [capability, operation] = entry.split(".");
        expect(capability, flow).toBe("design");
        expect(declared.has(operation as string), `${flow} → ${entry}`).toBe(true);
      }
    }
  });

  it("SPEC REFINE autora, los planes revisan y EXEC/QUICK solo validan", () => {
    expect(COMPOSED_OPERATIONS["spec-refine"]).toEqual([
      "design.create",
      "design.update",
      "design.validate",
    ]);
    for (const flow of ["plan-new", "plan-refine"] as const) {
      expect(COMPOSED_OPERATIONS[flow]).toEqual(["design.update", "design.validate"]);
    }
    for (const flow of ["plan-exec", "quick"] as const) {
      expect(COMPOSED_OPERATIONS[flow]).toEqual(["design.validate"]);
    }
  });

  // No existe una sexta operación `consume`: consumir es lo que el FLOW hace
  // con un package validado, no algo que le pide a la capacidad.
  it("no hay ninguna operación 'consume' en el mapa ni en el catálogo", () => {
    expect([...DESIGN_OPERATIONS]).not.toContain("consume");
    expect(Object.values(COMPOSED_OPERATIONS).flat().join(" ")).not.toContain("consume");
  });

  it.each([
    ["plan-exec", "create"],
    ["quick", "update"],
    ["plan-new", "create"],
    ["plan-refine", "render"],
  ] as const)("%s no compone '%s'", (flow, operation) => {
    expect(mayCompose(flow as WorklineFlow, "design", operation)).toBe(false);
  });
});

describe("un flow compone la misma operación sin ceder su lifecycle", () => {
  it("una operación fuera del mapa se rechaza y no llega al dispatcher", async () => {
    const fs = new MemFs();
    const result = await composeCapability(
      { verb: "prepare", flow: "plan-exec", capability: "design", operation: "create" },
      context(fs),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("CAPABILITY_COMPOSE_NOT_ALLOWED");
    expect(result.failure.action).toContain("design.validate");
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("compone por la misma puerta y el receipt dice qué flow llamó", async () => {
    const result = await composeCapability(
      {
        verb: "prepare",
        flow: "spec-refine",
        capability: "design",
        operation: "validate",
        inputs: [PACKAGE_INPUT],
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.request.caller.route).toBe("compose");
    expect(result.attempt.request.caller.flow).toBe("spec-refine");
  });

  it("la equivalencia con la ruta directa es semántica, no byte a byte", async () => {
    const ctx = context();
    const composed = await composeCapability(
      {
        verb: "prepare",
        flow: "plan-exec",
        capability: "design",
        operation: "validate",
        inputs: [PACKAGE_INPUT],
      },
      ctx,
    );
    const direct = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "validate",
        route: "direct",
        inputs: [PACKAGE_INPUT],
      },
      ctx,
    );
    expect(composed.ok && direct.ok).toBe(true);
    if (!composed.ok || !direct.ok) return;
    // Mismo contrato, mismos invariantes, mismo digest semántico…
    expect(composed.attempt.request.semantic_inputs_digest).toBe(
      direct.attempt.request.semantic_inputs_digest,
    );
    expect(composed.attempt.receipt.outcome).toBe(direct.attempt.receipt.outcome);
    expect(composed.attempt.receipt.capability).toBe(direct.attempt.receipt.capability);
    // …y campos de ruta/caller que difieren por contrato, no por accidente.
    expect(composed.attempt.request.request_digest).not.toBe(direct.attempt.request.request_digest);
  });
});

describe("el flow suma gates y no rebaja los de la capacidad", () => {
  const attempt = {
    ok: true as const,
    attempt: {
      request: {} as never,
      receipt: {
        validations: [{ id: "design-manifest", passed: false, detail: "falla" }],
      } as never,
      output: null,
      resolution: {} as never,
      plan: null,
    },
  };

  it("un gate propio se suma", () => {
    const out = composeGates(attempt, [{ id: "spec-criteria", passed: true }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.gates.map((g) => g.id).sort()).toEqual(["design-manifest", "spec-criteria"]);
  });

  it("declarar en verde una validación que la capacidad reprobó se rechaza", () => {
    const out = composeGates(attempt, [{ id: "design-manifest", passed: true }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe("CAPABILITY_GATE_LOWERED");
  });
});

describe("un output durable directo se adopta por referencia exacta", () => {
  const index: DesignIndex = {
    root: "docs/designs",
    packages: [
      {
        id: "DES-001",
        declared_id: "DES-001",
        title: "Alta",
        path: "docs/designs/DES-001",
        manifest_path: "docs/designs/DES-001/design-manifest.json",
        current_baseline: {
          revision: 2,
          path: "baselines/DES-001-r002.json",
          digest: "sha256:aa",
        },
        manifest: null,
        ok: true,
        failures: [],
      },
    ],
    failures: [],
  };

  it("misma identidad, revisión y digest: se adopta tal cual", () => {
    const out = adoptDurableReference(
      { id: "DES-001", revision: 2, digest: "sha256:aa", locator: "docs/designs/DES-001" },
      index,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Sin recreación ni conversión: la referencia sale igual que entró.
    expect(out.reference).toEqual({
      id: "DES-001",
      revision: 2,
      digest: "sha256:aa",
      locator: "docs/designs/DES-001",
    });
  });

  it("una revisión distinta no se adopta", () => {
    const out = adoptDurableReference(
      { id: "DES-001", revision: 1, digest: "sha256:aa", locator: "x" },
      index,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe("CAPABILITY_ADOPTION_REVISION_MISMATCH");
  });

  it("un digest que ya no corresponde no se adopta", () => {
    const out = adoptDurableReference(
      { id: "DES-001", revision: 2, digest: "sha256:bb", locator: "x" },
      index,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe("CAPABILITY_ADOPTION_DIGEST_MISMATCH");
  });
});

describe("la doctrina que los callers leen declara el mapa real, en UNA autoridad", () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../../skills/w/${rel}`, import.meta.url)), "utf8");
  const contract = read("roles/design/CONTRACT.md");
  const roleDoc = read("roles/design/ROLE.md");

  it("el contrato de invocación declara qué puede pedir cada caller", () => {
    expect(contract).toContain("aw capability prepare");
    expect(contract).toContain("SPEC REFINE");
    expect(contract).toContain("PLAN EXEC");
    expect(contract).toContain("no sixth `consume` operation");
  });

  it("el mapa que el código ejerce es el que la doctrina declara", () => {
    for (const [flow, entries] of Object.entries(COMPOSED_OPERATIONS)) {
      if (flow === "spec-refine") expect(entries).toHaveLength(3);
      // Cada operación del mapa aparece nombrada en el contrato publicado.
      for (const entry of entries) {
        expect(contract, `${flow} → ${entry}`).toContain(entry.split(".")[1] as string);
      }
    }
  });

  // Consolidación: el ROLE apunta al contrato en vez de repetirlo. Dos
  // descripciones del mismo contrato divergen el día que una cambia.
  it("el ROLE referencia el contrato y no lo repite", () => {
    expect(roleDoc).toContain("CONTRACT.md");
    expect(roleDoc).not.toContain("no sixth `consume` operation");
    expect(roleDoc).toContain("not\nreimplemented here");
  });
});
