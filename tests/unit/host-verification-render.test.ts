// The verification ledger has one renderer (plan 085, T2.3), shared by the smoke
// and the host run: the committed file is exactly what it renders, the smoke
// keeps every `run` block, and the ledger agrees with the latest real matrix
// when one exists. No test here requires that run to be closed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNS_DIR,
  listRunIds,
  loadMatrix,
  mergedRunBlocks,
} from "../../scripts/host-run/compare.mjs";
import {
  ledgerRunDrift,
  mergeRun,
  mergeSmoke,
  parseLedgerSource,
  renderLedger,
} from "../../scripts/host-run/ledger.mjs";
import { HARNESSES } from "../../src/domain/harnesses.js";
import { HOST_VERIFICATIONS } from "../../src/domain/host-verification.js";

const LEDGER = join(__dirname, "..", "..", "src", "domain", "host-verification.ts");
const sample = (id: string) =>
  JSON.parse(readFileSync(join(RUNS_DIR, "samples", id, "matrix.json"), "utf8"));
const order = HARNESSES.map((h) => h.id);

describe("verification ledger renderer", () => {
  it("renders the committed file byte for byte", () => {
    const rendered = renderLedger(Object.entries(HOST_VERIFICATIONS));
    expect(rendered).toBe(readFileSync(LEDGER, "utf8"));
  });

  it("the run reads the ledger from its source file, and refuses one edited by hand", () => {
    const text = readFileSync(LEDGER, "utf8");
    expect(parseLedgerSource(text)).toEqual(HOST_VERIFICATIONS);
    const withRun = renderLedger(
      mergeRun(HOST_VERIFICATIONS, mergedRunBlocks([sample("2026-09-01T10-00-00Z")]), order),
    );
    expect(parseLedgerSource(withRun).codex?.run?.cells.mcp).toBe("works");
    expect(() =>
      parseLedgerSource(text.replace('depth: "install" }', 'depth: "install", x: 1 }')),
    ).toThrow(/does not render back/);
  });

  it("the smoke keeps each host's run block when it regenerates", () => {
    const withRun = mergeRun(
      HOST_VERIFICATIONS,
      mergedRunBlocks([sample("2026-09-01T10-00-00Z")]),
      order,
    );
    const current = Object.fromEntries(withRun);
    const smoke = [
      { id: "claude-code", version: "9.9.9", at: "2026-10-01", depth: "install" },
      { id: "warp", version: null, at: "2026-10-01", depth: "install" },
    ];
    const merged = Object.fromEntries(mergeSmoke(smoke, current));
    expect(merged["claude-code"]).toMatchObject({
      version: "9.9.9",
      at: "2026-10-01",
      depth: "install",
    });
    expect(merged["claude-code"].run).toEqual(current["claude-code"].run);
    expect(merged.warp.run).toBeUndefined();
    const text = renderLedger(mergeSmoke(smoke, current));
    expect(text).toContain('    run: {\n      id: "2026-09-01T10-00-00Z",');
    expect(text).toContain('        "structured-choice": ');
  });

  it("a run replaces only the run blocks, keeping what the smoke proved", () => {
    const merged = Object.fromEntries(
      mergeRun(HOST_VERIFICATIONS, mergedRunBlocks([sample("2026-09-01T10-00-00Z")]), order),
    );
    expect(merged.codex).toMatchObject({
      version: HOST_VERIFICATIONS.codex?.version,
      depth: "install",
    });
    expect(merged.codex.run?.cells.mcp).toBe("works");
    expect(merged.warp.run).toBeUndefined();
    expect(Object.keys(merged)).toEqual(order.filter((id) => id in merged));
  });

  it("a ledger that diverges from its matrix is caught", () => {
    const blocks = mergedRunBlocks([sample("2026-09-01T10-00-00Z")]);
    const ledger = Object.fromEntries(mergeRun(HOST_VERIFICATIONS, blocks, order));
    expect(ledgerRunDrift(ledger, blocks)).toEqual([]);
    const drifted = structuredClone(ledger);
    if (drifted.codex?.run) drifted.codex.run.cells.mcp = "broken";
    expect(ledgerRunDrift(drifted, blocks)).toEqual([
      {
        host: "codex",
        field: "cells",
        ledger: drifted.codex?.run?.cells,
        matrix: blocks.codex.cells,
      },
    ]);
    expect(ledgerRunDrift(HOST_VERIFICATIONS, blocks).map((d) => d.host)).toContain("codex");
  });

  it("the smoke keeps the run block of a host it could not verify this time", () => {
    const current = Object.fromEntries(
      mergeRun(HOST_VERIFICATIONS, mergedRunBlocks([sample("2026-09-01T10-00-00Z")]), order),
    );
    const smoke = [{ id: "codex", version: "0.158.0", at: "2026-10-01", depth: "install" }];
    const merged = Object.fromEntries(mergeSmoke(smoke, current, order));
    expect(merged.kimi).toEqual(current.kimi);
    expect(merged.codex.run).toEqual(current.codex.run);
    // A host with no run block and no smoke result drops out, as before.
    expect(merged.warp).toBeUndefined();
    expect(Object.keys(merged)).toEqual(order.filter((id) => id in merged));
  });

  it.skipIf(listRunIds().length === 0)(
    "the committed ledger is identical to the latest real matrix",
    () => {
      const blocks = mergedRunBlocks(listRunIds().map((id) => loadMatrix(id)));
      expect(ledgerRunDrift(HOST_VERIFICATIONS, blocks)).toEqual([]);
    },
  );
});
