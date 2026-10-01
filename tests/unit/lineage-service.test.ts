import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { appendCutIntent } from "../../src/application/cut-intent-ledger.js";
import {
  type LineageContext,
  lineageOfPlan,
  lineageOfSpec,
  readLineageContext,
} from "../../src/application/lineage-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { declarePass, recordArrival } from "../../src/application/release-pass-ledger.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const CLI = "agent-workflow-cli";
const UI = "ui-spec-generator";

/**
 * Where a document comes from, and where it stands.
 *
 * The provenance graph already walked both directions; what it could not say was
 * the grouping a person meant and whether the work shipped. The fixture is the
 * shape the plan names: one cut of three plans split between two passes, plus a
 * plan closed before the record existed — the case whose only honest answer is
 * that there is no record.
 */
describe("lineage service", () => {
  let hub: string;
  let paths: PathsService;
  let env: FakeEnv;
  let fs: NodeFileSystem;

  function spec(number: string, slug: string): void {
    writeFileSync(
      join(hub, "docs", "specs", `${number}-spec-${slug}.md`),
      `---\nstatus: ready-for-plan\n---\n\n# Spec ${number}\n`,
    );
  }

  function plan(number: string, slug: string, from: string, fromSlug: string): void {
    writeFileSync(
      join(hub, "docs", "plans", `${number}-plan-${slug}.md`),
      [
        `# Plan ${number}`,
        "",
        `> Derived from docs/specs/${from}-spec-${fromSlug}.md`,
        "> Estado: open",
        "> Límite de ejecución: checkout",
        "",
        "## Tasks",
        "",
        "### F1 — algo",
        "",
        "> Estado: pendiente",
        "> Fuentes: agent-workflow-cli",
        "",
      ].join("\n"),
    );
  }

  beforeEach(async () => {
    hub = mkdtempSync(join(tmpdir(), "lineage-"));
    mkdirSync(join(hub, "docs", "specs"), { recursive: true });
    mkdirSync(join(hub, "docs", "plans"), { recursive: true });
    mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
    paths = new PathsService(normalizeNamespace("workflow"), hub, hub);
    env = new FakeEnv(hub, hub);
    fs = new NodeFileSystem();

    spec("090", "corte");
    plan("091", "uno", "090", "corte");
    plan("092", "dos", "090", "corte");
    plan("093", "tres", "090", "corte");
    // Closed long before any of this existed: no pass ever named it.
    spec("079", "vieja");
    plan("080", "antigua", "079", "vieja");

    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: {
        spec: { kind: "spec", key: "090" },
        order: [
          { kind: "plan", key: "091" },
          { kind: "plan", key: "092" },
        ],
        deferred: [{ kind: "plan", key: "093" }],
      },
    });
    await declarePass(fs, paths, {
      at: "2026-09-14T11:00:00.000Z",
      pass: {
        version: "v1.0.0",
        plans: [
          { kind: "plan", key: "091" },
          { kind: "plan", key: "092" },
        ],
        sources: [CLI],
      },
    });
    await recordArrival(fs, paths, {
      at: "2026-09-14T12:00:00.000Z",
      passVersion: "v1.0.0",
      arrival: { source: CLI, kind: "published-version", detail: "1.0.0", at: "2026-09-14" },
    });
    // The second pass carries the deferred plan and has NOT fully arrived.
    await declarePass(fs, paths, {
      at: "2026-09-14T13:00:00.000Z",
      pass: { version: "v2.0.0", plans: [{ kind: "plan", key: "093" }], sources: [CLI, UI] },
    });
    await recordArrival(fs, paths, {
      at: "2026-09-14T14:00:00.000Z",
      passVersion: "v2.0.0",
      arrival: { source: CLI, kind: "published-version", detail: "2.0.0", at: "2026-09-14" },
    });
  });

  afterEach(() => {
    rmSync(hub, { recursive: true, force: true });
  });

  async function context(): Promise<LineageContext> {
    return await readLineageContext({ fs, env, paths });
  }

  it("dado un plan trae su spec de origen, sus dos hermanos y el pase de cada uno", async () => {
    const lineage = lineageOfPlan(await context(), { kind: "plan", key: "091" });

    expect(lineage.spec?.id).toBe("spec:090");
    expect(lineage.spec?.evidence).toBe("derived-from");
    expect(lineage.siblings.map((s) => s.plan)).toEqual(["plan:092", "plan:093"]);
    expect(lineage.siblings[0]).toMatchObject({ placement: "in-pass", index: 1 });
    expect(lineage.siblings[0]?.production).toEqual({
      axis: "in-production",
      pass: "v1.0.0",
      at: "2026-09-14",
    });
    expect(lineage.siblings[1]).toMatchObject({ placement: "deferred" });
    expect(lineage.siblings[1]?.production).toEqual({
      axis: "pending-pass",
      pass: "v2.0.0",
      missing: [UI],
      reverted: false,
    });
  });

  it("dada la spec trae los tres planes y el orden declarado", async () => {
    const lineage = lineageOfSpec(await context(), { kind: "spec", key: "090" });

    expect(lineage.plans.map((p) => p.plan).sort()).toEqual(["plan:091", "plan:092", "plan:093"]);
    expect(lineage.declared?.order).toEqual(["plan:091", "plan:092"]);
    expect(lineage.declared?.deferred).toEqual(["plan:093"]);
  });

  it("el recorrido va en las dos direcciones desde una sola derivación", async () => {
    const ctx = await context();
    const fromPlan = lineageOfPlan(ctx, { kind: "plan", key: "092" });
    const fromSpec = lineageOfSpec(ctx, { kind: "spec", key: "090" });

    expect(fromPlan.spec?.id).toBe("spec:090");
    expect(fromSpec.plans.some((p) => p.plan === "plan:092")).toBe(true);
  });

  it("el plan anterior al registro responde sin registro, ni liberado ni pendiente", async () => {
    const lineage = lineageOfPlan(await context(), { kind: "plan", key: "080" });

    expect(lineage.production).toEqual({ axis: "no-record" });
    expect(lineage.production.axis).not.toBe("in-production");
    expect(lineage.production.axis).not.toBe("pending-pass");
    // And nobody declared a cut that names it: an explicit answer, not a list.
    expect(lineage.cut.declared).toBe(false);
    expect(lineage.siblings).toEqual([]);
  });

  it("la spec anterior al registro tampoco se lee como pendiente", async () => {
    const lineage = lineageOfSpec(await context(), { kind: "spec", key: "079" });
    expect(lineage.production).toEqual({ axis: "no-record" });
    expect(lineage.declared).toBeNull();
  });

  it("una spec con un plan liberado y otro pendiente queda pendiente, no en producción", async () => {
    const lineage = lineageOfSpec(await context(), { kind: "spec", key: "090" });
    expect(lineage.production).toEqual({
      axis: "pending-pass",
      pass: "v2.0.0",
      missing: [UI],
      reverted: false,
    });
  });

  it("el tablero lleva el eje de producción de cada documento, junto al de cierre y sin alterarlo", async () => {
    const index = await buildWorklineIndex(fs, env, paths);
    const byNumber = new Map(index.plans.map((plan) => [plan.number, plan]));

    expect(byNumber.get("091")?.production).toEqual({
      axis: "in-production",
      pass: "v1.0.0",
      at: "2026-09-14",
    });
    expect(byNumber.get("093")?.production).toEqual({
      axis: "pending-pass",
      pass: "v2.0.0",
      missing: [UI],
      reverted: false,
    });
    expect(byNumber.get("080")?.production).toEqual({ axis: "no-record" });
    // The closure axis answers exactly what it answered before: every one of
    // these plans is open, and being in production did not change that.
    expect(byNumber.get("091")?.plan_state).toBe("open");
    expect(byNumber.get("080")?.plan_state).toBe("open");

    const specs = new Map(index.specs.map((spec) => [spec.number, spec]));
    expect(specs.get("090")?.production.axis).toBe("pending-pass");
    expect(specs.get("079")?.production).toEqual({ axis: "no-record" });
  });

  it("un plan que la intención no menciona conserva su linaje probado", async () => {
    // 080 descends from 079 by the same provable edge, with no cut in sight: the
    // grouping is declared and the descent is proven, and one missing never
    // erases the other.
    const lineage = lineageOfPlan(await context(), { kind: "plan", key: "080" });
    expect(lineage.spec?.id).toBe("spec:079");
    expect(lineage.spec?.evidence).toBe("derived-from");
  });
});
