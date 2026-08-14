import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runContextBudget } from "../../src/application/context/budget-service.js";
import {
  type ContextManifest,
  loadManifest,
  parseManifest,
} from "../../src/application/context/manifest.js";
import { median, resolveReadSet } from "../../src/application/context/measure.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLE_ROOT = join(REPO_ROOT, "skills", "w");
const BASELINE_PATH = join(REPO_ROOT, "tests", "fixtures", "context-baseline.json");
const CORPUS_PATH = join(REPO_ROOT, "tests", "fixtures", "context-corpus.json");

const fs = new NodeFileSystem();

interface Corpus {
  hard_floor_cases: Record<string, { why: string; any_of: string[] }>;
  journeys: { id: string; read_set: string[]; hard_floor: string[] }[];
}

async function readCorpus(): Promise<Corpus> {
  return JSON.parse(await readFile(CORPUS_PATH, "utf8")) as Corpus;
}

describe("context measurement — the instrument the gates read", () => {
  // F1's phase proof. Before this round the six per-flow figures lived as
  // hand-typed numbers in G1's comment history; a measurement that reproduces
  // them from the tree is what turns that ceiling into a budget.
  // The six figures the retired per-flow ceiling declared, from its own comment
  // history. They are an INDEPENDENT source: a table maintained by hand, over
  // years, by a mechanism that is not this one. The frozen baseline reproducing
  // all six to the byte is what says the instrument measures the same thing the
  // doctrine always meant — and, being an assertion about a frozen file, it
  // stays true after the split moves the live figures.
  const CEILING_AS_DECLARED: Readonly<Record<string, number>> = {
    quick: 48_882,
    "spec-new": 13_769,
    "spec-refine": 60_461,
    "plan-new": 53_535,
    "plan-refine": 74_476,
    "plan-exec": 63_351,
  };

  it("the frozen baseline reproduces every figure the retired ceiling declared", async () => {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
    const measured = new Map<string, number>(
      baseline.guaranteed.map((g: { command: string; bytes: number }) => [g.command, g.bytes]),
    );
    for (const [command, declared] of Object.entries(CEILING_AS_DECLARED)) {
      expect(measured.get(command), command).toBe(declared);
    }
  });

  it("budgets all 18 commands, not just the 6 flows the ceiling covered", async () => {
    const result = await runContextBudget(fs, { root: BUNDLE_ROOT });
    expect(result.guaranteed).toHaveLength(18);
    // The ten commands with no loop were never budgeted before: their guaranteed
    // load is their own body, and that is now a line like any other.
    const status = result.guaranteed.find((g) => g.command === "status");
    expect(status?.files).toEqual(["commands/status.md"]);
  });

  it("measures the three tramos against the frozen baseline", async () => {
    const result = await runContextBudget(fs, {
      root: BUNDLE_ROOT,
      baselinePath: BASELINE_PATH,
    });
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
    expect(result.discovery.bytes).toBeLessThanOrEqual(baseline.discovery.bytes);
    expect(result.activation.entries).toHaveLength(18);
    expect(result.execution.journeys).toHaveLength(6);
  });

  it("el bundle vivo respeta CADA techo de ratio, no solo el baseline", async () => {
    // Hasta ahora nada aseveraba el techo: el test de arriba compara contra el
    // BASELINE, que es ~33 % más laxo que el target derivado. Así el árbol podía
    // pasar de su presupuesto real y solo un `aw context-budget` a mano lo veía.
    // Evidencia de T9.5 del plan 012: el MANIFEST creció y sigue cumpliendo.
    const result = await runContextBudget(fs, {
      root: BUNDLE_ROOT,
      baselinePath: BASELINE_PATH,
    });
    expect(result.offenders).toEqual([]);
    expect(result.verdict).toBe("ok");
  });

  it("declares tokens unavailable instead of inventing an equivalence with bytes", async () => {
    const result = await runContextBudget(fs, { root: BUNDLE_ROOT });
    expect(result.tokens.available).toBe(false);
    expect(result.tokens.reason).toMatch(/bytes/);
  });

  it("identifies the measured tree, so a baseline cannot silently describe another bundle", async () => {
    const result = await runContextBudget(fs, { root: BUNDLE_ROOT });
    expect(result.revision.content_digest).toMatch(/^[0-9a-f]{16}$/);
    expect(result.revision.file_count).toBeGreaterThan(40);
  });

  it("derives absolute targets from the baseline instead of reading a written figure", async () => {
    const result = await runContextBudget(fs, {
      root: BUNDLE_ROOT,
      baselinePath: BASELINE_PATH,
    });
    const line = (metric: string) => result.budget.find((b) => b.metric === metric);
    // -30% discovery / -40% median activation / -25% median execution: the
    // ratios live in the manifest, the absolutes are computed here every run.
    expect(line("discovery")?.target).toBe(Math.floor((line("discovery")?.baseline ?? 0) * 0.7));
    expect(line("activation.median")?.target).toBe(
      Math.floor((line("activation.median")?.baseline ?? 0) * 0.6),
    );
    expect(line("execution.median")?.target).toBe(
      Math.floor((line("execution.median")?.baseline ?? 0) * 0.75),
    );
  });

  it("fails loudly on a root that is not a bundle rather than measuring nothing", async () => {
    await expect(runContextBudget(fs, { root: join(REPO_ROOT, "src") })).rejects.toThrow(
      /no es un bundle/,
    );
  });
});

describe("context median — one rounding rule, everywhere", () => {
  it("takes the middle of an odd series", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("floors the mean of the two central values of an even series", () => {
    expect(median([1, 2, 3, 4])).toBe(2);
    expect(median([48_882, 53_535])).toBe(51_208);
  });

  it("answers zero for an empty series instead of NaN", () => {
    expect(median([])).toBe(0);
  });
});

describe("context manifest — the bundle describes its own graph", () => {
  const base = {
    version: 1,
    signals: { db: "the journey touches a database" },
    commands: { quick: { core: ["commands/quick.md"], modules: [] } },
    journeys: [{ id: "q", label: "Q", command: "quick", signals: [] }],
    budget_policy: {
      discovery_max_ratio: 0.7,
      activation_median_max_ratio: 0.6,
      activation_each_max_ratio: 0.8,
      execution_median_max_ratio: 0.75,
      journey_max_ratio: 1.05,
    },
  };

  it("loads the real bundle manifest", async () => {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    expect(Object.keys(manifest.commands)).toHaveLength(18);
    expect(manifest.journeys).toHaveLength(6);
  });

  it("refuses a schema version it cannot read instead of guessing", () => {
    expect(() => parseManifest({ ...base, version: 99 })).toThrow(/no soportada/);
  });

  it("refuses a module whose signal was never declared", () => {
    expect(() =>
      parseManifest({
        ...base,
        commands: {
          quick: { core: ["commands/quick.md"], modules: [{ path: "m.md", signal: "ghost" }] },
        },
      }),
    ).toThrow(/no está declarada en signals/);
  });

  it("refuses a journey pointing at a command the manifest does not carry", () => {
    expect(() =>
      parseManifest({
        ...base,
        journeys: [{ id: "x", label: "X", command: "ghost", signals: [] }],
      }),
    ).toThrow(/no existe en commands/);
  });

  it("refuses a command with an empty core: everything loads at least its own body", () => {
    expect(() =>
      parseManifest({ ...base, commands: { quick: { core: [], modules: [] } } }),
    ).toThrow(/core vacío/);
  });

  it("every command in the manifest names a document the bundle actually carries", async () => {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    const missing: string[] = [];
    for (const [name, entry] of Object.entries(manifest.commands)) {
      for (const rel of [...entry.core, ...entry.modules.map((m) => m.path)]) {
        if (!(await fs.exists(join(BUNDLE_ROOT, rel)))) missing.push(`${name} → ${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every command doc in the bundle is declared in the manifest", async () => {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    const entries = await fs.list(join(BUNDLE_ROOT, "commands"));
    const onDisk = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== "README.md")
      .map((e) => e.name.slice(0, -".md".length))
      .sort();
    expect(Object.keys(manifest.commands).sort()).toEqual(onDisk);
  });
});

describe("read-set resolution — a half-updated bundle degrades, it never fails", () => {
  const manifest: ContextManifest = parseManifest({
    version: 1,
    signals: { db: "database", ui: "user interface" },
    commands: {
      quick: {
        core: ["commands/quick.md", "loops/CHASSIS.md"],
        modules: [
          { path: "modules/db.md", signal: "db" },
          { path: "modules/ui.md", signal: "ui" },
        ],
      },
    },
    journeys: [{ id: "q", label: "Q", command: "quick", signals: [] }],
    budget_policy: {
      discovery_max_ratio: 0.7,
      activation_median_max_ratio: 0.6,
      activation_each_max_ratio: 0.8,
      execution_median_max_ratio: 0.75,
      journey_max_ratio: 1.05,
    },
  });

  it("returns the core alone when no signal was observed", () => {
    const set = resolveReadSet(manifest, "quick", []);
    expect(set.paths).toEqual(["commands/quick.md", "loops/CHASSIS.md"]);
    expect(set.degraded).toBe(false);
  });

  it("adds a module only when its signal appears, and after the core", () => {
    const set = resolveReadSet(manifest, "quick", ["db"]);
    expect(set.paths).toEqual(["commands/quick.md", "loops/CHASSIS.md", "modules/db.md"]);
    expect(set.paths).not.toContain("modules/ui.md");
  });

  it("returns the full profile, marked degraded, for a signal this bundle does not know", () => {
    const set = resolveReadSet(manifest, "quick", ["telepathy"]);
    expect(set.paths).toContain("modules/db.md");
    expect(set.paths).toContain("modules/ui.md");
    expect(set.degraded).toBe(true);
    expect(set.reasons.join(" ")).toMatch(/telepathy/);
  });

  it("degrades on an unknown command instead of throwing at the caller", () => {
    const set = resolveReadSet(manifest, "ghost", []);
    expect(set.degraded).toBe(true);
    expect(set.paths).toEqual([]);
  });
});

describe("context corpus — what each representative journey must load and keep guaranteeing", () => {
  it("the resolver returns exactly the read-set the corpus freezes", async () => {
    const [manifest, corpus] = await Promise.all([loadManifest(fs, BUNDLE_ROOT), readCorpus()]);
    const journeys = new Map(manifest.journeys.map((j) => [j.id, j]));
    for (const expected of corpus.journeys) {
      const journey = journeys.get(expected.id);
      expect(journey, `manifest lacks journey ${expected.id}`).toBeDefined();
      if (journey === undefined) continue;
      const set = resolveReadSet(manifest, journey.command, journey.signals);
      expect(set.paths, expected.id).toEqual(expected.read_set);
      expect(set.degraded, expected.id).toBe(false);
    }
  });

  it("every hard-floor case a journey covered is still present in what it loads", async () => {
    const [manifest, corpus] = await Promise.all([loadManifest(fs, BUNDLE_ROOT), readCorpus()]);
    const journeys = new Map(manifest.journeys.map((j) => [j.id, j]));
    const offenders: string[] = [];
    for (const expected of corpus.journeys) {
      const journey = journeys.get(expected.id);
      if (journey === undefined) continue;
      const set = resolveReadSet(manifest, journey.command, journey.signals);
      const loaded = (
        await Promise.all(set.paths.map((rel) => readFile(join(BUNDLE_ROOT, rel), "utf8")))
      ).join("\n");
      for (const id of expected.hard_floor) {
        const markers = corpus.hard_floor_cases[id]?.any_of ?? [];
        if (!markers.some((marker) => loaded.includes(marker))) {
          offenders.push(`${expected.id} lost the '${id}' hard-floor case`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the corpus covers every journey the manifest declares", async () => {
    const [manifest, corpus] = await Promise.all([loadManifest(fs, BUNDLE_ROOT), readCorpus()]);
    expect(corpus.journeys.map((j) => j.id).sort()).toEqual(
      manifest.journeys.map((j) => j.id).sort(),
    );
  });
});

describe("hard floor — present in the compact profile AND in the fallback", () => {
  // Spec 009's criterion is explicit that both profiles keep it. The compact
  // case is covered above; this is the fallback, where the read-set is the FULL
  // profile. It is not implied by the compact result: a future round could move
  // a floor rule into a module and leave the core short, and only this catches
  // the asymmetry.
  it("the safe profile of every journey still covers what the corpus froze", async () => {
    const [manifest, corpus] = await Promise.all([loadManifest(fs, BUNDLE_ROOT), readCorpus()]);
    const journeys = new Map(manifest.journeys.map((j) => [j.id, j]));
    const offenders: string[] = [];
    for (const expected of corpus.journeys) {
      const journey = journeys.get(expected.id);
      if (journey === undefined) continue;
      // The fallback: core plus EVERY module, which is what widening returns.
      const entry = manifest.commands[journey.command];
      const paths = [...(entry?.core ?? []), ...(entry?.modules ?? []).map((m) => m.path)];
      const loaded = (
        await Promise.all(paths.map((rel) => readFile(join(BUNDLE_ROOT, rel), "utf8")))
      ).join("\n");
      for (const id of expected.hard_floor) {
        const markers = corpus.hard_floor_cases[id]?.any_of ?? [];
        if (!markers.some((marker) => loaded.includes(marker))) {
          offenders.push(`${expected.id} (safe profile) lost the '${id}' hard-floor case`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the five loop commands keep their inline hard-floor block in the core", async () => {
    // G7's invariant, restated against the CORE specifically: the block that
    // survives when a model reads nothing else must not have moved to a module.
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    for (const command of ["quick", "spec-refine", "plan-new", "plan-refine", "plan-exec"]) {
      const core = manifest.commands[command]?.core ?? [];
      const body = await readFile(join(BUNDLE_ROOT, core[0] ?? ""), "utf8");
      expect(body, command).toContain(
        "Hard floor — applies even if you read nothing beyond this file",
      );
      expect(body, command).toContain("--objetivo");
      expect(body, command).toContain("user's language");
    }
  });
});

describe("baseline honesty — two freeze points, two stamps, never mixed", () => {
  // The pre-split half and the `modules` half were measured on DIFFERENT trees:
  // before the split there were no modules, so there is no pre-split figure to
  // compare them against. One `revision` stamp covering both would claim a
  // 53-file tree produced a measurement of the 81-file one.
  it("the modules baseline carries the stamp of the tree it was measured on", async () => {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
    expect(baseline.revision.content_digest).not.toBe(baseline.modules.revision.content_digest);
    expect(baseline.modules.revision.file_count).toBeGreaterThan(baseline.revision.file_count);
    // And the file says why, so a reader never has to infer it.
    expect(baseline.$comment).toMatch(/DOS congelados con DOS revisiones/);
    expect(baseline.$comment).toMatch(/CRECIMIENTO/);
  });

  it("the modules line budgets growth and is not vacuous", async () => {
    const result = await runContextBudget(fs, {
      root: BUNDLE_ROOT,
      baselinePath: BASELINE_PATH,
    });
    const line = result.budget.find((b) => b.metric === "modules.total");
    expect(line?.baseline).toBeGreaterThan(0);
    expect(line?.target).toBe(Math.floor((line?.baseline ?? 0) * 1.05));
    // The conditional tree is real and priced: it is not an empty set that
    // passes because there is nothing in it.
    expect(result.modules.count).toBeGreaterThan(20);
    expect(result.modules.bytes).toBeGreaterThan(50_000);
  });
});
