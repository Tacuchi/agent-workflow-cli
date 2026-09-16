import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  declarePass,
  derivePasses,
  foldProduction,
  linkArtifact,
  productionStandingOf,
  readReleasePasses,
  recordApplication,
  recordArrival,
  recordReversion,
  releasePassLedgerPath,
} from "../../src/application/release-pass-ledger.js";
import { ReleasePassError } from "../../src/domain/release-pass.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const CLI = "agent-workflow-cli";
const UI = "ui-spec-generator";
const P1 = { kind: "plan", key: "044" } as const;
const P2 = { kind: "plan", key: "045" } as const;

/**
 * A pass to production, as its own object.
 *
 * The workspace could say a plan was CLOSED, and closed is not released. With one
 * of two sources arrived, neither "open" nor "released" is true — and both of
 * those answers would let the work of the source that did not arrive read as
 * shipped, which is the exact failure this record exists to prevent.
 */
describe("release pass ledger", () => {
  let workspace: string;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "release-pass-"));
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  async function openPass(version = "v25.5.0"): Promise<void> {
    await declarePass(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      pass: { version, plans: [P1, P2], sources: [CLI, UI] },
      cause: "el corte 044+045 sale junto",
    });
  }

  it("declara un pase con su versión, sus planes y sus dos fuentes, y lo devuelve completo", async () => {
    await openPass();
    const read = await readReleasePasses(fs, paths);
    const [pass] = derivePasses(read.events);

    expect(read.unreadable).toBe(0);
    expect(pass?.pass.version).toBe("v25.5.0");
    expect(pass?.pass.plans.map((p) => p.key)).toEqual(["044", "045"]);
    expect(pass?.pass.sources).toEqual([CLI, UI]);
    expect(pass?.standing.state).toBe("open");
  });

  it("el libro vive bajo el namespace del workspace, no en docs/", async () => {
    await openPass();
    expect(releasePassLedgerPath(paths)).toBe(join(workspace, ".workflow", "release-passes.jsonl"));
  });

  it("con una sola llegada el pase es parcial, nombra las dos fuentes y no da por liberado lo que falta", async () => {
    await openPass();
    await recordArrival(fs, paths, {
      at: "2026-09-14T12:00:00.000Z",
      passVersion: "v25.5.0",
      arrival: { source: CLI, kind: "published-version", detail: "25.5.0", at: "2026-09-14" },
    });

    const read = await readReleasePasses(fs, paths);
    const [pass] = derivePasses(read.events);

    expect(pass?.standing.state).toBe("partially-released");
    expect(pass?.standing.arrived).toEqual([CLI]);
    expect(pass?.standing.missing).toEqual([UI]);
    // The decisive assertion of AC-08: with one source missing there is NO
    // reading under which the work this pass carries is in production.
    expect(productionStandingOf([pass ?? never()], P1)).toEqual({
      axis: "pending-pass",
      pass: "v25.5.0",
      missing: [UI],
      reverted: false,
    });
  });

  it("con las dos llegadas el pase queda liberado y el trabajo lee en producción", async () => {
    await openPass();
    for (const source of [CLI, UI]) {
      await recordArrival(fs, paths, {
        at: "2026-09-14T12:00:00.000Z",
        passVersion: "v25.5.0",
        arrival: {
          source,
          kind: source === CLI ? "published-version" : "production-branch",
          detail: source === CLI ? "25.5.0" : "main",
          at: "2026-09-14",
        },
      });
    }

    const passes = derivePasses((await readReleasePasses(fs, paths)).events);
    expect(passes[0]?.standing.state).toBe("released");
    expect(productionStandingOf(passes, P2)).toEqual({
      axis: "in-production",
      pass: "v25.5.0",
      at: "2026-09-14",
    });
  });

  it("la reversión conserva los dos hechos y el trabajo vuelve a contar como no liberado", async () => {
    await openPass();
    for (const source of [CLI, UI]) {
      await recordArrival(fs, paths, {
        at: "2026-09-14T12:00:00.000Z",
        passVersion: "v25.5.0",
        arrival: { source, kind: "deployment", detail: "prod", at: "2026-09-14" },
      });
    }
    await recordReversion(fs, paths, {
      at: "2026-09-14T18:00:00.000Z",
      passVersion: "v25.5.0",
      cause: "regresión en el tablero",
    });

    const read = await readReleasePasses(fs, paths);
    const passes = derivePasses(read.events);

    expect(passes[0]?.standing.state).toBe("reverted");
    // Both facts survive: the arrivals happened, and a reversion that erased them
    // would make a shipped-then-rolled-back release look like one that never
    // shipped.
    expect(passes[0]?.arrivals).toHaveLength(2);
    expect(read.events.filter((e) => e.event === "arrived")).toHaveLength(2);
    expect(read.events.filter((e) => e.event === "reverted")).toHaveLength(1);
    // Not just the axis: a reverted pass used to come back as "pending-pass"
    // with `missing: []` — "waiting on a pass" and "nothing is missing" at once,
    // which made a plan that shipped and was rolled back indistinguishable from
    // one that never started.
    expect(productionStandingOf(passes, P1)).toEqual({
      axis: "pending-pass",
      pass: "v25.5.0",
      missing: [CLI, UI],
      reverted: true,
    });
  });

  it("enlaza un artefacto por ruta y lo deja intacto: misma ruta, mismo contenido, mismo número", async () => {
    await openPass();
    const docs = join(workspace, "docs", "plans");
    mkdirSync(docs, { recursive: true });
    const relative = "docs/plans/045-plan-intencion-linaje-y-release.md";
    const absolute = join(workspace, relative);
    const original = "# Plan 045\n\n> Estado: open\n";
    writeFileSync(absolute, original);
    const before = { names: readdirSync(docs), bytes: readFileSync(absolute) };

    const result = await linkArtifact(fs, paths, {
      at: "2026-09-14T12:00:00.000Z",
      passVersion: "v25.5.0",
      artifact: relative,
    });

    const after = { names: readdirSync(docs), bytes: readFileSync(absolute) };
    expect(result).toEqual({ linked: true });
    expect(after.names).toEqual(before.names);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(derivePasses((await readReleasePasses(fs, paths)).events)[0]?.artifacts).toEqual([
      relative,
    ]);
  });

  it("no enlaza una ruta que no existe, y no escribe nada al negarse", async () => {
    await openPass();
    const result = await linkArtifact(fs, paths, {
      at: "2026-09-14T12:00:00.000Z",
      passVersion: "v25.5.0",
      artifact: "docs/plans/999-plan-fantasma.md",
    });

    expect(result.linked).toBe(false);
    const passes = derivePasses((await readReleasePasses(fs, paths)).events);
    expect(passes[0]?.artifacts).toEqual([]);
  });

  it("dos pases no pueden compartir nombre: la unicidad se exige al declarar", async () => {
    await openPass();
    await expect(openPass()).rejects.toBeInstanceOf(ReleasePassError);
    expect(derivePasses((await readReleasePasses(fs, paths)).events)).toHaveLength(1);
  });

  it("el orden entre pases sale de la secuencia del libro, no de comparar nombres", async () => {
    // Deliberately named so that any comparison of the strings would invert them.
    await declarePass(fs, paths, {
      at: "2026-09-14T10:00:00.000Z",
      pass: { version: "v9.0.0", plans: [P1], sources: [CLI] },
    });
    await declarePass(fs, paths, {
      at: "2026-09-14T11:00:00.000Z",
      pass: { version: "v10.0.0", plans: [P2], sources: [CLI] },
    });

    const passes = derivePasses((await readReleasePasses(fs, paths)).events);
    expect(passes.map((p) => p.pass.version)).toEqual(["v9.0.0", "v10.0.0"]);
    expect(passes.map((p) => p.sequence)).toEqual([0, 1]);
  });

  it("un plan que ningún pase lleva responde sin registro, ni liberado ni pendiente", async () => {
    await openPass();
    const passes = derivePasses((await readReleasePasses(fs, paths)).events);
    const standing = productionStandingOf(passes, { kind: "plan", key: "012" });

    expect(standing).toEqual({ axis: "no-record" });
    expect(standing.axis).not.toBe("pending-pass");
    expect(standing.axis).not.toBe("in-production");
  });

  it("se relee desde un proceso distinto del que lo escribió", async () => {
    await openPass();
    await recordArrival(fs, paths, {
      at: "2026-09-14T12:00:00.000Z",
      passVersion: "v25.5.0",
      arrival: { source: CLI, kind: "published-version", detail: "25.5.0", at: "2026-09-14" },
    });

    const script = `
      const { readFileSync } = require("node:fs");
      const events = readFileSync(process.argv[1], "utf8")
        .split("\\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
      process.stdout.write(JSON.stringify({
        records: events.length,
        kinds: events.map((e) => e.event),
        sources: events[0].pass.sources,
      }));
    `;
    const out = execFileSync(process.execPath, ["-e", script, releasePassLedgerPath(paths)], {
      encoding: "utf8",
    });

    expect(JSON.parse(out)).toEqual({
      records: 2,
      kinds: ["declared", "arrived"],
      sources: [CLI, UI],
    });
  });

  it("una línea ilegible se cuenta, no se descarta en silencio", async () => {
    await openPass();
    writeFileSync(releasePassLedgerPath(paths), "no soy json\n", { flag: "a" });

    const read = await readReleasePasses(fs, paths);
    expect(read.unreadable).toBe(1);
    expect(read.events).toHaveLength(1);
  });

  it("el pliegue falla cerrado: una parte sin registro deja al conjunto sin registro", () => {
    const live = { axis: "in-production", pass: "v1.0.0", at: "2026-09-14" } as const;
    const none = { axis: "no-record" } as const;

    // The case that used to lie: one plan released, one nobody ever declared,
    // and the spec came back "in production" although half of it never shipped.
    expect(foldProduction([live, none])).toEqual({ axis: "no-record" });
    expect(foldProduction([none, live])).toEqual({ axis: "no-record" });
    expect(foldProduction([])).toEqual({ axis: "no-record" });
  });

  it("el pliegue da en producción sólo cuando todas las partes lo están", () => {
    const a = { axis: "in-production", pass: "v1.0.0", at: "2026-09-14" } as const;
    const b = { axis: "in-production", pass: "v2.0.0", at: "2026-09-15" } as const;
    const pending = {
      axis: "pending-pass",
      pass: "v2.0.0",
      missing: [UI],
      reverted: false,
    } as const;

    expect(foldProduction([a, b]).axis).toBe("in-production");
    // One part pending makes the whole pending: a requirement is not shipped
    // while part of what implements it is not.
    expect(foldProduction([a, pending])).toEqual(pending);
  });

  it("registra que el SQL del pase corrió contra un ambiente y lo devuelve con su fecha", async () => {
    await openPass();
    const application = {
      environment: "certificación",
      detail: "el DBA corrió docs/scripts/003-export-scripts-2026-09-15",
      at: "2026-09-15",
    };
    await recordApplication(fs, paths, {
      at: "2026-09-15T09:00:00.000Z",
      passVersion: "v25.5.0",
      application,
    });

    const read = await readReleasePasses(fs, paths);
    const [pass] = derivePasses(read.events);

    // A well-formed application is a record like any other: counting it as
    // unreadable would make SQL that already ran look pending.
    expect(read.unreadable).toBe(0);
    expect(read.events.map((e) => e.event)).toEqual(["declared", "applied"]);
    expect(pass?.applications).toEqual([application]);
    expect(pass?.application).toEqual({ axis: "applied", environments: ["certificación"] });
  });

  it("un pase sin ninguna constancia lee sin registro, que no es «nada aplicado»", async () => {
    await openPass();
    const [pass] = derivePasses((await readReleasePasses(fs, paths)).events);

    expect(pass?.application).toEqual({ axis: "no-record" });
    expect(pass?.application.axis).not.toBe("applied");
  });

  it("la constancia de aplicación no mueve el eje de llegada a producción", async () => {
    await openPass();
    await recordArrival(fs, paths, {
      at: "2026-09-14T12:00:00.000Z",
      passVersion: "v25.5.0",
      arrival: { source: CLI, kind: "published-version", detail: "25.5.0", at: "2026-09-14" },
    });
    const before = derivePasses((await readReleasePasses(fs, paths)).events)[0];

    for (const environment of ["certificación", "producción"]) {
      await recordApplication(fs, paths, {
        at: "2026-09-15T09:00:00.000Z",
        passVersion: "v25.5.0",
        application: { environment, detail: `bundle 003 en ${environment}`, at: "2026-09-15" },
      });
    }
    const after = derivePasses((await readReleasePasses(fs, paths)).events)[0];

    // The assertion this phase exists to pin: the release axis is derived by
    // crossing arrivals against the pass's CODE sources, and an environment is
    // not one of them. Had the environment entered as a fourth ArrivalKind
    // reusing `source`, this pass would read released with `ui-spec-generator`
    // still missing.
    expect(after?.standing).toEqual(before?.standing);
    expect(after?.standing.state).toBe("partially-released");
    expect(after?.standing.arrived).toEqual([CLI]);
    expect(after?.standing.missing).toEqual([UI]);
    expect(productionStandingOf([after ?? never()], P1)).toEqual({
      axis: "pending-pass",
      pass: "v25.5.0",
      missing: [UI],
      reverted: false,
    });
    // And the environments land on their own axis, in ledger order.
    expect(after?.application).toEqual({
      axis: "applied",
      environments: ["certificación", "producción"],
    });
  });

  it("una llegada contra un pase que nadie declaró no inventa un pase", async () => {
    await recordArrival(fs, paths, {
      at: "2026-09-14T12:00:00.000Z",
      passVersion: "v0.0.0",
      arrival: { source: CLI, kind: "published-version", detail: "0.0.0", at: "2026-09-14" },
    });

    expect(derivePasses((await readReleasePasses(fs, paths)).events)).toEqual([]);
  });
});

function never(): never {
  throw new Error("el pase declarado tiene que existir");
}
