import { describe, expect, it } from "vitest";
import {
  type HostExecutionCapability,
  decideResources,
  validateResourceUsage,
} from "../../src/domain/resource-policy.js";

const capable: HostExecutionCapability = {
  subagents: "parallel",
  max_subagents: 9,
  mechanism: "agents",
};

describe("política de recursos determinista", () => {
  it("nunca asigna modelo, subagente ni proceso externo a un tramo determinista", () => {
    expect(decideResources({ boundary: "deterministic", host: capable })).toMatchObject({
      strategy: "none",
      model_workers: 0,
      max_subagents: 0,
      max_external_processes: 0,
    });
  });

  it("mantiene el análisis inline salvo tres particiones independientes", () => {
    const inline = decideResources({
      boundary: "semantic",
      host: capable,
      partitions: [
        { id: "a", writes: [], depends_on: [] },
        { id: "b", writes: [], depends_on: [] },
      ],
    });
    expect(inline).toMatchObject({ strategy: "inline", model_workers: 1, max_subagents: 0 });

    const parallel = decideResources({
      boundary: "semantic",
      host: capable,
      partitions: [
        { id: "a", writes: ["a.md"], depends_on: [] },
        { id: "b", writes: ["b.md"], depends_on: [] },
        { id: "c", writes: [], depends_on: [] },
      ],
    });
    expect(parallel).toMatchObject({ strategy: "parallel", model_workers: 4, max_subagents: 3 });
  });

  it("rechaza paralelismo con dependencia o escrituras superpuestas", () => {
    for (const partitions of [
      [
        { id: "a", writes: ["same"], depends_on: [] },
        { id: "b", writes: ["same"], depends_on: [] },
        { id: "c", writes: [], depends_on: [] },
      ],
      [
        { id: "a", writes: [], depends_on: [] },
        { id: "b", writes: [], depends_on: ["a"] },
        { id: "c", writes: [], depends_on: [] },
      ],
    ]) {
      expect(decideResources({ boundary: "semantic", host: capable, partitions }).strategy).toBe(
        "inline",
      );
    }
  });

  it("acepta sólo telemetría real y dentro del presupuesto", () => {
    const plan = decideResources({ boundary: "semantic", host: capable });
    expect(
      validateResourceUsage(plan, {
        model_workers: 1,
        subagents: 0,
        external_processes: 0,
        tokens: { status: "unavailable" },
      }),
    ).toBeNull();
    expect(
      validateResourceUsage(plan, {
        model_workers: 1,
        subagents: 0,
        external_processes: 0,
        tokens: { status: "reported", total: -1 },
      }),
    ).toContain("tokens");
  });
});
