/**
 * Applying the migration: the plan is RE-derived inside the workspace lock and
 * the writes come from that derivation, never from the one a person read.
 *
 * The preview is read-only and can be minutes old; the workspace it described
 * may have gained a session, a row or an edited hub file since. Re-deriving
 * under the lock is what makes "what you approved" and "what happens" the same
 * decision instead of two — the same reason the retirement commands recompute
 * theirs before converging.
 */

import type { FileSystemPort } from "../../ports/file-system.js";
import { upsertHistoryRow } from "../history-update-service.js";
import { withCwdLock } from "../lock-service.js";
import type { PathsService } from "../paths-service.js";
import {
  type MigrationConflict,
  type WorkspaceMigrationPlan,
  planWorkspaceMigration,
  sentinelPath,
} from "./plan.js";

export interface WorkspaceMigrationApplied {
  workspace: string;
  /** Hub files whose block markers now carry the running namespace. */
  markers_renamed: string[];
  /** Hub files that also lost the empty block the CLI had appended. */
  duplicates_dropped: string[];
  /** Legacy sessions the record called closed and that now say so on disk. */
  sentinels_seeded: string[];
  /**
   * Legacy sessions whose number now lives in the record.
   *
   * A folder can be archived; `HISTORY.md` cannot forget. Until a legacy number
   * has a row, the day its folder goes away the correlative hands that number
   * to a new session, and two different runs end up sharing an identity.
   */
  rows_seeded: string[];
  /**
   * Legacy sessions whose row was born without a declared date, and therefore
   * carries the day the record was written rather than the day they ran. Said
   * out loud because it is the one value here that is not a fact about the
   * session.
   */
  rows_dated_today: string[];
  conflicts: MigrationConflict[];
  next_correlative: string;
}

export async function applyWorkspaceMigration(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<WorkspaceMigrationApplied | { error: string }> {
  return withCwdLock(fs, paths, async () => {
    const plan = await planWorkspaceMigration(fs, paths);
    await writePlan(fs, paths, plan);
    return summarize(plan);
  });
}

async function writePlan(
  fs: FileSystemPort,
  paths: PathsService,
  plan: WorkspaceMigrationPlan,
): Promise<void> {
  for (const hub of plan.markers) {
    await fs.writeText(hub.path, hub.text);
  }
  for (const seed of plan.sentinels) {
    // Empty, byte for byte what `session-close` writes: the sentinel says
    // "closed" by EXISTING, and giving it content here would be redesigning it.
    // The date the record holds is what the preview reports; nothing reads — or
    // writes — a modification time to decide a session's state.
    await fs.writeText(sentinelPath(seed), "");
  }
  for (const seed of plan.rows) {
    // The lock-free primitive: this function already holds the workspace lock,
    // and the public command would take it again.
    await upsertHistoryRow(fs, paths, {
      code: seed.code,
      sesionName: seed.name,
      // Unsaid when the session never declared one, so the newborn row takes
      // the record's own default instead of a date invented here.
      ...(seed.date !== null ? { date: seed.date } : {}),
      state: seed.state,
    });
  }
}

function summarize(plan: WorkspaceMigrationPlan): WorkspaceMigrationApplied {
  return {
    workspace: plan.workspace,
    markers_renamed: plan.markers.map((hub) => hub.path),
    duplicates_dropped: plan.markers.filter((h) => h.drops_duplicate).map((hub) => hub.path),
    sentinels_seeded: plan.sentinels.map((seed) => seed.folder),
    rows_seeded: plan.rows.map((seed) => seed.folder),
    rows_dated_today: plan.rows.filter((s) => s.date === null).map((seed) => seed.folder),
    conflicts: plan.conflicts,
    next_correlative: plan.next_correlative,
  };
}
