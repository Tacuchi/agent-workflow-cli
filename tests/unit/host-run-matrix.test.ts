// The matrix of a host run (plan 085, T2.1-T2.2, AC-01): 8 hosts × 6 surfaces,
// each cell carrying its catalog state, its observation and its evidence; warp
// and oz not covered with a reason; extracts built by allowlist and refused when
// they would leak the real HOME, the user, an address or a foreign MCP.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNS_DIR, listRunIds, loadMatrix } from "../../scripts/host-run/compare.mjs";
import {
  buildExtract,
  hookBinaries,
  hookLines,
  normalize,
  privacyViolations,
  recallRows,
} from "../../scripts/host-run/extract.mjs";
import { ALL_HOSTS, SURFACES } from "../../scripts/host-run/hosts.mjs";
import {
  buildMatrix,
  catalogStates,
  classifyCell,
  declaredByDoctor,
  judgeSurface,
  validateMatrix,
} from "../../scripts/host-run/matrix.mjs";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

const SAMPLES = join(RUNS_DIR, "samples");
const sample = (id: string) => JSON.parse(readFileSync(join(SAMPLES, id, "matrix.json"), "utf8"));
const catalog = catalogStates(HARNESSES, capabilitiesFor);
const cli = { version: "28.0.0", revision: "abc1234" };

describe("host-run matrix", () => {
  it("the catalog projection has the 6 surfaces for each of the 8 hosts", () => {
    expect(Object.keys(catalog)).toEqual(ALL_HOSTS);
    for (const host of ALL_HOSTS)
      expect(Object.keys(catalog[host]).sort()).toEqual([...SURFACES].sort());
  });

  it("maps catalog × observation onto a cell as the plan's table says", () => {
    expect(classifyCell({ expected: "native", observed: "works", declaredByDoctor: false })).toBe(
      "works",
    );
    expect(classifyCell({ expected: "native", observed: "degraded", declaredByDoctor: true })).toBe(
      "broken",
    );
    expect(classifyCell({ expected: "native", observed: "fails", declaredByDoctor: false })).toBe(
      "broken",
    );
    expect(
      classifyCell({ expected: "degraded", observed: "degraded", declaredByDoctor: true }),
    ).toBe("degraded-declared");
    expect(
      classifyCell({ expected: "unsupported", observed: "fails", declaredByDoctor: true }),
    ).toBe("degraded-declared");
    expect(
      classifyCell({ expected: "degraded", observed: "degraded", declaredByDoctor: false }),
    ).toBe("broken");
    expect(classifyCell({ expected: "degraded", observed: "works", declaredByDoctor: true })).toBe(
      "catalog-outdated",
    );
    expect(
      classifyCell({ expected: "native", observed: "not-reached", declaredByDoctor: false }),
    ).toBe("not-reached");
  });

  it("builds 8 × 6 with warp and oz not covered, and a missing observation not-reached", () => {
    const m = buildMatrix({
      runId: "r1",
      date: "2026-09-29",
      cli,
      scenarioDigest: "d",
      catalog,
      hostRuns: {},
    });
    expect(validateMatrix(m)).toEqual([]);
    expect(m.hosts.warp).toMatchObject({ covered: false });
    expect(m.hosts.oz.reason).toMatch(/Warp/);
    for (const s of SURFACES) {
      expect(m.hosts.warp.cells[s].state).toBe("not-covered");
      expect(m.hosts.codex.cells[s].state).toBe("not-reached");
    }
  });

  it("records per cell the run, date, host and CLI versions, mode, model and effort", () => {
    const m = buildMatrix({
      runId: "r2",
      date: "2026-09-29",
      cli,
      scenarioDigest: "d",
      catalog,
      hostRuns: {
        codex: {
          version: "0.157.1",
          model: "gpt-x",
          effort: "high",
          cells: { mcp: { observed: "works", mode: "interactive", declared_by_doctor: false } },
        },
        gemini: { version: "1.2.11", agy_without_profile: true, cells: {} },
      },
    });
    expect(m.hosts.codex.cells.mcp).toMatchObject({
      expected: "native",
      observed: "works",
      state: "works",
      run_id: "r2",
      date: "2026-09-29",
      host_version: "0.157.1",
      cli_version: "28.0.0",
      cli_revision: "abc1234",
      mode: "interactive",
      model: "gpt-x",
      effort: "high",
    });
    expect(m.hosts.gemini.agy_without_profile).toBe(true);
    expect(validateMatrix(m)).toEqual([]);
  });

  it("a matrix whose state does not follow from its observation is invalid", () => {
    const m = sample("2026-09-01T10-00-00Z");
    m.hosts["claude-code"].cells.hooks.state = "works";
    m.hosts["claude-code"].cells.hooks.observed = "fails";
    expect(validateMatrix(m).join("\n")).toMatch(/does not follow/);
    const n = sample("2026-09-01T10-00-00Z");
    n.hosts.codex.covered = false;
    expect(validateMatrix(n).join("\n")).toMatch(/only warp and oz/);
  });

  it("the sample matrices are valid, and the partial ones mark what they did not exercise", () => {
    for (const id of [
      "2026-09-01T10-00-00Z",
      "2026-09-15T10-00-00Z",
      "2026-09-16T10-00-00Z",
      "2026-09-17T10-00-00Z",
    ]) {
      expect(validateMatrix(sample(id)), id).toEqual([]);
    }
    expect(sample("2026-09-16T10-00-00Z").hosts.codex.cells.mcp.state).toBe("not-run");
  });

  it("with a host subset, the covered hosts left out are not-run, never not-reached", () => {
    const m = buildMatrix({
      runId: "r3",
      date: "2026-09-29",
      cli,
      scenarioDigest: "d",
      catalog,
      hosts: ["codex"],
      hostRuns: {},
    });
    expect(m.partial).toBe(true);
    expect(m.hosts.codex.cells.mcp.state).toBe("not-reached");
    for (const s of SURFACES) expect(m.hosts.kimi.cells[s].state).toBe("not-run");
    expect(m.hosts.kimi.launched).toBe(false);
    expect(validateMatrix(m)).toEqual([]);
  });

  const doctorRelay = [
    "Hosts",
    "→ Codex · ready · runtime available 0.157.1 · Workline instalado",
    "    hooks degraded — not armed",
    "    host-memory degraded — behind [features] memories",
    "  Kimi Code · ready · runtime available 0.39.1 · Workline instalado",
    "    mcp degraded — imaginary",
    "",
    "Cobertura",
    "    compaction degraded — not a host line",
  ].join("\n");

  it("reads the doctor's degradation lines only under the host's own header", () => {
    expect(declaredByDoctor(doctorRelay, "hooks", "Codex")).toBe(true);
    expect(declaredByDoctor(doctorRelay, "host-memory", "Codex")).toBe(true);
    expect(declaredByDoctor(doctorRelay, "mcp", "Codex")).toBe(false);
    expect(declaredByDoctor(doctorRelay, "mcp", "Kimi Code")).toBe(true);
    expect(declaredByDoctor(doctorRelay, "hooks", "Kimi Code")).toBe(false);
    expect(declaredByDoctor(doctorRelay, "compaction", "Codex")).toBe(false);
  });

  it("tolerates list, quote and table prefixes a host adds when it relays the report", () => {
    const relayed = [
      "> → Codex · ready · runtime available 0.157.1 · Workline instalado",
      "> - hooks degraded — not armed",
      "| structured-choice degraded — per turn |",
      "* compaction unsupported - fallback",
    ].join("\n");
    expect(declaredByDoctor(relayed, "hooks", "Codex")).toBe(true);
    expect(declaredByDoctor(relayed, "structured-choice", "Codex")).toBe(true);
    expect(declaredByDoctor(relayed, "compaction", "Codex")).toBe(true);
  });

  it("judges each surface from its evidence, never from the catalog", () => {
    expect(judgeSurface("commands", { ran: true, via: "commands-dir" })).toBe("works");
    expect(judgeSurface("commands", { ran: true, via: "skill" })).toBe("degraded");
    expect(judgeSurface("commands", { ran: false, via: "commands-dir" })).toBe("fails");
    expect(judgeSurface("structured-choice", { answered: "markdown" })).toBe("degraded");
    expect(judgeSurface("structured-choice", { reached: false })).toBe("not-reached");
    const all = { SessionStart: true, PreToolUse: true, PreCompact: true, PostCompact: true };
    expect(judgeSurface("hooks", { lines: all })).toBe("works");
    expect(judgeSurface("hooks", { lines: { PreToolUse: true } })).toBe("degraded");
    expect(judgeSurface("mcp", { toolsListed: true, receipt: true })).toBe("works");
    expect(judgeSurface("compaction", { checkpoint: true })).toBe("degraded");
    expect(judgeSurface("host-memory", { ran: false })).toBe("fails");
    expect(judgeSurface("host-memory", undefined)).toBe("not-reached");
  });

  it("an extract refused by the privacy filter is recorded on its cell, not dropped silently", () => {
    const m = buildMatrix({
      runId: "r4",
      date: "2026-09-29",
      cli,
      scenarioDigest: "d",
      catalog,
      hosts: ["codex"],
      hostRuns: {
        codex: {
          version: "0.157.1",
          cells: {
            mcp: {
              observed: "works",
              mode: "interactive",
              extract_refused: ["contains the real HOME"],
            },
          },
        },
      },
    });
    expect(m.hosts.codex.cells.mcp.extract_refused).toEqual(["contains the real HOME"]);
    expect(m.hosts.codex.cells.mcp).not.toHaveProperty("extract");
  });

  it.skipIf(listRunIds().length === 0)(
    "every real run under tests/fixtures/host-runs is a valid 8 × 6 matrix",
    () => {
      for (const id of listRunIds()) expect(validateMatrix(loadMatrix(id)), id).toEqual([]);
    },
  );
});

describe("host-run extracts", () => {
  const realHome = "/Users/someone";
  const root = "/var/folders/xx/T/aw-host-run-r1-codex-AbC123";
  const paths = { root, realHome };
  const cell = {
    run_id: "r1",
    state: "works",
    expected: "native",
    observed: "works",
    mode: "interactive",
    declared_by_doctor: false,
  };

  it("keeps only allowlisted fields and a bounded, normalized fragment", () => {
    const screen = `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n\u001b[1mdone\u001b[0m in ${root}/workspace`;
    const e = buildExtract({
      host: "codex",
      surface: "mcp",
      cell,
      screen,
      evidence: { toolsListed: true, receipt: true, secret: "x" },
      paths,
    });
    expect(Object.keys(e).sort()).toEqual(
      [
        "declared_by_doctor",
        "evidence",
        "expected",
        "fragment",
        "host",
        "mode",
        "observed",
        "run_id",
        "state",
        "surface",
      ].sort(),
    );
    expect(e.evidence).toEqual({ tools_listed: true, receipt: true });
    expect(e.fragment.split("\n").length).toBeLessThanOrEqual(20);
    expect(e.fragment).toContain("done in <workspace>");
    expect(e.fragment).not.toContain("\u001b");
  });

  it("recall keeps only each row's state and reason", () => {
    const hostMemory = {
      hosts: [
        {
          host: "claude-code",
          label: "Claude Code",
          state: "absent",
          reason: `no existe ${root}/home/.claude/projects`,
          workline_entries: 3,
          skipped: ["x"],
        },
      ],
    };
    expect(recallRows(hostMemory)).toEqual([
      { host: "claude-code", state: "absent", reason: `no existe ${root}/home/.claude/projects` },
    ]);
    const e = buildExtract({ host: "codex", surface: "host-memory", cell, hostMemory, paths });
    expect(e.rows).toEqual([
      { host: "claude-code", state: "absent", reason: "no existe <home>/.claude/projects" },
    ]);
    expect(e).not.toHaveProperty("fragment");
  });

  it("reads hook events and the binary that ran them from the home's logs", () => {
    const log =
      "2026-09-29T10:00:00Z INFO self namespace --pin=workflow\n2026-09-29T10:01:00Z INFO hook sql-mutation-guard\n";
    expect(hookLines(log)).toEqual({
      SessionStart: true,
      PreToolUse: true,
      PreCompact: false,
      PostCompact: false,
    });
    expect(hookBinaries(`${root}/bin/agent-workflow hook sql-mutation-guard\n`)).toEqual({
      PreToolUse: "agent-workflow",
    });
  });

  it("refuses an extract with the real HOME, the user, an address or a foreign MCP", () => {
    const base = buildExtract({
      host: "codex",
      surface: "mcp",
      cell,
      screen: "ok",
      evidence: {},
      paths,
    });
    const opts = { realHome, username: "someone" };
    expect(privacyViolations(base, opts)).toEqual([]);
    const leak = (fragment: string) => privacyViolations({ ...base, fragment }, opts);
    expect(leak(`read ${realHome}/.codex/auth.json`)).toContain("contains the real HOME");
    expect(leak("hello someone")).toContain("contains the user name");
    expect(leak("contact person@example.com")).toContain("contains an email address");
    expect(leak("called mcp__qtc-prod__execute_sql")).toContain(
      "names an MCP outside the scenario: qtc-prod",
    );
    expect(leak("called mcp__host-run-probe__execute_sql")).toEqual([]);
    expect(leak("called mcp_host-run-probe_execute_sql")).toEqual([]);
    expect(leak("used mcp__claude_ai_Claude_Docs__batch")).toContain(
      "names an MCP outside the scenario: claude_ai_Claude_Docs",
    );
    expect(leak("used mcp__qtc_cert__execute_sql")).toContain(
      "names an MCP outside the scenario: qtc_cert",
    );
    expect(leak("running claude-code@2.1.284 and host-run@invalid")).toEqual([]);
    expect(
      privacyViolations(
        { ...base, fragment: "server qtc-cert is up" },
        { ...opts, foreignMcp: ["qtc-cert"] },
      ),
    ).toContain("names an MCP outside the scenario: qtc-cert");
  });

  it("normalization names the disposable paths and the real HOME", () => {
    expect(normalize(`${root}/home/.x ${realHome}/y`, paths)).toBe("<home>/.x <real-home>/y");
  });
});
