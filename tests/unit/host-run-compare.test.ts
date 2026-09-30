// Comparing host runs (plan 085, T2.4, AC-05/06/07): cell-by-cell regressions
// between two runs, and the closure check with the last observation per cell.
// Only sample matrices are used: no suite test depends on the latest real run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

describe("host-run compare", () => {
  it("marks exactly the cells that got worse (works → broken)", () => {
    expect(regressions(sample(BASE), sample(WORSE))).toEqual([
      { host: "claude-code", surface: "hooks", from: "works", to: "broken" },
    ]);
  });

  it("an improvement or an unchanged cell is not a regression", () => {
    expect(regressions(sample(WORSE), sample(BASE))).toEqual([]);
    expect(regressions(sample(BASE), sample(BASE))).toEqual([]);
  });

  it("a partial run's unrepeated cells say nothing", () => {
    expect(regressions(sample(WORSE), sample(PARTIAL))).toEqual([]);
  });

  it("a clean run is closed", () => {
    expect(closureFailures([sample(BASE)])).toEqual([]);
  });

  it("a broken cell keeps the matrix open, with the run it came from", () => {
    expect(closureFailures([sample(BASE), sample(WORSE)])).toEqual([
      "claude-code/hooks: broken (run 2026-09-15T10-00-00Z)",
    ]);
  });

  it("the last observation of each cell wins: a partial repeat closes the broken cell", () => {
    expect(closureFailures([sample(WORSE), sample(PARTIAL)])).toEqual([]);
    const cells = lastObservations([sample(WORSE), sample(PARTIAL)]);
    expect(cells["claude-code"].hooks.run_id).toBe(PARTIAL);
    expect(cells.codex.mcp.run_id).toBe(WORSE);
  });

  it("structured-choice observed only non-interactively does not close", () => {
    const worse = sample(WORSE);
    worse.hosts.opencode.cells["structured-choice"].mode = "non-interactive";
    expect(closureFailures([worse])).toContain(
      "opencode/structured-choice: only observed non-interactively (run 2026-09-15T10-00-00Z)",
    );
    // An earlier interactive observation is kept over a later non-interactive one.
    expect(lastObservations([sample(BASE), worse]).opencode["structured-choice"].mode).toBe(
      "interactive",
    );
  });

  it("a host the catalog no longer covers (kimi) says nothing about closure, even from older runs", () => {
    // The WORSE sample still has kimi covered and only observed non-interactively.
    expect(sample(WORSE).hosts.kimi.covered).toBe(true);
    expect(closureFailures([sample(WORSE)]).some((f) => f.startsWith("kimi/"))).toBe(false);
    expect(lastObservations([sample(BASE), sample(WORSE)])).not.toHaveProperty("kimi");
    expect(mergedRunBlocks([sample(BASE)])).not.toHaveProperty("kimi");
  });

  it("not-reached, catalog-outdated and an undeclared degradation do not close", () => {
    const m = sample(BASE);
    m.hosts.codex.cells.mcp.state = "not-reached";
    m.hosts.opencode.cells.commands.state = "catalog-outdated";
    m.hosts.opencode.cells.hooks.declared_by_doctor = false;
    const failures = closureFailures([m]);
    expect(failures).toContain(`codex/mcp: not-reached (run ${BASE})`);
    expect(failures).toContain(`opencode/commands: catalog-outdated (run ${BASE})`);
    expect(failures).toContain(
      `opencode/hooks: degradation not declared by /w:doctor (run ${BASE})`,
    );
  });

  it("the merged ledger view takes the latest run id and the last state per cell", () => {
    const blocks = mergedRunBlocks([sample(WORSE), sample(PARTIAL)]);
    expect(blocks["claude-code"].id).toBe(PARTIAL);
    expect(blocks["claude-code"].cells.hooks).toBe("works");
  });

  it("a host left out of a later run keeps its earlier observations", () => {
    const SUBSET = "2026-09-17T10-00-00Z";
    const cells = lastObservations([sample(BASE), sample(SUBSET)]);
    expect(cells.opencode.mcp.run_id).toBe(BASE);
    expect(cells.codex.mcp.run_id).toBe(SUBSET);
    expect(regressions(sample(BASE), sample(SUBSET))).toEqual([
      { host: "codex", surface: "mcp", from: "works", to: "broken" },
    ]);
    const blocks = mergedRunBlocks([sample(BASE), sample(SUBSET)]);
    expect(blocks.opencode.id).toBe(BASE);
    expect(blocks.codex.id).toBe(SUBSET);
    expect(blocks.opencode.cells.mcp).toBe("works");
  });

  it("closing is judged against the CURRENT catalog, and a catalog change is reported", () => {
    const catalog = catalogStates(HARNESSES, capabilitiesFor);
    expect(closure([sample(BASE)], catalog)).toEqual({ failures: [], drift: [] });
    // F4 raised codex/hooks to native, and the run saw it degraded: now broken.
    const raised = structuredClone(catalog);
    raised.codex.hooks = "native";
    const r = closure([sample(BASE)], raised);
    expect(r.failures).toContain(`codex/hooks: broken (run ${BASE})`);
    expect(r.drift).toContain(`codex/hooks: catalog degraded → native since run ${BASE}`);
    // A cell observed working whole under a degraded catalog closes once the catalog is raised.
    const m = sample(BASE);
    m.hosts.codex.cells.hooks = {
      ...m.hosts.codex.cells.hooks,
      observed: "works",
      state: "catalog-outdated",
    };
    expect(closureFailures([m])).toContain(`codex/hooks: catalog-outdated (run ${BASE})`);
    expect(closureFailures([m], raised)).toEqual([]);
  });

  it.skipIf(!existsSync(join(__dirname, "..", "..", "dist", "domain", "harnesses.js")))(
    "the command exits 1 on regressions and 0 when closed",
    () => {
      const cmd = join(__dirname, "..", "..", "scripts", "host-run", "compare.mjs");
      const at = (id: string) => join(SAMPLES, id, "matrix.json");
      const reg = spawnSync(process.execPath, [cmd, at(BASE), at(WORSE)], { encoding: "utf8" });
      expect(reg.status).toBe(1);
      expect(reg.stdout).toContain("claude-code/hooks: works → broken");
      const ok = spawnSync(process.execPath, [cmd, at(WORSE), at(BASE)], { encoding: "utf8" });
      expect(ok.status).toBe(0);
      const closed = spawnSync(process.execPath, [cmd, "--assert-closed", at(BASE)], {
        encoding: "utf8",
      });
      expect(closed.status).toBe(0);
      const open = spawnSync(process.execPath, [cmd, "--assert-closed", at(BASE), at(WORSE)], {
        encoding: "utf8",
      });
      expect(open.status).toBe(1);
    },
  );
});
