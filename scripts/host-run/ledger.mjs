// The one renderer of src/domain/host-verification.ts, shared by the smoke and
// the host run so neither overwrites what the other recorded: the smoke owns
// {version, at, depth}, the host run owns `run`.
//
// The output must stay formatter-clean (biome, lineWidth 100), so `npm run lint`
// never fails after either tool writes it.

const HEADER = `// VERIFICATION LEDGER — written by \`npm run smoke:hosts\` and \`scripts/host-run/\`, never by hand.
//
// It is deliberately a separate module from the catalog: \`harnesses.ts\` is
// hand-authored (ids, dirs, tiers — what we DECIDE), this file records what a
// run actually PROVED. Keeping the two apart is what lets every projection say
// "verified against X on date Y" without a surface ever claiming a verification
// that no run backs (spec 010, criterion 10).
//
// A host absent from this record has simply never been verified by a run.

import type { HarnessId } from "./harnesses.js";

/** The six surfaces a host run observes, in the doctor's order. */
export type RunSurface =
  | "commands"
  | "structured-choice"
  | "hooks"
  | "mcp"
  | "host-memory"
  | "compaction";

/** A cell as the last host run left it (plan 085, catalog → cell). */
export type RunCellState =
  | "works"
  | "degraded-declared"
  | "broken"
  | "not-reached"
  | "catalog-outdated";

export interface HarnessRunVerification {
  /** Id of the run under \`tests/fixtures/host-runs/<id>/\` whose matrix backs this block. */
  id: string;
  /** ISO date (YYYY-MM-DD) of that run. */
  at: string;
  /** Host version the run launched; null when the host exposes none. */
  version: string | null;
  /** The checkout the run exercised. */
  cli: { version: string; revision: string };
  /** Last observation of each surface, across the runs merged into this block. */
  cells: Record<RunSurface, RunCellState>;
}

export interface HarnessVerification {
  /** Host version the run probed. null = the host exposes no CLI version (Warp is an app). */
  version: string | null;
  /** ISO date (YYYY-MM-DD) of the run that produced this entry. */
  at: string;
  /**
   * How far that run went:
   * - \`invocation\` — runtime present and its version read;
   * - \`install\`    — the above PLUS the installed artifacts matched what the catalog promises.
   */
  depth: "invocation" | "install";
  /** What a host run inside the host observed; the smoke keeps it when it regenerates. */
  run?: HarnessRunVerification;
}
`;

/** Quote only ids that are not valid identifiers, as biome would leave them. */
const key = (id) => (/^[A-Za-z_$][\w$]*$/.test(id) ? id : `"${id}"`);
const str = (v) => (v === null ? "null" : JSON.stringify(v));

function renderRun(run) {
  const cells = Object.entries(run.cells)
    .map(([surface, state]) => `        ${key(surface)}: ${str(state)},`)
    .join("\n");
  return [
    "    run: {",
    `      id: ${str(run.id)},`,
    `      at: ${str(run.at)},`,
    `      version: ${str(run.version)},`,
    `      cli: { version: ${str(run.cli.version)}, revision: ${str(run.cli.revision)} },`,
    "      cells: {",
    cells,
    "      },",
    "    },",
  ].join("\n");
}

function renderEntry(id, entry) {
  const head = `version: ${str(entry.version)}, at: ${str(entry.at)}, depth: ${str(entry.depth)}`;
  if (!entry.run) return `  ${key(id)}: { ${head} },`;
  return [
    `  ${key(id)}: {`,
    `    version: ${str(entry.version)},`,
    `    at: ${str(entry.at)},`,
    `    depth: ${str(entry.depth)},`,
    renderRun(entry.run),
    "  },",
  ].join("\n");
}

/** `entries` in the order they should appear: [[id, {version, at, depth, run?}], …]. */
export function renderLedger(entries) {
  const body = entries.map(([id, entry]) => renderEntry(id, entry)).join("\n");
  return `${HEADER}
export const HOST_VERIFICATIONS: Partial<Record<HarnessId, HarnessVerification>> = {
${body}
};
`;
}

/**
 * The smoke's results, in catalog order, with each host's `run` block carried
 * over — the smoke never proves or disproves a run. A host the smoke did not
 * verify this time (runtime missing, install failed) keeps its current entry
 * when that entry carries a run block; otherwise it drops out, as before.
 */
export function mergeSmoke(smokeResults, current, order = smokeResults.map((r) => r.id)) {
  const byId = new Map(smokeResults.map((r) => [r.id, r]));
  return order
    .filter((id) => byId.has(id) || current[id]?.run)
    .map((id) => {
      const r = byId.get(id);
      if (!r) return [id, current[id]];
      const run = current[id]?.run;
      return [id, { version: r.version, at: r.at, depth: r.depth, ...(run ? { run } : {}) }];
    });
}

/**
 * The current ledger with the run blocks replaced. A host the smoke never
 * recorded gets `invocation` depth from the run itself: launching it proved the
 * runtime answers.
 */
export function mergeRun(current, blocks, order) {
  return order
    .filter((id) => id in current || id in blocks)
    .map((id) => {
      const base = current[id] ?? {
        version: blocks[id].version,
        at: blocks[id].at,
        depth: "invocation",
      };
      const { run: _old, ...rest } = base;
      return [id, blocks[id] ? { ...rest, run: blocks[id] } : base];
    });
}

/**
 * Where the ledger's run blocks disagree with the blocks the matrices yield:
 * `[{host, field, ledger, matrix}]`, empty when they agree.
 */
export function ledgerRunDrift(ledger, blocks) {
  const drift = [];
  const hosts = new Set([
    ...Object.keys(blocks),
    ...Object.keys(ledger).filter((h) => ledger[h]?.run),
  ]);
  for (const host of hosts) {
    const a = ledger[host]?.run ?? null;
    const b = blocks[host] ?? null;
    for (const field of ["id", "at", "version", "cli", "cells"]) {
      if (JSON.stringify(a?.[field] ?? null) !== JSON.stringify(b?.[field] ?? null)) {
        drift.push({ host, field, ledger: a?.[field] ?? null, matrix: b?.[field] ?? null });
      }
    }
  }
  return drift;
}

/**
 * The ledger as the source file says it NOW (dist may be stale). The object
 * literal the renderer wrote is plain JS, so it is evaluated; the result must
 * render back to the same bytes, or the file was edited by hand and is refused.
 */
export function parseLedgerSource(text) {
  const marker =
    "export const HOST_VERIFICATIONS: Partial<Record<HarnessId, HarnessVerification>> = ";
  const start = text.indexOf(marker);
  if (start === -1 || !text.endsWith("};\n"))
    throw new Error("ledger source has an unexpected shape");
  const literal = text.slice(start + marker.length, -2);
  const parsed = Function(`"use strict"; return (${literal});`)();
  if (renderLedger(Object.entries(parsed)) !== text) {
    throw new Error("ledger source does not render back to itself: refusing to merge into it");
  }
  return parsed;
}
