// The matrix of one run: 8 hosts × 6 surfaces, one state per cell, each cell
// carrying the catalog state it was compared with (`expected`) and what the run
// observed. `matrix.json` is the evidence of a run, not a second catalog: the
// catalog, HARNESS.md's table and HOST_VERIFICATIONS stay where the matrix lives.
//
// Catalog → cell (plan 085, «Solution»):
//   native                  works → works · anything else → broken
//   degraded | unsupported  degraded or failing AND declared by /w:doctor → degraded-declared
//                           not declared → broken · works whole → catalog-outdated
//   warp, oz                not-covered, with its reason
// A cell the run did not reach is not-reached, and that never closes. A cell a
// partial run did not exercise (step or host left out) is not-run: it says
// nothing, and the last observation of an earlier run stands.

import { ALL_HOSTS, NOT_COVERED, SURFACES } from "./hosts.mjs";

export const MATRIX_SCHEMA = 1;

export const CELL_STATES = [
  "works",
  "degraded-declared",
  "broken",
  "not-reached",
  "catalog-outdated",
  "not-covered",
  "not-run",
];

/** What the run saw, before the catalog is consulted. */
export const OBSERVATIONS = ["works", "degraded", "fails", "not-reached"];

export const MODES = ["interactive", "non-interactive"];

/** The catalog's state of each surface per host, from `capabilitiesFor` in dist. */
export function catalogStates(harnesses, capabilitiesFor) {
  return Object.fromEntries(
    harnesses.map((h) => [
      h.id,
      Object.fromEntries(
        capabilitiesFor(h)
          .filter((c) => SURFACES.includes(c.id))
          .map((c) => [c.id, c.status]),
      ),
    ]),
  );
}

export function classifyCell({ expected, observed, declaredByDoctor }) {
  if (!OBSERVATIONS.includes(observed)) throw new Error(`unknown observation '${observed}'`);
  if (observed === "not-reached") return "not-reached";
  if (expected === "native") return observed === "works" ? "works" : "broken";
  if (observed === "works") return "catalog-outdated";
  return declaredByDoctor ? "degraded-declared" : "broken";
}

/** Relay decorations a host may add in front of a line: list, quote or table marks. */
const RELAY_PREFIX = "^[\\s>|│*•+\\-]*";
const HOST_HEADER = /· runtime /;
const SECTION = /^[\s>|│*•+-]*(Cobertura|Hallazgos|Resumen|Veredicto|sin rastro)\b/;

/**
 * Whether the host's own /w:doctor relay declares the surface degraded FOR THAT
 * HOST. `aw doctor --format human` prints under «Hosts» one header per host —
 * `<mark> <label> · <status> · runtime …` — followed by its
 * `<surface> degraded|unsupported — …` lines (src/cli/commands/doctor.ts,
 * `hostLines`). Only the lines under this host's header count.
 */
export function declaredByDoctor(doctorText, surface, hostLabel) {
  const lines = String(doctorText ?? "").split("\n");
  const escapedLabel = hostLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`${RELAY_PREFIX}(?:→\\s*)?${escapedLabel} · `);
  const degradation = new RegExp(`${RELAY_PREFIX}${surface} (degraded|unsupported)\\s*(—|-)`);
  let inside = false;
  for (const line of lines) {
    if (HOST_HEADER.test(line)) inside = header.test(line);
    else if (SECTION.test(line)) inside = false;
    else if (inside && degradation.test(line)) return true;
  }
  return false;
}

/**
 * Evidence → observation per surface, from what the run collected in the host's
 * home, workspace and screen (`live.mjs` collectEvidence). The catalog is never
 * consulted here: that is what lets a run contradict it.
 */
const JUDGES = {
  // Which wrapper the host ran is fixed by its packaging (hosts.mjs `commandsVia`):
  // a native commands dir works, a synthesized w-<cmd> skill is the fallback.
  commands: (e) => (e.ran ? (e.via === "commands-dir" ? "works" : "degraded") : "fails"),
  "structured-choice": (e) =>
    e.answered === "native" ? "works" : e.answered === "markdown" ? "degraded" : "fails",
  hooks: (e) => {
    const seen = ["SessionStart", "PreToolUse", "PreCompact", "PostCompact"].filter(
      (event) => e.lines?.[event],
    ).length;
    return seen === 4 ? "works" : seen > 0 ? "degraded" : "fails";
  },
  mcp: (e) =>
    e.toolsListed && e.receipt ? "works" : e.toolsListed || e.receipt ? "degraded" : "fails",
  "host-memory": (e) => (e.ran ? (e.destination ? "works" : "degraded") : "fails"),
  compaction: (e) =>
    e.preCompact && e.postCompact ? "works" : e.checkpoint ? "degraded" : "fails",
};

export function judgeSurface(surface, evidence) {
  const judge = JUDGES[surface];
  if (judge === undefined) throw new Error(`unknown surface '${surface}'`);
  if (evidence === undefined || evidence === null || evidence.reached === false) {
    return "not-reached";
  }
  return judge(evidence);
}

function cellRecord({ expected, seen, run, runId, date, cli }) {
  const observed = seen?.observed ?? "not-reached";
  const declared = seen?.declared_by_doctor === true;
  return {
    expected,
    observed,
    state: classifyCell({ expected, observed, declaredByDoctor: declared }),
    declared_by_doctor: declared,
    mode: seen ? (seen.mode ?? "interactive") : null,
    run_id: runId,
    date,
    host_version: run?.version ?? null,
    cli_version: cli.version,
    cli_revision: cli.revision,
    model: run?.model ?? null,
    effort: run?.effort ?? null,
    ...(seen?.extract ? { extract: seen.extract } : {}),
    ...(seen?.extract_refused ? { extract_refused: seen.extract_refused } : {}),
    ...(run?.evidence_broken ? { evidence_broken: run.evidence_broken } : {}),
  };
}

function coveredHost(host, expectedCells, run, launched, { steps, runId, date, cli }) {
  const cells = Object.fromEntries(
    SURFACES.map((surface) => {
      const expected = expectedCells[surface];
      if (!launched || !steps.includes(surface)) return [surface, { expected, state: "not-run" }];
      return [
        surface,
        cellRecord({ expected, seen: run?.cells?.[surface], run, runId, date, cli }),
      ];
    }),
  );
  return {
    covered: true,
    launched,
    version: run?.version ?? null,
    model: run?.model ?? null,
    effort: run?.effort ?? null,
    ...(host === "gemini"
      ? {
          agy_without_profile: run?.agy_without_profile === true,
          agy_model_provider: run?.agy_model_provider ?? null,
          agy_keychain: run?.agy_keychain ?? null,
        }
      : {}),
    ...(host === "crush"
      ? { crush_provider: run?.crush_provider ?? null, crush_model: run?.crush_model ?? null }
      : {}),
    cells,
  };
}

function uncoveredHost(host, expectedCells) {
  return {
    covered: false,
    reason: NOT_COVERED[host],
    cells: Object.fromEntries(
      SURFACES.map((s) => [s, { expected: expectedCells[s], state: "not-covered" }]),
    ),
  };
}

/**
 * Builds the matrix of one run. `hostRuns[host]` = {version, model, effort,
 * agy_without_profile?, cells: {surface: {observed, mode, declared_by_doctor,
 * extract?, extract_refused?}}}. `steps` are the surfaces the run exercised and
 * `hosts` the covered hosts it launched; a cell outside them is not-run. Inside
 * them, a missing observation is not-reached.
 */
export function buildMatrix({
  runId,
  date,
  cli,
  scenarioDigest,
  catalog,
  hostRuns,
  steps = SURFACES,
  hosts = null,
}) {
  const launched = hosts ?? ALL_HOSTS.filter((h) => !(h in NOT_COVERED));
  const ctx = { steps, runId, date, cli };
  const out = Object.fromEntries(
    ALL_HOSTS.map((host) => {
      const expectedCells = catalog[host] ?? {};
      if (host in NOT_COVERED) return [host, uncoveredHost(host, expectedCells)];
      const run = launched.includes(host) ? (hostRuns[host] ?? null) : null;
      return [host, coveredHost(host, expectedCells, run, launched.includes(host), ctx)];
    }),
  );
  const partial =
    steps.length < SURFACES.length ||
    ALL_HOSTS.some((h) => !(h in NOT_COVERED) && !launched.includes(h));
  return {
    schema: MATRIX_SCHEMA,
    run_id: runId,
    date,
    partial,
    cli,
    scenario_digest: scenarioDigest,
    hosts: out,
  };
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((x) => actual.includes(x));
}

/** Problems with a matrix's shape; empty means it satisfies AC-01. */
export function validateMatrix(m) {
  const problems = [];
  if (m.schema !== MATRIX_SCHEMA) problems.push(`schema ${m.schema} is not ${MATRIX_SCHEMA}`);
  if (typeof m.run_id !== "string" || m.run_id.length === 0) problems.push("run_id missing");
  if (!sameSet(Object.keys(m.hosts ?? {}), ALL_HOSTS))
    problems.push("hosts are not the catalog's 8");
  for (const [host, entry] of Object.entries(m.hosts ?? {})) {
    problems.push(...validateHost(host, entry, m.partial === true));
  }
  return problems;
}

function validateHost(host, entry, partial) {
  const problems = [];
  if (!sameSet(Object.keys(entry.cells ?? {}), SURFACES))
    problems.push(`${host}: surfaces are not the 6`);
  if (!entry.covered && !(host in NOT_COVERED))
    problems.push(`${host}: only warp and oz may be uncovered`);
  if (!entry.covered && !entry.reason) problems.push(`${host}: not covered without a reason`);
  for (const [surface, cell] of Object.entries(entry.cells ?? {})) {
    problems.push(...validateCell(`${host}/${surface}`, cell, entry.covered, partial));
  }
  return problems;
}

const REQUIRED = ["expected", "observed", "run_id", "date", "cli_version", "cli_revision"];

function validateCell(where, cell, covered, partial) {
  if (!CELL_STATES.includes(cell.state)) return [`${where}: unknown state '${cell.state}'`];
  if (!covered) {
    return cell.state === "not-covered"
      ? []
      : [`${where}: an uncovered host's cell must be not-covered`];
  }
  if (cell.state === "not-covered")
    return [`${where}: a covered host cannot have a not-covered cell`];
  if (cell.state === "not-run")
    return partial ? [] : [`${where}: not-run only exists in a partial run`];
  const problems = REQUIRED.filter((f) => cell[f] === undefined || cell[f] === null).map(
    (f) => `${where}: ${f} missing`,
  );
  if (cell.state !== "not-reached" && !MODES.includes(cell.mode))
    problems.push(`${where}: mode missing`);
  if (
    problems.length === 0 &&
    classifyCell({
      expected: cell.expected,
      observed: cell.observed,
      declaredByDoctor: cell.declared_by_doctor,
    }) !== cell.state
  ) {
    problems.push(`${where}: state '${cell.state}' does not follow from expected/observed`);
  }
  return problems;
}
