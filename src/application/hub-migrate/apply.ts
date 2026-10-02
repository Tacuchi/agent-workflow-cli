/**
 * Applying the migration: the plan is RE-derived inside the hub lock and
 * the writes come from that derivation, never from the one a person read.
 *
 * The preview is read-only and can be minutes old; the hub it described
 * may have gained a session, a row or an edited hub file since. Re-deriving
 * under the lock is what makes "what you approved" and "what happens" the same
 * decision instead of two — the same reason the retirement commands recompute
 * theirs before converging.
 */

import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { leadingCorrelative } from "../../domain/correlative.js";
import { sealRunState, serializeRunState } from "../../domain/flow/run-state.js";
import { FOLDER_RESERVATION_MARKER, reservationOwnerOf } from "../../domain/reservation.js";
import { sealCustody } from "../../domain/session/custody.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import {
  type ClaimIdentity,
  type ClaimTransfer,
  appendClaimEvent,
  openClaimsOf,
  openOwnerOfSlot,
  readClaimEvents,
  readClaimEventsRaw,
} from "../claims-ledger.js";
import { scanSlots } from "../claims-recovery.js";
import { docBranchLedgerPath } from "../doc-branch-ledger.js";
import { locateRun, readRun } from "../flow/run-state-service.js";
import { readHistoryRows, upsertRow } from "../history-table.js";
import { upsertHistoryRow } from "../history-update-service.js";
import { LockBusyError, type LockHandle, acquireLock, withCwdLock } from "../lock-service.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { publishArtifacts } from "../semantic-operation/publish.js";
import { renameBindingsTo } from "../session-binding-service.js";
import { readCustody, writeCustody } from "../session-custody-service.js";
import { CLOSED_MARKER, listSessionFolders } from "../session-resolver.js";
import type { KeepChoice } from "./block-file.js";
import {
  type HubMigrationPlan,
  type MigrationConflict,
  type RenumberMove,
  planHubMigration,
  planRenumber,
  sentinelPath,
} from "./plan.js";

export interface HubMigrationApplied {
  hub: string;
  /** Hub files whose block markers now carry the running namespace. */
  markers_renamed: string[];
  /** Open plans whose source declarations now name `hub`. */
  aliases_rewritten: string[];
  /** Open runs whose scope now names `hub`. */
  runs_rewritten: string[];
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
   * Legacy sessions whose row has no declared date. Their durable cell is `—`;
   * the migration date is never presented as evidence about the session.
   */
  rows_without_date: string[];
  /** The legacy CLAUDE.md mirror: retired, or stripped down to the person's content. */
  block_file: {
    claude: "retired" | "stripped";
    agents: "written" | "unchanged";
    source: KeepChoice;
    adds_import: boolean;
  } | null;
  conflicts: MigrationConflict[];
  next_correlative: string;
}

interface RenumberTransfer {
  path: string;
  before: string;
  from: string;
  to: string;
  claim: ClaimIdentity;
  transfer: ClaimTransfer;
}

interface RenumberJournalBody {
  version: 1;
  moves: RenumberMove[];
  files: Array<[string, string | null]>;
  transfers: RenumberTransfer[];
}

interface RenumberJournal extends RenumberJournalBody {
  digest: string;
}

type RecoveryGuard = { lock: LockHandle; from: string; to: string; bytes: string };
type RenumberGuard = { lock: LockHandle; original: string; moved: string; bytes: string };

function renumberJournalPath(paths: PathsService): string {
  return join(paths.cwdRoot(), "renumber-pending.json");
}

/** Recover a stopped multi-file renumber before its next read can claim an owner. */
export async function recoverRenumberJournal(
  fs: FileSystemPort,
  paths: PathsService,
  lockHeld = false,
): Promise<boolean> {
  const path = renumberJournalPath(paths);
  if (!(await fs.exists(path))) return false;
  const recover = async (): Promise<boolean> => {
    const journal = await readRenumberJournal(fs, paths, path);
    const guards: RecoveryGuard[] = [];
    try {
      await acquireRecoveryGuards(fs, paths, journal.moves, guards);
      const owners = await readTransferOwners(fs, journal.transfers);
      await reverseUnmovedClaims(fs, paths, journal.transfers, owners);
      const forward = journal.moves.filter((move) =>
        journal.transfers.some(
          (transfer) => transfer.from === move.from && owners.get(transfer.transfer.id) === move.to,
        ),
      );
      // A transaction with no changed marker is cancelled. Any new owner makes
      // its session's remaining claims move forward, so none is left ownerless.
      await restoreJournalFiles(fs, paths, journal);
      await finishForwardMoves(fs, paths, forward, journal.transfers, owners);
      // If no marker moved forward, restore every original marker. An intent
      // still open has already been cancelled against that marker above.
      if (forward.length === 0) {
        for (const transfer of journal.transfers)
          await fs.writeText(transfer.path, transfer.before);
      }
      await fs.remove(path);
      return true;
    } finally {
      await releaseRecoveryGuards(fs, guards);
    }
  };
  if (lockHeld) return recover();
  const result = await withCwdLock(fs, paths, recover, { waitMs: 2000 });
  if (typeof result === "object" && "error" in result) throw new Error(result.error);
  return result;
}

/** Apply only the previewed local identity moves under the shared hub lock. */
export async function applyRenumber(
  fs: FileSystemPort,
  paths: PathsService,
  git?: GitPort,
): Promise<{ moved: RenumberMove[]; blocked: string[] } | { error: string }> {
  return withCwdLock(fs, paths, async () => {
    await recoverRenumberJournal(fs, paths, true);
    const plan = await planRenumber(fs, paths, git);
    if (plan.blocked.length > 0) return { moved: [], blocked: plan.blocked };
    const guards: RenumberGuard[] = [];
    try {
      await acquireRenumberGuards(fs, paths, plan.moves, guards);
      const transfers = await collectRenumberTransfers(fs, paths, plan.moves);
      const before = await snapshotRenumberFiles(fs, paths, plan.moves, transfers);
      const journalBody: RenumberJournalBody = {
        version: 1,
        moves: plan.moves,
        files: [...before],
        transfers,
      };
      const journal: RenumberJournal = { ...journalBody, digest: semanticDigest(journalBody) };
      await fs.writeText(renumberJournalPath(paths), `${JSON.stringify(journal)}\n`);
      const completed: RenumberMove[] = [];
      try {
        await applyClaimTransfers(fs, paths, transfers);
        for (const move of plan.moves) {
          await moveSessionIdentityLocked(fs, paths, move);
          completed.push(move);
        }
        await fs.remove(renumberJournalPath(paths));
      } catch (error) {
        await rollbackRenumber(fs, paths, transfers, completed, before);
        throw error;
      }
      return { moved: plan.moves, blocked: [] };
    } finally {
      await releaseRenumberGuards(fs, guards);
    }
  });
}

async function moveSessionIdentityLocked(
  fs: FileSystemPort,
  paths: PathsService,
  move: RenumberMove,
): Promise<void> {
  const oldPath = join(paths.cwdSessionsDir(), move.from);
  const newPath = join(paths.cwdSessionsDir(), move.to);
  if (await fs.exists(newPath)) throw new Error(`ya existe ${newPath}`);
  const custody = await readCustody(fs, oldPath);
  if (custody.status === "unreadable") throw new Error(custody.reason);
  const run = await readRun(fs, locateRun(paths, move.from));
  if (!run.ok && run.failure.code !== "FLOW_RUN_ABSENT") throw new Error(run.failure.message);
  const ledger = docBranchLedgerPath(paths);
  const history = paths.cwdHistoryFile();
  const oldHistory = (await fs.exists(history)) ? await fs.readText(history) : null;
  const oldLedger = (await fs.exists(ledger)) ? await fs.readText(ledger) : null;
  const oldBindings = paths.cwdSessionBindingsFile();
  const bindingBytes = (await fs.exists(oldBindings)) ? await fs.readText(oldBindings) : null;
  const oldAttempts = paths.cwdFlowAttemptsFile(move.from);
  const newAttempts = paths.cwdFlowAttemptsFile(move.to);
  if (await fs.exists(newAttempts)) throw new Error(`ya existe el contador ${newAttempts}`);
  const oldCounterText = (await fs.exists(oldAttempts)) ? await fs.readText(oldAttempts) : null;
  let moved = false;
  let attemptsMoved = false;
  try {
    await fs.rename(oldPath, newPath);
    moved = true;
    if (custody.status === "present") {
      const previous = custody.custody;
      await writeCustody(
        fs,
        newPath,
        sealCustody({
          subject: { kind: "session", key: move.to },
          subjectPath: newPath,
          parents: previous.parents,
          created: previous.created,
          artifacts: previous.artifacts,
          sources: previous.sources,
          effects: previous.effects,
        }),
      );
    }
    if (run.ok) {
      const { digest: _oldDigest, ...unsealed } = run.state;
      await fs.writeText(
        join(newPath, ".flow-run.json"),
        serializeRunState(sealRunState({ ...unsealed, session: move.to })),
      );
    }
    if (oldCounterText !== null) {
      const originalCounter = JSON.parse(oldCounterText) as {
        version: number;
        attempts: Record<string, number>;
        granted: Record<string, number>;
      };
      await fs.rename(oldAttempts, newAttempts);
      attemptsMoved = true;
      await fs.writeText(
        newAttempts,
        `${JSON.stringify(
          {
            ...originalCounter,
            session: move.to,
            digest: semanticDigest({
              version: originalCounter.version,
              session: move.to,
              attempts: originalCounter.attempts,
              granted: originalCounter.granted,
            }),
          },
          null,
          2,
        )}\n`,
      );
    }
    await renameBindingsTo(fs, paths, move.from, move.to);
    await renameLedgerSession(fs, ledger, oldLedger, move);
    await renameHistorySession(fs, history, oldHistory, custody, newPath, move);
  } catch (error) {
    await restoreIdentity();
    throw error;
  }

  async function restoreIdentity(): Promise<void> {
    if (oldHistory !== null) await fs.writeText(history, oldHistory);
    else if (await fs.exists(history)) await fs.remove(history);
    if (oldLedger !== null) await fs.writeText(ledger, oldLedger);
    if (bindingBytes !== null) await fs.writeText(oldBindings, bindingBytes);
    else await fs.remove(oldBindings);
    if (attemptsMoved) {
      await fs.rename(newAttempts, oldAttempts);
      if (oldCounterText !== null) await fs.writeText(oldAttempts, oldCounterText);
    }
    if (moved) await fs.rename(newPath, oldPath);
    if (custody.status === "present") await writeCustody(fs, oldPath, custody.custody);
    if (run.ok) await fs.writeText(join(oldPath, ".flow-run.json"), serializeRunState(run.state));
  }
}

export async function applyHubMigration(
  fs: FileSystemPort,
  paths: PathsService,
  keep?: KeepChoice,
): Promise<HubMigrationApplied | { error: string }> {
  return withCwdLock(fs, paths, async () =>
    withOpenRunLocks(fs, paths, async (locked) => {
      const plan = await planHubMigration(fs, paths, locked, keep);
      await writePlan(fs, paths, plan);
      return summarize(plan);
    }),
  );
}

/**
 * Run `body` holding the lock of every open run of the hub.
 *
 * `aw flow submit` and a batch close take only their run's lock, never the hub's,
 * so without these a run could advance — and a batch close rewrite its plan —
 * between the moment the migration reads it and the moment it writes it back,
 * and the migration would put the older state back. The plan is derived inside,
 * so what gets written is what the locked state says. A busy lock aborts before
 * the first write.
 */
async function withOpenRunLocks<T>(
  fs: FileSystemPort,
  paths: PathsService,
  body: (locked: ReadonlySet<string>) => Promise<T>,
): Promise<T | { error: string }> {
  const held: LockHandle[] = [];
  const locked = new Set<string>();
  try {
    for (const folder of await listSessionFolders(fs, paths.cwdSessionsDir())) {
      const location = locateRun(paths, folder.name);
      if (await fs.exists(join(folder.path, CLOSED_MARKER))) continue;
      if (!(await fs.exists(location.statePath))) continue;
      try {
        held.push(await acquireLock(location.lockPath, fs));
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error;
        return {
          error: `la corrida ${folder.name} tiene el candado ocupado; reintentá cuando termine`,
        };
      }
      locked.add(folder.name);
    }
    return await body(locked);
  } finally {
    for (const lock of held.reverse()) await lock.release();
  }
}

async function writePlan(
  fs: FileSystemPort,
  paths: PathsService,
  plan: HubMigrationPlan,
): Promise<void> {
  const rewrites = [...plan.markers, ...plan.aliases];
  if (rewrites.length > 0) {
    const published = await publishArtifacts(
      fs,
      plan.hub,
      rewrites.map((file) => ({
        path: relative(plan.hub, file.path),
        content: file.text,
        overwrite: true,
      })),
    );
    if (!published.ok) throw new Error(published.failure.message);
  }
  for (const run of plan.runs) {
    // The copy first, as the inference stores it: a state naming a seal whose
    // copy is missing would be refused as an unauthenticated plan.
    for (const seal of run.seals) {
      await fs.mkdirp(dirname(seal.path));
      const saved = await fs.publishTextExclusive(seal.path, seal.text);
      if (!saved.created && (await fs.readText(seal.path)) !== seal.text)
        throw new Error(`la copia sellada ${seal.path} ya existe con otro contenido`);
    }
    await fs.writeText(run.path, run.text);
  }
  await writeBlockFile(fs, plan);
  for (const seed of plan.sentinels) {
    // Empty, byte for byte what `session-close` writes: the sentinel says
    // "closed" by EXISTING, and giving it content here would be redesigning it.
    // The date the record holds is what the preview reports; nothing reads — or
    // writes — a modification time to decide a session's state.
    await fs.writeText(sentinelPath(seed), "");
  }
  for (const seed of plan.rows) {
    // The lock-free primitive: this function already holds the hub lock,
    // and the public command would take it again.
    await upsertHistoryRow(fs, paths, {
      code: seed.code,
      sesionName: seed.name,
      date: seed.date,
      state: seed.state,
    });
  }
}

/**
 * AGENTS.md first: if the second step fails, the hub still has a readable block
 * and the mirror is still there to retry from — never the other way round.
 */
async function writeBlockFile(fs: FileSystemPort, plan: HubMigrationPlan): Promise<void> {
  const migration = plan.block_file;
  if (migration === null) return;
  if (migration.agents !== null) {
    const published = await publishArtifacts(fs, plan.hub, [
      {
        path: relative(plan.hub, migration.agents.path),
        content: migration.agents.text,
        overwrite: true,
      },
    ]);
    if (!published.ok) throw new Error(published.failure.message);
  }
  if (migration.legacy.text === null) await fs.remove(migration.legacy.path);
  else await fs.writeText(migration.legacy.path, migration.legacy.text);
}

function summarize(plan: HubMigrationPlan): HubMigrationApplied {
  return {
    hub: plan.hub,
    markers_renamed: plan.markers.map((hub) => hub.path),
    duplicates_dropped: plan.markers.filter((h) => h.drops_duplicate).map((hub) => hub.path),
    aliases_rewritten: plan.aliases.map((rewrite) => rewrite.path),
    runs_rewritten: plan.runs.map((run) => run.session),
    sentinels_seeded: plan.sentinels.map((seed) => seed.folder),
    rows_seeded: plan.rows.map((seed) => seed.folder),
    rows_without_date: plan.rows.filter((seed) => seed.date === "—").map((seed) => seed.folder),
    block_file:
      plan.block_file === null
        ? null
        : {
            claude: plan.block_file.legacy.action === "retire" ? "retired" : "stripped",
            agents: plan.block_file.agents === null ? "unchanged" : "written",
            source: plan.block_file.source,
            adds_import: plan.block_file.adds_import,
          },
    conflicts: plan.conflicts,
    next_correlative: plan.next_correlative,
  };
}

async function readRenumberJournal(
  fs: FileSystemPort,
  paths: PathsService,
  path: string,
): Promise<RenumberJournalBody> {
  const raw: unknown = JSON.parse(await fs.readText(path));
  if (typeof raw !== "object" || raw === null || !("digest" in raw)) {
    throw new Error("el registro de renumerado no tiene sello verificable");
  }
  const { digest, ...body } = raw as RenumberJournal;
  if (
    body.version !== 1 ||
    !Array.isArray(body.moves) ||
    !Array.isArray(body.files) ||
    !Array.isArray(body.transfers) ||
    digest !== semanticDigest(body)
  ) {
    throw new Error("el registro de renumerado no coincide con su sello");
  }
  const journal = body as RenumberJournalBody;
  const hub = paths.hubDir();
  if (
    journal.files.some(([file]) => !file.startsWith(`${hub}/`)) ||
    journal.transfers.some((transfer) => !transfer.path.startsWith(`${hub}/docs/`))
  ) {
    throw new Error("el registro de renumerado apunta fuera del hub");
  }
  return journal;
}

async function acquireRecoveryGuards(
  fs: FileSystemPort,
  paths: PathsService,
  moves: RenumberMove[],
  guards: RecoveryGuard[],
): Promise<void> {
  for (const move of moves) {
    const old = join(paths.cwdSessionsDir(), move.from);
    const next = join(paths.cwdSessionsDir(), move.to);
    const folder = (await fs.exists(old)) ? old : next;
    if (!(await fs.exists(folder)) || ((await fs.exists(old)) && (await fs.exists(next)))) {
      throw new Error(`no se puede reconciliar la carpeta ${move.from} → ${move.to}`);
    }
    const lockPath = join(folder, ".flow-run.json.lock");
    const lock = await acquireLock(lockPath, fs);
    guards.push({
      lock,
      from: join(old, ".flow-run.json.lock"),
      to: join(next, ".flow-run.json.lock"),
      bytes: await fs.readText(lockPath),
    });
  }
}

async function readTransferOwners(
  fs: FileSystemPort,
  transfers: RenumberTransfer[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const transfer of transfers) {
    if (!(await fs.exists(transfer.path))) throw new Error(`falta el marcador ${transfer.path}`);
    const owner = reservationOwnerOf(await fs.readText(transfer.path));
    if (owner !== transfer.from && owner !== transfer.to) {
      throw new Error(`el marcador ${transfer.path} no pertenece a ninguno de los dos dueños`);
    }
    owners.set(transfer.transfer.id, owner);
  }
  return owners;
}

async function reverseUnmovedClaims(
  fs: FileSystemPort,
  paths: PathsService,
  transfers: RenumberTransfer[],
  owners: Map<string, string>,
): Promise<void> {
  const confirmed = await readClaimEvents(fs, paths, {
    lockHeld: true,
    skipRenumberRecovery: true,
  });
  if (confirmed.unreadable > 0) throw new Error("claims.jsonl ilegible durante la recuperación");
  for (const transfer of transfers) {
    if (owners.get(transfer.transfer.id) !== transfer.from) continue;
    if (openOwnerOfSlot(confirmed.events, transfer.claim)?.owner !== transfer.to) continue;
    const reverse: ClaimTransfer = {
      ...transfer.transfer,
      id: randomUUID(),
      from: transfer.to,
      to: transfer.from,
    };
    const claim = { ...transfer.claim, owner: transfer.to };
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "transfer-intent",
      claim,
      transfer: reverse,
    });
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "transfer-confirmed",
      claim,
      transfer: reverse,
    });
  }
}

async function restoreJournalFiles(
  fs: FileSystemPort,
  paths: PathsService,
  journal: RenumberJournalBody,
): Promise<void> {
  for (const move of [...journal.moves].reverse()) {
    const old = join(paths.cwdSessionsDir(), move.from);
    const next = join(paths.cwdSessionsDir(), move.to);
    if (!(await fs.exists(old)) && (await fs.exists(next))) await fs.rename(next, old);
    const newCounter = paths.cwdFlowAttemptsFile(move.to);
    if (await fs.exists(newCounter))
      await fs.rename(newCounter, paths.cwdFlowAttemptsFile(move.from));
  }
  const markerPaths = new Set(journal.transfers.map((transfer) => transfer.path));
  for (const [file, text] of journal.files) {
    if (markerPaths.has(file)) continue;
    if (text === null) {
      if (await fs.exists(file)) await fs.remove(file);
    } else {
      await fs.writeText(file, text);
    }
  }
}

async function finishForwardMoves(
  fs: FileSystemPort,
  paths: PathsService,
  forward: RenumberMove[],
  transfers: RenumberTransfer[],
  owners: Map<string, string>,
): Promise<void> {
  for (const move of forward) {
    for (const transfer of transfers.filter((item) => item.from === move.from)) {
      if (owners.get(transfer.transfer.id) === move.to) continue;
      const next: ClaimTransfer = { ...transfer.transfer, id: randomUUID() };
      await appendClaimEvent(fs, paths, {
        at: new Date().toISOString(),
        event: "transfer-intent",
        claim: transfer.claim,
        transfer: next,
      });
      await fs.writeText(
        transfer.path,
        transfer.before.replace(/<!--\s*aw:reserva\s+\S+\s*-->/, `<!-- aw:reserva ${move.to} -->`),
      );
      await appendClaimEvent(fs, paths, {
        at: new Date().toISOString(),
        event: "transfer-confirmed",
        claim: transfer.claim,
        transfer: next,
      });
    }
    await moveSessionIdentityLocked(fs, paths, move);
  }
}

async function releaseRecoveryGuards(fs: FileSystemPort, guards: RecoveryGuard[]): Promise<void> {
  for (const guard of guards.reverse()) {
    for (const lockPath of [guard.from, guard.to]) {
      if ((await fs.exists(lockPath)) && (await fs.readText(lockPath)) === guard.bytes)
        await fs.remove(lockPath);
    }
    await guard.lock.release();
  }
}

async function acquireRenumberGuards(
  fs: FileSystemPort,
  paths: PathsService,
  moves: RenumberMove[],
  guards: RenumberGuard[],
): Promise<void> {
  // Hold EVERY affected run lock until the entire set succeeds or rolls
  // back. Releasing after one move lets that run advance before a later
  // failure restores its older bytes.
  for (const move of moves) {
    const original = join(paths.cwdSessionsDir(), move.from, ".flow-run.json.lock");
    const lock = await acquireLock(original, fs);
    guards.push({
      lock,
      original,
      moved: join(paths.cwdSessionsDir(), move.to, ".flow-run.json.lock"),
      bytes: await fs.readText(original),
    });
  }
}

async function collectRenumberTransfers(
  fs: FileSystemPort,
  paths: PathsService,
  moves: RenumberMove[],
): Promise<RenumberTransfer[]> {
  const claims = await readClaimEvents(fs, paths, { lockHeld: true });
  if (claims.unreadable > 0)
    throw new Error("claims.jsonl ilegible: no se renumeran reservas sin verificar su propietario");
  const scanned = await scanSlots(fs, paths, true);
  if (scanned.error) throw new Error(scanned.error);
  const transfers: RenumberTransfer[] = [];
  for (const move of moves) {
    const owned = await ownedClaimsForMove(fs, paths, move, claims.events, scanned.slots);
    for (const claim of owned.values()) {
      const claimed = join(
        paths.hubDir(),
        "docs",
        claim.category,
        `${claim.correlative}-${claim.name}`,
      );
      const marker = (await fs.exists(join(claimed, FOLDER_RESERVATION_MARKER)))
        ? join(claimed, FOLDER_RESERVATION_MARKER)
        : claimed;
      if (!(await fs.exists(marker))) continue;
      const before = await fs.readText(marker);
      if (reservationOwnerOf(before) !== move.from) continue;
      transfers.push({
        path: marker,
        before,
        from: move.from,
        to: move.to,
        claim,
        transfer: {
          id: randomUUID(),
          marker: relative(paths.hubDir(), marker),
          number: claim.correlative,
          from: move.from,
          to: move.to,
        },
      });
    }
  }
  return transfers;
}

async function snapshotRenumberFiles(
  fs: FileSystemPort,
  paths: PathsService,
  moves: RenumberMove[],
  transfers: RenumberTransfer[],
): Promise<Map<string, string | null>> {
  const shared = [
    paths.cwdHistoryFile(),
    join(dirname(paths.cwdHistoryFile()), "HISTORY.legacy.md"),
    paths.cwdSessionBindingsFile(),
    docBranchLedgerPath(paths),
  ];
  const files = [
    ...shared,
    ...moves.flatMap((move) => [
      join(paths.cwdSessionsDir(), move.from, ".custody.json"),
      join(paths.cwdSessionsDir(), move.from, ".flow-run.json"),
      paths.cwdFlowAttemptsFile(move.from),
    ]),
    ...transfers.map((transfer) => transfer.path),
  ];
  const before = new Map<string, string | null>();
  for (const path of files)
    before.set(path, (await fs.exists(path)) ? await fs.readText(path) : null);
  return before;
}

async function applyClaimTransfers(
  fs: FileSystemPort,
  paths: PathsService,
  transfers: RenumberTransfer[],
): Promise<void> {
  for (const transfer of transfers) {
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "transfer-intent",
      claim: transfer.claim,
      transfer: transfer.transfer,
    });
    const rewritten = transfer.before.replace(
      /<!--\s*aw:reserva\s+\S+\s*-->/,
      `<!-- aw:reserva ${transfer.to} -->`,
    );
    if (reservationOwnerOf(rewritten) !== transfer.to) {
      throw new Error(`no se pudo transferir la reserva ${transfer.path} a ${transfer.to}`);
    }
    await fs.writeText(transfer.path, rewritten);
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "transfer-confirmed",
      claim: transfer.claim,
      transfer: transfer.transfer,
    });
  }
}

async function rollbackRenumber(
  fs: FileSystemPort,
  paths: PathsService,
  transfers: RenumberTransfer[],
  completed: RenumberMove[],
  before: Map<string, string | null>,
): Promise<void> {
  const reversals = await beginTransferReversals(fs, paths, transfers);
  for (const move of completed.reverse()) {
    await fs.rename(join(paths.cwdSessionsDir(), move.to), join(paths.cwdSessionsDir(), move.from));
    const newAttempts = paths.cwdFlowAttemptsFile(move.to);
    if (await fs.exists(newAttempts))
      await fs.rename(newAttempts, paths.cwdFlowAttemptsFile(move.from));
  }
  for (const [path, text] of before) {
    if (text === null) {
      if (await fs.exists(path)) await fs.remove(path);
    } else {
      await fs.writeText(path, text);
    }
  }
  await settleTransferReversals(fs, paths, transfers, reversals);
  await fs.remove(renumberJournalPath(paths));
}

async function releaseRenumberGuards(fs: FileSystemPort, guards: RenumberGuard[]): Promise<void> {
  for (const guard of guards.reverse()) {
    if ((await fs.exists(guard.moved)) && (await fs.readText(guard.moved)) === guard.bytes)
      await fs.remove(guard.moved);
    await guard.lock.release();
  }
}

async function ownedClaimsForMove(
  fs: FileSystemPort,
  paths: PathsService,
  move: RenumberMove,
  events: Awaited<ReturnType<typeof readClaimEvents>>["events"],
  slots: Awaited<ReturnType<typeof scanSlots>>["slots"],
): Promise<Map<string, ClaimIdentity>> {
  const owned = new Map<string, ClaimIdentity>();
  for (const claim of openClaimsOf(events, move.from)) {
    owned.set(`${claim.category}/${claim.correlative}-${claim.name}`, claim);
  }
  for (const slot of slots) {
    if (slot.kind !== "reservation" || !slot.intact || slot.owner !== move.from) continue;
    const key = `${slot.category}/${slot.correlative}-${slot.name}`;
    if (owned.has(key)) continue;
    const claim = {
      category: slot.category,
      correlative: slot.correlative,
      name: slot.name,
      owner: move.from,
    };
    // next-number may have left its valid marker before its claimed
    // append. Repair that birth gap before writing the transfer intent.
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "claimed",
      claim,
      cause: "marcador intacto sin fila claimed al renumerar",
    });
    owned.set(key, claim);
  }
  return owned;
}

async function beginTransferReversals(
  fs: FileSystemPort,
  paths: PathsService,
  transfers: RenumberTransfer[],
): Promise<Map<string, { transfer: ClaimTransfer; claim: ClaimIdentity }>> {
  const recordedBefore = await readClaimEventsRaw(fs, paths);
  const reversals = new Map<string, { transfer: ClaimTransfer; claim: ClaimIdentity }>();
  for (const transfer of transfers) {
    if (
      !recordedBefore.events.some(
        (item) => item.transfer?.id === transfer.transfer.id && item.event === "transfer-confirmed",
      )
    )
      continue;
    const reverse: ClaimTransfer = {
      ...transfer.transfer,
      id: randomUUID(),
      from: transfer.to,
      to: transfer.from,
    };
    const claim = { ...transfer.claim, owner: transfer.to };
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "transfer-intent",
      claim,
      transfer: reverse,
    });
    reversals.set(transfer.transfer.id, { transfer: reverse, claim });
  }
  return reversals;
}

async function settleTransferReversals(
  fs: FileSystemPort,
  paths: PathsService,
  transfers: RenumberTransfer[],
  reversals: Map<string, { transfer: ClaimTransfer; claim: ClaimIdentity }>,
): Promise<void> {
  const recorded = await readClaimEventsRaw(fs, paths);
  for (const transfer of transfers) {
    const matching = recorded.events.filter((item) => item.transfer?.id === transfer.transfer.id);
    if (matching.some((item) => item.event === "transfer-confirmed")) {
      const reversal = reversals.get(transfer.transfer.id);
      if (!reversal) throw new Error(`falta intención de reversión para ${transfer.transfer.id}`);
      await appendClaimEvent(fs, paths, {
        at: new Date().toISOString(),
        event: "transfer-confirmed",
        claim: reversal.claim,
        transfer: reversal.transfer,
      });
    } else if (matching.some((item) => item.event === "transfer-intent")) {
      await appendClaimEvent(fs, paths, {
        at: new Date().toISOString(),
        event: "transfer-cancelled",
        claim: transfer.claim,
        transfer: transfer.transfer,
      });
    }
  }
}

async function renameLedgerSession(
  fs: FileSystemPort,
  ledger: string,
  oldLedger: string | null,
  move: RenumberMove,
): Promise<void> {
  if (oldLedger !== null) {
    const rewritten = oldLedger
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const event: unknown = JSON.parse(line);
        if (typeof event !== "object" || event === null) return line;
        const record = event as { doc?: { kind?: string; key?: string }; by?: string };
        if (record.doc?.kind !== "quick" || record.doc.key !== move.from) return line;
        return JSON.stringify({
          ...record,
          doc: { ...record.doc, key: move.to },
          by: record.by === move.from ? move.to : record.by,
        });
      })
      .join("\n");
    if (rewritten !== oldLedger) await fs.writeText(ledger, rewritten);
  }
}

async function renameHistorySession(
  fs: FileSystemPort,
  history: string,
  oldHistory: string | null,
  custody: Awaited<ReturnType<typeof readCustody>>,
  newPath: string,
  move: RenumberMove,
): Promise<void> {
  const oldKey = move.from.replace(/^session(?=\d)/, "");
  const row =
    oldHistory === null
      ? undefined
      : readHistoryRows(oldHistory).find(
          (entry) => entry.key === move.from || entry.key === oldKey,
        );
  const newCode = leadingCorrelative(move.to);
  if (newCode === null) throw new Error(`número inválido en ${move.to}`);
  await upsertRow(fs, history, {
    code: newCode,
    sesionName: move.to,
    date: row?.date ?? (custody.status === "present" ? custody.custody.created : "—"),
    state: row?.state ?? ((await fs.exists(join(newPath, CLOSED_MARKER))) ? "closed" : "active"),
    ...(row ? { refs: row.refs } : {}),
  });
  if (row) {
    // upsert normalized legacy and slim tables first. Match the parsed key,
    // never the raw spacing of a row that came from another machine.
    const normalized = await fs.readText(history);
    await fs.writeText(
      history,
      normalized
        .split("\n")
        .filter((line) => {
          if (!line.trim().startsWith("|")) return true;
          return line.trim().replace(/^\|/, "").split("|")[0]?.trim() !== row.key;
        })
        .join("\n"),
    );
  }
}
