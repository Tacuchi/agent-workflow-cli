import type { FlowDecision } from "../../src/domain/flow/authority.js";

/**
 * The production journey, one tranche ahead of itself.
 *
 * Until the cutover phases move each tranche, EVERY row of the five flows is
 * `legacy`, and the engine legitimately answers with the `legacy` boundary that
 * hands the step back to doctrine — it never applies a rule it does not own. A
 * test about the semantic boundary, the effect ledger or the fail-closed modes
 * would therefore be testing the migration instead of its own subject.
 *
 * Flipping ONLY `ownership` keeps the real ids, order, signals, documents and
 * effects: what runs is the production journey as it will be once its tranche is
 * migrated. The day it is, this helper becomes identity and can go.
 *
 * The import above is type-only ON PURPOSE: the service-level suites reach the
 * same flip through `vi.mock` of the authority module, and a value import here
 * would make the helper part of the cycle the factory is still constructing.
 */
export function asOwned(rows: readonly FlowDecision[]): readonly FlowDecision[] {
  return rows.map((row) => ({ ...row, ownership: "cli-owned" as const }));
}
