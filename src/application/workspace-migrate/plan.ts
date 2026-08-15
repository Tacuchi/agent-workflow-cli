/**
 * What a hub with a legacy session series needs before it can be operated with
 * the same commands as a new one — derived without writing a byte.
 *
 * Three things are broken in such a hub, and none of them announces itself:
 * the project block wears markers of an older namespace and the CLI silently
 * reads a second, empty one it appended itself; the sessions the record calls
 * closed have no `.closed` sentinel on disk, so they show up as active forever;
 * and the numbers of the legacy series live only in folder names, so they
 * vanish from the record the day somebody archives the folders.
 *
 * This is a PUNCTUAL, explicit operation and not a reconciliation some other
 * command performs on the side: it decides what to do by comparing two sources
 * that may disagree, and a disagreement is answered by refusing to touch that
 * session — never by picking the more convenient of the two.
 */

import { join } from "node:path";
import type { SessionState } from "../../domain/types.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type HistoryRow, readHistoryRows } from "../history-table.js";
import type { ProjectBlockMarkers } from "../parsers/project-block.js";
import type { PathsService } from "../paths-service.js";
import { resolveWorkspaceRootFrom } from "../paths-service.js";
import {
  CLOSED_MARKER,
  buildSessionEntry,
  listSessionFolders,
  nextSessionCorrelative,
  parseSessionFolder,
  sessionNumericCode,
  sessionsSharingNumber,
} from "../session-resolver.js";
import {
  type HubMarkerRefusal,
  type HubMarkerRewrite,
  planHubMarkers,
  readHubFiles,
} from "./markers.js";

/** A session the record calls closed, whose folder never got the sentinel. */
export interface SentinelSeed {
  folder: string;
  /** Absolute path of the session folder the sentinel lands in. */
  path: string;
  /** The day the RECORD says it closed. Never the folder's mtime. */
  date: string;
}

/** A legacy session whose number exists only as a folder name. */
export interface RowSeed {
  folder: string;
  code: string;
  name: string;
  state: SessionState;
  /** The declared date, or `null` when the session never declared one. */
  date: string | null;
}

export type ConflictReason =
  | "numero_compartido"
  | "estado_divergente"
  | "estado_ilegible"
  | HubMarkerRefusal["reason"];

/** Something the migration deliberately left exactly as it found it. */
export interface MigrationConflict {
  /** The session folder or the hub file that stays untouched. */
  subject: string;
  reason: ConflictReason;
  detail: string;
}

export interface WorkspaceMigrationPlan {
  workspace: string;
  markers: HubMarkerRewrite[];
  sentinels: SentinelSeed[];
  rows: RowSeed[];
  conflicts: MigrationConflict[];
  /** Every legacy folder the workspace holds, whether or not it needs anything. */
  legacy: string[];
  /** The number the next session will take, from the ONE derivation F3 left. */
  next_correlative: string;
}

/** How many writes the plan holds. Zero means the workspace is already current. */
export function pendingChanges(plan: WorkspaceMigrationPlan): number {
  return plan.markers.length + plan.sentinels.length + plan.rows.length;
}

export async function planWorkspaceMigration(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<WorkspaceMigrationPlan> {
  const workspace = await resolveWorkspaceRootFrom(fs, paths);
  const markers = planMarkers(await readHubFiles(fs, workspace), paths.blockMarkers());
  const recorded = await readRecord(fs, paths);

  const sentinels: SentinelSeed[] = [];
  const rows: RowSeed[] = [];
  const conflicts: MigrationConflict[] = [...markers.conflicts];
  const legacy: string[] = [];

  for (const folder of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    const number = legacyNumber(folder.name);
    if (number === null) continue; // current-model folder: nothing legacy about it
    legacy.push(folder.name);
    const outcome = await planSession(fs, paths, folder, number, recorded.get(number));
    if (outcome.kind === "sentinel") sentinels.push(outcome.seed);
    if (outcome.kind === "row") rows.push(outcome.seed);
    if (outcome.kind === "conflict") conflicts.push(outcome.conflict);
  }

  return {
    workspace,
    markers: markers.rewrites,
    sentinels,
    rows,
    conflicts,
    legacy,
    next_correlative: await nextSessionCorrelative(fs, paths),
  };
}

function planMarkers(
  hubs: readonly { path: string; text: string }[],
  current: ProjectBlockMarkers,
): { rewrites: HubMarkerRewrite[]; conflicts: MigrationConflict[] } {
  const rewrites: HubMarkerRewrite[] = [];
  const conflicts: MigrationConflict[] = [];
  for (const hub of hubs) {
    const outcome = planHubMarkers(hub.path, hub.text, current);
    if (outcome.kind === "rewrite") rewrites.push(outcome.rewrite);
    if (outcome.kind === "refused") {
      conflicts.push({
        subject: hub.path,
        reason: outcome.refusal.reason,
        detail: outcome.refusal.detail,
      });
    }
  }
  return { rewrites, conflicts };
}

type SessionOutcome =
  | { kind: "sentinel"; seed: SentinelSeed }
  | { kind: "row"; seed: RowSeed }
  | { kind: "conflict"; conflict: MigrationConflict }
  | { kind: "coherente" };

/**
 * What one legacy session needs, given what the record says about its number.
 *
 * The rule that makes seeding a sentinel safe is the LAYOUT: a `sessionNNN-`
 * folder predates the sentinel model entirely, so the file's absence there is
 * the absence of the model and not a statement about the session. In a
 * current-model folder that same absence MEANS active — `session-resume
 * --reopen` produces exactly it, on purpose — and writing the sentinel back
 * would re-close a session somebody had just reopened. That is why this walks
 * the legacy series and nothing else.
 */
async function planSession(
  fs: FileSystemPort,
  paths: PathsService,
  folder: { name: string; path: string },
  number: number,
  row: HistoryRow | undefined,
): Promise<SessionOutcome> {
  // The record is indexed by number, so a number two folders answer to has ONE
  // row for TWO sessions: whichever we wrote, we would be writing about the
  // other one too.
  const sharing = await sessionsSharingNumber(fs, paths, folder.name);
  if (sharing.length > 1) {
    const folders = sharing.map((candidate) => candidate.folder).join(", ");
    return conflictOf(
      folder.name,
      "numero_compartido",
      `el número ${number} lo comparten ${sharing.length} carpetas (${folders}) y el registro se indexa por número: renombrá la legacy al modelo actual (\`NNN-<slug>\`) y reintentá`,
    );
  }

  const entry = await buildSessionEntry(fs, folder.path, folder.name);
  if (row === undefined) {
    return {
      kind: "row",
      seed: {
        folder: folder.name,
        code: entry.code ?? folder.name,
        name: entry.name,
        state: entry.state,
        date: entry.date ?? null,
      },
    };
  }

  const recorded = recordedState(row.state);
  if (recorded === null) {
    return conflictOf(
      folder.name,
      "estado_ilegible",
      `la fila del histórico dice '${row.state}', que no es ni 'active' ni 'closed': corregila a mano y reintentá`,
    );
  }
  if (recorded === entry.state) return { kind: "coherente" };
  if (recorded === "active") {
    return conflictOf(
      folder.name,
      "estado_divergente",
      "el histórico la da por activa y la carpeta ya tiene su centinela `.closed`: cuál de las dos quedó atrás no se adivina",
    );
  }
  return {
    kind: "sentinel",
    seed: { folder: folder.name, path: folder.path, date: row.date },
  };
}

function conflictOf(subject: string, reason: ConflictReason, detail: string): SessionOutcome {
  return { kind: "conflict", conflict: { subject, reason, detail } };
}

/** Where the sentinel of a session goes. */
export function sentinelPath(seed: SentinelSeed): string {
  return join(seed.path, CLOSED_MARKER);
}

/**
 * The record, indexed by NUMBER — the key it is actually written with.
 *
 * Compared as numbers and not as strings for the same reason the upsert does
 * it: `47` and `047` are one session, and `100` is not `1000`.
 */
async function readRecord(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<Map<number, HistoryRow>> {
  const path = paths.cwdHistoryFile();
  const byNumber = new Map<number, HistoryRow>();
  if (!(await fs.exists(path))) return byNumber;
  for (const row of readHistoryRows(await fs.readText(path))) {
    // The SAME reading of "what number does this carry" the resolver and the
    // correlative use: `session047-x`, `047-x` and a bare `047` are one session.
    const digits = sessionNumericCode(row.key);
    if (digits !== null) byNumber.set(Number.parseInt(digits, 10), row);
  }
  return byNumber;
}

/**
 * The number a LEGACY folder carries, or `null` when the folder is not one.
 *
 * `parseSessionFolder` is the canonical reading of a folder's identity and it
 * answers this without another regex: for the current model it hands back the
 * WHOLE folder name as the code, and only the `sessionNNN-<slug>` layout splits
 * a number off.
 */
function legacyNumber(folder: string): number | null {
  const { code } = parseSessionFolder(folder);
  if (code === null || code === folder) return null;
  const parsed = Number.parseInt(code, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function recordedState(cell: string): SessionState | null {
  const value = cell.trim().toLowerCase();
  if (value === "closed") return "closed";
  if (value === "active") return "active";
  return null;
}
