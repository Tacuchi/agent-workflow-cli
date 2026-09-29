#!/usr/bin/env node
// Compares host runs cell by cell and checks whether the matrix is closed.
//
// Usage:
//   node scripts/host-run/compare.mjs                   latest run vs the one before it
//   node scripts/host-run/compare.mjs <prev> <next>     two run ids (or matrix.json paths)
//   node scripts/host-run/compare.mjs --assert-closed <id>…
//
// Exit 0 = no regression / closed; 1 = regressions / not closed; 2 = usage.
// Deliberately NOT part of the test suite: a committed regression must not
// block `prepublishOnly` (spec 062, Out), so closing is checked by this command.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES } from "./hosts.mjs";
import { catalogStates, classifyCell } from "./matrix.mjs";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RUNS_DIR = join(CHECKOUT, "tests", "fixtures", "host-runs");

/** How bad a cell is; undefined = says nothing about the host (not covered, not run). */
const RANK = {
  works: 0,
  "degraded-declared": 1,
  "catalog-outdated": 1,
  "not-reached": 2,
  broken: 3,
};

const byRunId = (a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0);

/** Every cell that got worse from `prev` to `next`; not-run cells say nothing. */
export function regressions(prev, next) {
  const out = [];
  for (const [host, entry] of Object.entries(next.hosts)) {
    const before = prev.hosts[host];
    if (!entry.covered || !before?.covered) continue;
    for (const surface of SURFACES) {
      const a = before.cells[surface]?.state;
      const b = entry.cells[surface]?.state;
      if (RANK[a] !== undefined && RANK[b] !== undefined && RANK[b] > RANK[a]) {
        out.push({ host, surface, from: a, to: b });
      }
    }
  }
  return out;
}

/** A later observation replaces the kept one, except a non-interactive structured-choice over an interactive one. */
function replaces(surface, kept, cell) {
  if (surface !== "structured-choice" || kept?.mode !== "interactive") return true;
  return cell.mode === "interactive";
}

/**
 * The last observation of each covered cell across `matrices`, with the run it
 * came from. not-run cells (step or host left out of a partial run) never
 * override. structured-choice prefers the last INTERACTIVE observation.
 */
export function lastObservations(matrices) {
  const cells = {};
  for (const m of [...matrices].sort(byRunId)) {
    for (const [host, entry] of Object.entries(m.hosts)) {
      if (!entry.covered) continue;
      cells[host] ??= {};
      keepLatest(cells[host], entry, m);
    }
  }
  return cells;
}

function keepLatest(kept, entry, m) {
  for (const surface of SURFACES) {
    const cell = entry.cells[surface];
    if (!cell || cell.state === "not-run" || !replaces(surface, kept[surface], cell)) continue;
    kept[surface] = {
      ...cell,
      run_id: cell.run_id ?? m.run_id,
      at: cell.date ?? m.date,
      host_version: cell.host_version ?? entry.version ?? null,
    };
  }
}

/**
 * Re-judges a kept cell against the CURRENT catalog, so a surface F4 raised in
 * the catalog closes with the run's own observation, and a catalog changed after
 * the run is reported rather than trusted.
 */
function againstCatalog(cell, current) {
  if (current === undefined || cell.observed === undefined)
    return { state: cell.state, drift: null };
  const state = classifyCell({
    expected: current,
    observed: cell.observed,
    declaredByDoctor: cell.declared_by_doctor === true,
  });
  return { state, drift: current === cell.expected ? null : `${cell.expected} → ${current}` };
}

function cellFailures(where, cell, state) {
  const failures = [];
  if (cell.evidence_broken)
    failures.push(`${where}: evidence broken — ${cell.evidence_broken} (run ${cell.run_id})`);
  if (["broken", "not-reached", "catalog-outdated"].includes(state)) {
    failures.push(`${where}: ${state} (run ${cell.run_id})`);
  }
  if (state === "degraded-declared" && cell.declared_by_doctor !== true) {
    failures.push(`${where}: degradation not declared by /w:doctor (run ${cell.run_id})`);
  }
  if (
    where.endsWith("/structured-choice") &&
    cell.mode !== "interactive" &&
    state !== "not-reached"
  ) {
    failures.push(`${where}: only observed non-interactively (run ${cell.run_id})`);
  }
  return failures;
}

/**
 * Why the matrix is not closed (AC-05, AC-06), and where the catalog moved since
 * the observation. `catalog` = current catalog states by host and surface; when
 * absent, each cell's stored `expected` is used.
 */
export function closure(matrices, catalog = null) {
  const failures = [];
  const drift = [];
  for (const [host, bySurface] of Object.entries(lastObservations(matrices))) {
    for (const surface of SURFACES) {
      const where = `${host}/${surface}`;
      const cell = bySurface[surface];
      if (!cell) {
        failures.push(`${where}: never observed`);
        continue;
      }
      const judged = againstCatalog(cell, catalog?.[host]?.[surface]);
      if (judged.drift) drift.push(`${where}: catalog ${judged.drift} since run ${cell.run_id}`);
      failures.push(...cellFailures(where, cell, judged.state));
    }
  }
  return { failures, drift };
}

export function closureFailures(matrices, catalog = null) {
  return closure(matrices, catalog).failures;
}

/**
 * The ledger's view of the runs: per host, the last state of each surface, and
 * the id, date and CLI of the most recent run that observed that host.
 */
export function mergedRunBlocks(matrices) {
  const ordered = [...matrices].sort(byRunId);
  return Object.fromEntries(
    Object.entries(lastObservations(ordered))
      .filter(([, bySurface]) => Object.keys(bySurface).length > 0)
      .map(([host, bySurface]) => {
        const source = [...ordered]
          .reverse()
          .find((m) => SURFACES.some((s) => bySurface[s]?.run_id === m.run_id));
        return [
          host,
          {
            id: source.run_id,
            at: source.date,
            version: source.hosts[host].version ?? null,
            cli: { version: source.cli.version, revision: source.cli.revision },
            cells: Object.fromEntries(
              SURFACES.map((s) => [s, bySurface[s]?.state ?? "not-reached"]),
            ),
            ...(source.hosts[host].agy_model_provider
              ? { model_provider: source.hosts[host].agy_model_provider }
              : {}),
          },
        ];
      }),
  );
}

export function listRunIds(dir = RUNS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && e.name !== "samples" && existsSync(join(dir, e.name, "matrix.json")),
    )
    .map((e) => e.name)
    .sort();
}

export function loadMatrix(ref, dir = RUNS_DIR) {
  const path = ref.endsWith(".json") ? ref : join(dir, ref, "matrix.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The current catalog, from the built checkout. */
export async function currentCatalog(checkout = CHECKOUT) {
  const { HARNESSES } = await import(join(checkout, "dist", "domain", "harnesses.js"));
  const { capabilitiesFor } = await import(
    join(checkout, "dist", "application", "self", "host-states.js")
  );
  return catalogStates(HARNESSES, capabilitiesFor);
}

async function assertClosed(ids) {
  if (ids.length === 0) {
    console.error("--assert-closed needs at least one run id");
    return 2;
  }
  if (!existsSync(join(CHECKOUT, "dist", "domain", "harnesses.js"))) {
    console.error("dist not built: run 'npm run build' so the current catalog can be read");
    return 2;
  }
  const { failures, drift } = closure(
    ids.map((id) => loadMatrix(id)),
    await currentCatalog(),
  );
  for (const d of drift) console.log(`  note: ${d}`);
  if (failures.length === 0) {
    console.log(`closed: every covered cell of ${ids.join(", ")} works or is declared degraded`);
    return 0;
  }
  console.log(`not closed (${failures.length}):`);
  for (const f of failures) console.log(`  ${f}`);
  return 1;
}

function compare(prevRef, nextRef) {
  const found = regressions(loadMatrix(prevRef), loadMatrix(nextRef));
  if (found.length === 0) {
    console.log(`no regressions from ${prevRef} to ${nextRef}`);
    return 0;
  }
  console.log(`regressions from ${prevRef} to ${nextRef} (${found.length}):`);
  for (const r of found) console.log(`  ${r.host}/${r.surface}: ${r.from} → ${r.to}`);
  return 1;
}

async function main(argv) {
  if (argv[0] === "--assert-closed") return assertClosed(argv.slice(1));
  if (argv.length === 2) return compare(argv[0], argv[1]);
  if (argv.length !== 0) {
    console.error("usage: compare.mjs [<prev> <next>] | --assert-closed <id>…");
    return 2;
  }
  const ids = listRunIds();
  if (ids.length < 2) {
    console.log(`nothing to compare: ${ids.length} run(s) under ${RUNS_DIR}`);
    return 0;
  }
  return compare(ids.at(-2), ids.at(-1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
