import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  appendCutIntent,
  currentIntentForPlan,
  currentIntentOf,
  cutIntentLedgerPath,
  readCutIntents,
  readingForPlan,
} from "../../src/application/cut-intent-ledger.js";
import { PathsService } from "../../src/application/paths-service.js";
import { CutIntentError, positionOf } from "../../src/domain/cut-intent.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const SPEC = { kind: "spec", key: "045" } as const;
const P1 = { kind: "plan", key: "051" } as const;
const P2 = { kind: "plan", key: "052" } as const;
const P3 = { kind: "plan", key: "053" } as const;

/**
 * The intent with which a cut was meant to be executed.
 *
 * The workspace could already prove which plans descend from which spec. What it
 * could not say is the part only a person knows: which of them go together, in
 * what order, and which were held back on purpose. Without that the only order on
 * offer was the correlative — an accident of minting presented as a decision.
 */
describe("cut intent ledger", () => {
  let hub: string;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    hub = mkdtempSync(join(tmpdir(), "cut-intent-"));
    paths = new PathsService(normalizeNamespace("workflow"), hub, hub);
    fs = new NodeFileSystem();
  });

  afterEach(() => {
    rmSync(hub, { recursive: true, force: true });
  });

  it("declara un corte con dos planes juntos y un tercero reservado, y lo devuelve completo", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1, P2], deferred: [P3] },
      cause: "los dos primeros entran en el pase en curso",
    });

    const read = await readCutIntents(fs, paths);
    const current = currentIntentOf(read.events, SPEC);

    expect(read.unreadable).toBe(0);
    expect(current?.intent.order.map((n) => n.key)).toEqual(["051", "052"]);
    expect(current?.intent.deferred.map((n) => n.key)).toEqual(["053"]);
    expect(current?.cause).toBe("los dos primeros entran en el pase en curso");
  });

  it("el libro vive bajo el namespace del workspace, no en docs/", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1], deferred: [] },
    });

    const path = cutIntentLedgerPath(paths);
    expect(path).toBe(join(hub, ".workflow", "cut-intents.jsonl"));
    expect(path).not.toContain(`${join("", "docs")}`);
  });

  /**
   * AC-16's real evidence: a DIFFERENT process reads the file back.
   *
   * Asserting through the same in-memory objects that wrote it would prove only
   * that the code is self-consistent. What has to hold is that the intent is
   * durable workspace state — so the reader here is a separate `node`, and all it
   * is given is the path.
   */
  it("se relee desde un proceso distinto del que lo escribió", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1, P2], deferred: [P3] },
    });

    const path = cutIntentLedgerPath(paths);
    const script = `
      const { readFileSync } = require("node:fs");
      const events = readFileSync(process.argv[1], "utf8")
        .split("\\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
      const last = events[events.length - 1];
      process.stdout.write(JSON.stringify({
        records: events.length,
        spec: last.intent.spec.key,
        order: last.intent.order.map((n) => n.key),
        deferred: last.intent.deferred.map((n) => n.key),
      }));
    `;
    const out = execFileSync(process.execPath, ["-e", script, path], { encoding: "utf8" });

    expect(JSON.parse(out)).toEqual({
      records: 1,
      spec: "045",
      order: ["051", "052"],
      deferred: ["053"],
    });
  });

  it("corregir es declarar de nuevo: vale el último y el archivo conserva los dos eventos", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1, P2], deferred: [P3] },
    });
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T11:00:00.000Z",
      intent: { spec: SPEC, order: [P2, P1], deferred: [P3] },
      cause: "052 desbloquea a 051",
    });

    const read = await readCutIntents(fs, paths);
    const current = currentIntentOf(read.events, SPEC);

    expect(read.events).toHaveLength(2);
    expect(current?.intent.order.map((n) => n.key)).toEqual(["052", "051"]);
    // The superseded record is still on disk, byte for byte: that is what makes a
    // reorder reviewable instead of merely inherited.
    const lines = readFileSync(cutIntentLedgerPath(paths), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").intent.order.map((n: { key: string }) => n.key)).toEqual([
      "051",
      "052",
    ]);
  });

  it("un plan no declarado recibe una respuesta explícita, distinguible de una lista vacía", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1], deferred: [] },
    });

    const read = await readCutIntents(fs, paths);
    const reading = readingForPlan(read, { kind: "plan", key: "099" });

    expect(reading.declared).toBe(false);
    if (reading.declared)
      throw new Error("un plan que nadie declaró no puede leerse como declarado");
    expect(reading.reason).toContain("plan:099");
    // The point of the explicit answer: nothing here is an empty list a caller
    // could fill with the correlative and present as somebody's decision.
    expect(Object.hasOwn(reading, "intent")).toBe(false);
  });

  it("con el libro sin declarar nada, la respuesta sigue siendo explícita y nunca inventa un orden", async () => {
    const read = await readCutIntents(fs, paths);
    const reading = readingForPlan(read, P1);

    expect(read.events).toEqual([]);
    expect(reading.declared).toBe(false);
    if (reading.declared) throw new Error("un libro vacío no declara nada");
    expect(reading.reason).toContain("nadie declaró");
  });

  it("una línea ilegible no se lee como ausencia de intención", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1], deferred: [] },
    });
    writeFileSync(cutIntentLedgerPath(paths), "{ esto no es json\n", { flag: "a" });

    const read = await readCutIntents(fs, paths);
    const reading = readingForPlan(read, P3);

    expect(read.unreadable).toBe(1);
    expect(read.events).toHaveLength(1);
    if (reading.declared) throw new Error("plan:053 no está declarado en este libro");
    // "No aparece" and "cannot be proven not to appear" are different answers, and
    // only the second one warns the reader that the file is damaged.
    expect(reading.reason).toContain("no se pueden leer");
  });

  it("ubica cada plan del corte: en el pase con su índice, o postergado con lo que espera", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1, P2], deferred: [P3] },
    });

    const read = await readCutIntents(fs, paths);
    const first = readingForPlan(read, P1);
    const held = readingForPlan(read, P3);

    if (!first.declared || !held.declared) throw new Error("los tres planes están declarados");
    expect(first.position).toEqual({ placement: "in-pass", index: 0 });
    expect(held.position).toEqual({ placement: "deferred", after: [P1, P2] });
  });

  it("encuentra el corte vigente que nombra a un plan, sin que el usuario sepa de qué spec nace", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1, P2], deferred: [P3] },
    });

    const read = await readCutIntents(fs, paths);
    expect(currentIntentForPlan(read.events, P2)?.intent.spec.key).toBe("045");
    expect(currentIntentForPlan(read.events, { kind: "plan", key: "099" })).toBeNull();
  });

  it("un plan que la corrección sacó del corte deja de estar declarado", async () => {
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      intent: { spec: SPEC, order: [P1, P2], deferred: [P3] },
    });
    await appendCutIntent(fs, paths, {
      at: "2026-09-14T11:00:00.000Z",
      intent: { spec: SPEC, order: [P1], deferred: [] },
      cause: "052 y 053 salen de este corte",
    });

    const read = await readCutIntents(fs, paths);
    const reading = readingForPlan(read, P2);

    // The superseded record still names 052, and it must not answer for it: the
    // record in force is the only one that says where a plan is today.
    expect(read.events).toHaveLength(2);
    expect(reading.declared).toBe(false);
  });

  it("rechaza antes de escribir lo que el libro no podría corregir", async () => {
    await expect(
      appendCutIntent(fs, paths, {
        at: "2026-09-14T10:00:00.000Z",
        intent: { spec: SPEC, order: [P1], deferred: [P1] },
      }),
    ).rejects.toBeInstanceOf(CutIntentError);
    await expect(
      appendCutIntent(fs, paths, {
        at: "2026-09-14T10:00:00.000Z",
        intent: { spec: SPEC, order: [], deferred: [] },
      }),
    ).rejects.toBeInstanceOf(CutIntentError);
    await expect(
      appendCutIntent(fs, paths, {
        at: "2026-09-14T10:00:00.000Z",
        intent: { spec: P1, order: [P2], deferred: [] },
      }),
    ).rejects.toBeInstanceOf(CutIntentError);

    // Nothing reached the file: refusing after the append would leave a record
    // that can only be buried, never fixed.
    const read = await readCutIntents(fs, paths);
    expect(read.events).toEqual([]);
  });

  it("un plan que el corte declarado no menciona se distingue de uno postergado", async () => {
    const intent = { spec: SPEC, order: [P1], deferred: [P2] };
    expect(positionOf(intent, P3)).toEqual({ placement: "unmentioned" });
    expect(positionOf(intent, P2)).toEqual({ placement: "deferred", after: [P1] });
  });
});
