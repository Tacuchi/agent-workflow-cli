/**
 * What a hub with a legacy session series needs before it can be operated with
 * the same commands as a new one — derived without writing a byte.
 *
 * Three things are broken in such a hub, and none of them announces itself:
 * the hub block wears markers of an older namespace and the CLI silently
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
import {
  correlativeValue,
  nextCorrelative,
  normalizeCorrelative,
  sameCorrelative,
} from "../../domain/correlative.js";
import type { SessionState } from "../../domain/types.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { locateRun, readRun } from "../flow/run-state-service.js";
import {
  type HistoryRow,
  maxHistoryCorrelativeFromText,
  readHistoryRows,
} from "../history-table.js";
import { readHubLocalConfig } from "../hub-local-config.js";
import type { HubBlockMarkers } from "../parsers/hub-block.js";
import { readHubBlock } from "../parsers/hub-block.js";
import type { PathsService } from "../paths-service.js";
import { resolveHubRootFrom } from "../paths-service.js";
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
  type PlanAliasRewrite,
  type RunScopeRewrite,
  planAliasRewrites,
  runScopeRewrites,
} from "./aliases.js";
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
  /** The declared date, or `—` when the legacy session never declared one. */
  date: string;
}

export type ConflictReason =
  | "numero_compartido"
  | "estado_divergente"
  | "estado_ilegible"
  | "commit_de_lote_pendiente"
  | HubMarkerRefusal["reason"];

/** Something the migration deliberately left exactly as it found it. */
export interface MigrationConflict {
  /** The session folder or the hub file that stays untouched. */
  subject: string;
  reason: ConflictReason;
  detail: string;
}

export interface HubMigrationPlan {
  hub: string;
  markers: HubMarkerRewrite[];
  /** Open plans whose source declarations still name the pre-29 alias. */
  aliases: PlanAliasRewrite[];
  /** Open runs whose scope still names the pre-29 alias. */
  runs: RunScopeRewrite[];
  sentinels: SentinelSeed[];
  rows: RowSeed[];
  conflicts: MigrationConflict[];
  /** Every legacy folder the hub holds, whether or not it needs anything. */
  legacy: string[];
  /** The number the next session will take, from the ONE derivation F3 left. */
  next_correlative: string;
}

export interface RenumberMove {
  from: string;
  to: string;
  reason: "legacy" | "registro-remoto" | "carpetas";
}

/** Preview only: current-model local folders give way to legacy or remote identities. */
export async function planRenumber(
  fs: FileSystemPort,
  paths: PathsService,
  git?: GitPort,
): Promise<{ moves: RenumberMove[]; blocked: string[] }> {
  if (await fs.exists(join(paths.cwdRoot(), "renumber-pending.json"))) {
    const { recoverRenumberJournal } = await import("./apply.js");
    await recoverRenumberJournal(fs, paths);
  }
  const folders = await listSessionFolders(fs, paths.cwdSessionsDir());
  let next = await nextSessionCorrelative(fs, paths);
  const moves: RenumberMove[] = [];
  const blocked: string[] = [];
  const block = git ? await readHubBlock(fs, paths.hubDir(), paths.blockMarkers()) : null;
  const remoteText = await remoteHistoryText(paths, git);
  const remoteRows = remoteText ? readHistoryRows(remoteText) : [];
  const remoteMax = remoteText ? maxHistoryCorrelativeFromText(remoteText) : null;
  const remoteValue = remoteMax === null ? null : correlativeValue(remoteMax);
  const nextValue = correlativeValue(next);
  if (remoteMax !== null && remoteValue !== null && nextValue !== null && remoteValue >= nextValue)
    next = nextCorrelative(remoteMax);
  for (const folder of folders) {
    const sharing = await sessionsSharingNumber(fs, paths, folder.name);
    const reason = renumberReason(folder, folders, sharing, remoteRows);
    if (reason === null) continue;
    const refusal = await renumberRefusal(fs, paths, git, block, folder);
    if (refusal !== null) {
      blocked.push(refusal);
      continue;
    }
    moves.push({
      from: folder.name,
      to: `${next}-${folder.name.replace(/^(?:session)?\d+-/, "")}`,
      reason,
    });
    next = nextCorrelative(next);
  }
  return { moves, blocked };
}

/** How many writes the plan holds. Zero means the hub is already current. */
export function pendingChanges(plan: HubMigrationPlan): number {
  return (
    plan.markers.length +
    plan.aliases.length +
    plan.runs.length +
    plan.sentinels.length +
    plan.rows.length
  );
}

export async function planHubMigration(
  fs: FileSystemPort,
  paths: PathsService,
  /** The sessions whose run lock `--apply` holds; only those runs are rewritten. */
  lockedRuns?: ReadonlySet<string>,
): Promise<HubMigrationPlan> {
  const hub = await resolveHubRootFrom(fs, paths);
  const local = await readHubLocalConfig(fs, join(hub, `.${paths.namespace}`, "local.json"));
  const markers = planMarkers(
    await readHubFiles(fs, hub),
    paths.blockMarkers(),
    local.config?.sources ?? {},
  );
  const recorded = await readRecord(fs, paths);

  const sentinels: SentinelSeed[] = [];
  const rows: RowSeed[] = [];
  const conflicts: MigrationConflict[] = [...markers.conflicts];
  const legacy: string[] = [];

  for (const folder of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    const number = legacyNumber(folder.name);
    if (number === null) continue; // current-model folder: nothing legacy about it
    legacy.push(folder.name);
    const outcome = await planSession(
      fs,
      paths,
      folder,
      number,
      recorded.get(normalizeCorrelative(number) ?? number),
    );
    if (outcome.kind === "sentinel") sentinels.push(outcome.seed);
    if (outcome.kind === "row") rows.push(outcome.seed);
    if (outcome.kind === "conflict") conflicts.push(outcome.conflict);
  }

  const aliases = await planAliasRewrites(fs, paths, hub);
  const runs = await runScopeRewrites(fs, paths, lockedRuns, aliases);
  for (const conflict of runs.conflicts) {
    conflicts.push({
      subject: conflict.path,
      reason: "commit_de_lote_pendiente",
      detail: `${conflict.session} ${conflict.detail}`,
    });
  }

  return {
    hub,
    markers: markers.rewrites,
    aliases,
    runs: runs.rewrites,
    sentinels,
    rows,
    conflicts,
    legacy,
    next_correlative: await nextSessionCorrelative(fs, paths),
  };
}

function planMarkers(
  hubs: readonly { path: string; text: string }[],
  current: HubBlockMarkers,
  localSources: Readonly<Record<string, string>>,
): { rewrites: HubMarkerRewrite[]; conflicts: MigrationConflict[] } {
  const rewrites: HubMarkerRewrite[] = [];
  const conflicts: MigrationConflict[] = [];
  for (const hub of hubs) {
    const outcome = planHubMarkers(hub.path, hub.text, current, localSources);
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
 * current-model folder that same absence MEANS active — `session-load
 * --reopen` produces exactly it, on purpose — and writing the sentinel back
 * would re-close a session somebody had just reopened. That is why this walks
 * the legacy series and nothing else.
 */
async function planSession(
  fs: FileSystemPort,
  paths: PathsService,
  folder: { name: string; path: string },
  number: string,
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
        // A migration cannot infer when an older session happened. Persist an
        // explicit unknown instead of making the migration date look historic.
        date: entry.date ?? "—",
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
): Promise<Map<string, HistoryRow>> {
  const path = paths.cwdHistoryFile();
  const byNumber = new Map<string, HistoryRow>();
  if (!(await fs.exists(path))) return byNumber;
  for (const row of readHistoryRows(await fs.readText(path))) {
    // The SAME reading of "what number does this carry" the resolver and the
    // correlative use: `session047-x`, `047-x` and a bare `047` are one session.
    const digits = sessionNumericCode(row.key);
    const number = digits === null ? null : normalizeCorrelative(digits);
    if (number !== null) byNumber.set(number, row);
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
function legacyNumber(folder: string): string | null {
  const { code } = parseSessionFolder(folder);
  if (code === null || code === folder) return null;
  return normalizeCorrelative(code);
}

function recordedState(cell: string): SessionState | null {
  const value = cell.trim().toLowerCase();
  if (value === "closed") return "closed";
  if (value === "active") return "active";
  return null;
}

async function remoteHistoryText(
  paths: PathsService,
  git: GitPort | undefined,
): Promise<string | null | undefined> {
  const hub = paths.hubDir();
  const branch = git && (await git.isGitRepo(hub)) ? await git.currentBranch(hub) : undefined;
  const upstream = branch ? await git?.upstreamBranch(hub, branch) : null;
  const prefix = upstream ? await git?.repoPrefix(hub) : null;
  const remoteText =
    upstream && prefix !== null && prefix !== undefined
      ? await git?.readAtRef?.(hub, upstream, `${prefix}.${paths.namespace}/HISTORY.md`)
      : null;
  return remoteText;
}

function renumberReason(
  folder: { name: string },
  folders: { name: string }[],
  sharing: Awaited<ReturnType<typeof sessionsSharingNumber>>,
  remoteRows: HistoryRow[],
): RenumberMove["reason"] | null {
  const legacyFolder = folder.name.startsWith("session");
  const folderNumber = sessionNumericCode(folder.name);
  const remoteConflict =
    folderNumber !== null &&
    remoteRows.some((row) => {
      const rowNumber = sessionNumericCode(row.key);
      return (
        rowNumber !== null && sameCorrelative(folderNumber, rowNumber) && row.key !== folder.name
      );
    });
  if (legacyFolder) {
    if (!legacyNeedsRenumber(folder, folders, sharing, remoteConflict)) return null;
  }
  if (sharing.length < 2 && !remoteConflict) return null;
  const legacy = sharing.some((item) => item.folder.startsWith("session"));
  const remote =
    remoteConflict ||
    sharing.some(
      (item) => item.folder !== folder.name && !folders.some((local) => local.name === item.folder),
    );
  const localPeers = sharing.filter((item) => folders.some((local) => local.name === item.folder));
  if (!legacyFolder && !legacy && !remote && folder.name !== localPeers.at(-1)?.folder) return null;
  return legacy ? "legacy" : remote ? "registro-remoto" : "carpetas";
}

async function renumberRefusal(
  fs: FileSystemPort,
  paths: PathsService,
  git: GitPort | undefined,
  block: Awaited<ReturnType<typeof readHubBlock>>,
  folder: { name: string; path: string },
): Promise<string | null> {
  let occupied = false;
  for (const source of block?.fuentes ?? []) {
    if (source.path === null) continue;
    const trees = await git?.worktreeList(source.path);
    if (
      trees?.some(
        (tree) => tree.branch === `aw/${folder.name}` || tree.path.endsWith(`/${folder.name}`),
      )
    )
      occupied = true;
  }
  if (occupied) {
    return `${folder.name}: integrá o liberá sus unidades de aislamiento antes de renumerar`;
  }
  if (await fs.exists(join(folder.path, ".flow-run.json.lock"))) {
    return `${folder.name}: la corrida tiene el candado ocupado; reintentá al terminar`;
  }
  const run = await readRun(fs, locateRun(paths, folder.name));
  if (!run.ok && run.failure.code !== "FLOW_RUN_ABSENT") {
    return `${folder.name}: corrida ilegible (${run.failure.code}); reparala antes de renumerar`;
  }
  if (run.ok && (run.state.proposal !== null || run.state.pending_action?.attempted === true)) {
    return `${folder.name}: publicá o cancelá su propuesta pendiente antes de renumerar`;
  }
  return null;
}

function legacyNeedsRenumber(
  folder: { name: string },
  folders: { name: string }[],
  sharing: Awaited<ReturnType<typeof sessionsSharingNumber>>,
  remoteConflict: boolean,
): boolean {
  const legacyPeers = sharing.filter((item) => item.folder.startsWith("session"));
  const orphanRow = sharing.some(
    (item) => item.folder !== folder.name && !folders.some((local) => local.name === item.folder),
  );
  if (legacyPeers.length < 2 && !orphanRow && !remoteConflict) return false;
  if (
    legacyPeers.length >= 2 &&
    !orphanRow &&
    !remoteConflict &&
    folder.name !== legacyPeers.at(-1)?.folder
  )
    return false;
  return true;
}
