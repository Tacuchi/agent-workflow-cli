// Comparing host runs (plan 085, T2.4, AC-05/06/07): cell-by-cell regressions
// between two runs, and the closure check with the last observation per cell.
// Only sample matrices are used: no suite test depends on the latest real run.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNS_DIR,
  closure,
  closureFailures,
  lastObservations,
  mergedRunBlocks,
  regressions,
} from "../../scripts/host-run/compare.mjs";
import { catalogStates } from "../../scripts/host-run/matrix.mjs";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

const SAMPLES = join(RUNS_DIR, "samples");
const sample = (id: string) => JSON.parse(readFileSync(join(SAMPLES, id, "matrix.json"), "utf8"));
const BASE = "2026-09-01T10-00-00Z";
const WORSE = "2026-09-15T10-00-00Z";
const PARTIAL = "2026-09-16T10-00-00Z";
const SUBSET = "2026-09-17T10-00-00Z";

/** A cell of `matrix` turned broken: the run observed it failing. */
function breakCell(matrix: ReturnType<typeof sample>, host: string, surface: string) {
  const cell = matrix.hosts[host].cells[surface];
  matrix.hosts[host].cells[surface] = { ...cell, observed: "fails", state: "broken" };
  return matrix;
}

/** WORSE with claude-code's compaction broken: the regression the samples compare. */
const worse = () => breakCell(sample(WORSE), "claude-code", "compaction");
/** SUBSET, which repeats codex only, with codex's commands broken. */
const subset = () => breakCell(sample(SUBSET), "codex", "commands");

describe("host-run compare", () => {
  it("marks exactly the cells that got worse (works → broken)", () => {
    expect(regressions(sample(BASE), worse())).toEqual([
      { host: "claude-code", surface: "compaction", from: "works", to: "broken" },
    ]);
  });

  it("an improvement or an unchanged cell is not a regression", () => {
    expect(regressions(worse(), sample(BASE))).toEqual([]);
    expect(regressions(sample(BASE), sample(BASE))).toEqual([]);
  });

  it("a partial run's unrepeated cells say nothing", () => {
    expect(regressions(worse(), sample(PARTIAL))).toEqual([]);
  });

  it("a clean run is closed", () => {
    expect(closureFailures([sample(BASE)])).toEqual([]);
  });

  it("a broken cell keeps the matrix open, with the run it came from", () => {
    expect(closureFailures([sample(BASE), worse()])).toEqual([
      "claude-code/compaction: broken (run 2026-09-15T10-00-00Z)",
    ]);
  });

  it("the last observation of each cell wins: a partial repeat closes the broken cell", () => {
    expect(closureFailures([worse(), sample(PARTIAL)])).toEqual([]);
    const cells = lastObservations([worse(), sample(PARTIAL)]);
    expect(cells["claude-code"].compaction.run_id).toBe(PARTIAL);
    expect(cells.codex.commands.run_id).toBe(WORSE);
  });

  it("structured-choice observed only non-interactively does not close", () => {
    const run = sample(WORSE);
    run.hosts.opencode.cells["structured-choice"].mode = "non-interactive";
    expect(closureFailures([run])).toContain(
      "opencode/structured-choice: only observed non-interactively (run 2026-09-15T10-00-00Z)",
    );
    // An earlier interactive observation is kept over a later non-interactive one.
    expect(lastObservations([sample(BASE), run]).opencode["structured-choice"].mode).toBe(
      "interactive",
    );
  });

  it("a host the catalog no longer covers (kimi) says nothing about closure, even from older runs", () => {
    // The WORSE sample still has kimi covered.
    expect(sample(WORSE).hosts.kimi.covered).toBe(true);
    expect(closureFailures([sample(WORSE)]).some((f) => f.startsWith("kimi/"))).toBe(false);
    expect(lastObservations([sample(BASE), sample(WORSE)])).not.toHaveProperty("kimi");
    expect(mergedRunBlocks([sample(BASE)])).not.toHaveProperty("kimi");
  });

  it("not-reached, catalog-outdated and an undeclared degradation do not close", () => {
    const m = sample(BASE);
    m.hosts.codex.cells.commands.state = "not-reached";
    m.hosts.opencode.cells.commands.state = "catalog-outdated";
    m.hosts.opencode.cells["host-memory"].declared_by_doctor = false;
    const failures = closureFailures([m]);
    expect(failures).toContain(`codex/commands: not-reached (run ${BASE})`);
    expect(failures).toContain(`opencode/commands: catalog-outdated (run ${BASE})`);
    expect(failures).toContain(
      `opencode/host-memory: degradation not declared by /w:doctor (run ${BASE})`,
    );
  });

  it("the merged ledger view takes the latest run id and the last state per cell", () => {
    const blocks = mergedRunBlocks([worse(), sample(PARTIAL)]);
    expect(blocks["claude-code"].id).toBe(PARTIAL);
    expect(blocks["claude-code"].cells.compaction).toBe("works");
  });

  it("a host left out of a later run keeps its earlier observations", () => {
    const cells = lastObservations([sample(BASE), subset()]);
    expect(cells.opencode.commands.run_id).toBe(BASE);
    expect(cells.codex.commands.run_id).toBe(SUBSET);
    expect(regressions(sample(BASE), subset())).toEqual([
      { host: "codex", surface: "commands", from: "degraded-declared", to: "broken" },
    ]);
    const blocks = mergedRunBlocks([sample(BASE), subset()]);
    expect(blocks.opencode.id).toBe(BASE);
    expect(blocks.codex.id).toBe(SUBSET);
    expect(blocks.opencode.cells.commands).toBe("works");
  });

  it("closing is judged against the CURRENT catalog, and a catalog change is reported", () => {
    const catalog = catalogStates(HARNESSES, capabilitiesFor);
    expect(closure([sample(BASE)], catalog)).toEqual({ failures: [], drift: [] });
    // Raise codex/host-memory to native while the run saw it degraded: now broken.
    const raised = structuredClone(catalog);
    raised.codex["host-memory"] = "native";
    const r = closure([sample(BASE)], raised);
    expect(r.failures).toContain(`codex/host-memory: broken (run ${BASE})`);
    expect(r.drift).toContain(`codex/host-memory: catalog degraded → native since run ${BASE}`);
    // A cell observed working whole under a degraded catalog closes once the catalog is raised.
    const m = sample(BASE);
    m.hosts.codex.cells["host-memory"] = {
      ...m.hosts.codex.cells["host-memory"],
      observed: "works",
      state: "catalog-outdated",
    };
    expect(closureFailures([m])).toContain(`codex/host-memory: catalog-outdated (run ${BASE})`);
    expect(closureFailures([m], raised)).toEqual([]);
  });

  it.skipIf(!existsSync(join(__dirname, "..", "..", "dist", "domain", "harnesses.js")))(
    "the command exits 1 on regressions and 0 when closed",
    () => {
      const cmd = join(__dirname, "..", "..", "scripts", "host-run", "compare.mjs");
      const at = (id: string) => join(SAMPLES, id, "matrix.json");
      const dir = mkdtempSync(join(tmpdir(), "aw-host-run-compare-"));
      try {
        const worseFile = join(dir, "matrix.json");
        writeFileSync(worseFile, JSON.stringify(worse()));
        const reg = spawnSync(process.execPath, [cmd, at(BASE), worseFile], { encoding: "utf8" });
        expect(reg.status).toBe(1);
        expect(reg.stdout).toContain("claude-code/compaction: works → broken");
        const ok = spawnSync(process.execPath, [cmd, worseFile, at(BASE)], { encoding: "utf8" });
        expect(ok.status).toBe(0);
        const closed = spawnSync(process.execPath, [cmd, "--assert-closed", at(BASE)], {
          encoding: "utf8",
        });
        expect(closed.status).toBe(0);
        const open = spawnSync(process.execPath, [cmd, "--assert-closed", at(BASE), worseFile], {
          encoding: "utf8",
        });
        expect(open.status).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
