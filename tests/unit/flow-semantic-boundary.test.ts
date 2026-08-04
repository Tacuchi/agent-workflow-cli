import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/application/context/manifest.js";
import { boundaryRequest, resolveBoundary } from "../../src/application/flow/advance.js";
import { parseFlowAnswer } from "../../src/domain/flow/answer.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  decisionsOfScope,
} from "../../src/domain/flow/authority.js";
import { newRunState } from "../../src/domain/flow/run-state.js";
import { asOwned } from "../helpers/owned-journey.js";

/**
 * The semantic boundary: the agent gets the context it needs, the response
 * contract and nothing the caller cannot see; its answer comes back as data and
 * is validated before it touches anything.
 *
 * The signal vocabulary is checked in BOTH directions against the bundle's own
 * manifest — one catalog, or two that drift.
 */

const BUNDLE = resolve(__dirname, "..", "..", "skills", "w");
const manifest = parseManifest(
  JSON.parse(readFileSync(join(BUNDLE, "context", "MANIFEST.json"), "utf8")),
);

/**
 * The row that declares QUICK's signals, as its own tranche will own it.
 *
 * A semantic boundary exists only for a transition the CLI owns; while QUICK is
 * still doctrine's, the engine answers `legacy` over the live rows. The flip
 * touches nothing else — the vocabulary, the document and the order are the
 * production ones.
 */
function signalRow(): FlowDecision {
  const row = asOwned(decisionsOfScope("quick")).find(
    (entry) => entry.id === "quick.entry-gate-signal",
  );
  if (row === undefined) throw new Error("falta la fila que declara las señales de QUICK");
  return row;
}

describe("vocabulario de señales — una sola fuente, verificada en dos direcciones", () => {
  it("toda señal que una transición admite está declarada en el manifiesto del bundle", () => {
    const declared = new Set(Object.keys(manifest.flowSignals));
    const orphans: string[] = [];
    for (const decision of FLOW_DECISIONS) {
      for (const signal of decision.signals ?? []) {
        if (!declared.has(signal)) orphans.push(`${decision.id} → ${signal}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("toda señal declarada en el manifiesto la consume alguna transición", () => {
    const consumed = new Set(FLOW_DECISIONS.flatMap((decision) => decision.signals ?? []));
    const unused = Object.keys(manifest.flowSignals).filter((signal) => !consumed.has(signal));
    expect(unused).toEqual([]);
  });

  it("cada señal declara qué significa", () => {
    expect(Object.keys(manifest.flowSignals).length).toBeGreaterThan(0);
    for (const [id, means] of Object.entries(manifest.flowSignals)) {
      expect(means.trim().length, id).toBeGreaterThan(10);
    }
  });

  it("solo una fila de autoridad `agent` admite señales: la clasificación es del agente", () => {
    const offenders = FLOW_DECISIONS.filter(
      (decision) => (decision.signals ?? []).length > 0 && decision.authority !== "agent",
    );
    expect(offenders.map((decision) => decision.id)).toEqual([]);
  });

  it("un bundle sin flow_signals no admite ninguna señal (fail-closed, no permisivo)", () => {
    const legacy = parseManifest({
      version: 1,
      signals: { db: "the run reads or writes a database" },
      commands: { quick: { core: ["commands/quick.md"], modules: [] } },
      journeys: [{ id: "j", label: "l", command: "quick", signals: [] }],
      budget_policy: {
        discovery_max_ratio: 1,
        activation_median_max_ratio: 1,
        activation_each_max_ratio: 1,
        execution_median_max_ratio: 1,
        journey_max_ratio: 1,
      },
    });
    expect(legacy.flowSignals).toEqual({});
  });
});

describe("el pedido de la frontera semántica no lleva nada invisible", () => {
  const state = newRunState("quick", "001-p-quick");
  const request = boundaryRequest(signalRow(), state);

  it("trae contrato legible, sello de entradas, límites y read_set visible", () => {
    expect(request.contract.length).toBeGreaterThan(80);
    expect(request.input_digest).toHaveLength(64);
    expect(request.read_set).toEqual(["loops/quick-loop/LOOP.md"]);
    expect(request.limits).toEqual({ max_artifacts: 0, max_artifact_bytes: 0 });
    expect(request.metrics.request_bytes).toBeGreaterThan(0);
  });

  it("no declara ningún destino de escritura: pide un juicio, no archivos", () => {
    expect(request.allowed_destinations).toEqual([]);
  });

  it("el contrato nombra el vocabulario exacto y dice de quién es el umbral", () => {
    for (const signal of signalRow().signals ?? []) {
      expect(request.contract, signal).toContain(signal);
    }
    expect(request.contract).toContain("El umbral sobre las señales lo aplica el CLI, no vos");
  });

  it("todo lo que el pedido lleva es derivable de lo que el llamador ya ve", () => {
    // Every leaf comes from the state or the registry row — there is no field for
    // an ambient prompt, and its absence is what makes the cost auditable.
    expect(request.inventory).toEqual({
      flow: "quick",
      applied: [],
      signals: signalRow().signals,
    });
    expect(request.operation).toBe("flow.quick.entry-gate-signal");
  });
});

describe("la respuesta entra como dato y se valida antes de tocar el estado", () => {
  const state = newRunState("quick", "001-p-quick");
  const resolved = resolveBoundary(state, asOwned(decisionsOfScope("quick")));

  function answer(body: Record<string, unknown>) {
    return parseFlowAnswer({
      raw: JSON.stringify({ input_digest: resolved.seal, ...body }),
      boundary: resolved.kind,
      decision: resolved.stopped as FlowDecision,
      seal: resolved.seal,
      choices: resolved.choices,
      approval: null,
      expectedApproval: null,
    });
  }

  it("la frontera vigente de QUICK es semántica y es la que declara las señales", () => {
    expect(resolved.kind).toBe("semantic");
    expect(resolved.stopped?.id).toBe("quick.entry-gate-signal");
    expect(resolved.request?.input_digest).toBe(resolved.seal);
  });

  it("una respuesta válida sobrevive con sus señales", () => {
    const parsed = answer({ signals: ["quick.needs-architecture", "quick.two-or-more-sources"] });
    if (!parsed.ok) throw new Error(`esperaba una respuesta válida: ${parsed.failure.code}`);
    expect(parsed.answer.signals).toEqual([
      "quick.needs-architecture",
      "quick.two-or-more-sources",
    ]);
  });

  it("una señal inventada se rechaza con acción y nombra el vocabulario", () => {
    const parsed = answer({ signals: ["quick.me-parece-grande"] });
    if (parsed.ok) throw new Error("una señal fuera del vocabulario no puede pasar");
    expect(parsed.failure.code).toBe("FLOW_SIGNAL_UNKNOWN");
    expect(parsed.failure.action).toContain("quick.needs-architecture");
  });

  it("la misma señal declarada dos veces no cuenta doble: se rechaza", () => {
    const parsed = answer({ signals: ["quick.needs-architecture", "quick.needs-architecture"] });
    if (parsed.ok) throw new Error("una señal repetida no puede pasar");
    expect(parsed.failure.code).toBe("FLOW_ANSWER_INVALID");
  });

  it("una respuesta que solo trae decisiones también sirve", () => {
    const parsed = answer({ decisions: { forma: "una sola spec" } });
    if (!parsed.ok) throw new Error("una respuesta con decisiones es válida");
    expect(parsed.answer.decisions).toEqual({ forma: "una sola spec" });
    expect(parsed.answer.signals).toEqual([]);
  });
});
