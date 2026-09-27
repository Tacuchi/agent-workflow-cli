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
import { type LockHandle, acquireLock, withCwdLock } from "../lock-service.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { publishArtifacts } from "../semantic-operation/publish.js";
import { renameBindingsTo } from "../session-binding-service.js";
import { readCustody, writeCustody } from "../session-custody-service.js";
import { CLOSED_MARKER } from "../session-resolver.js";
import {
  type MigrationConflict,
  type RenumberMove,
  type WorkspaceMigrationPlan,
  planRenumber,
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
   * Legacy sessions whose row has no declared date. Their durable cell is `—`;
   * the migration date is never presented as evidence about the session.
   */
  rows_without_date: string[];
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
    const workspace = paths.workspaceDir();
    if (
      journal.files.some(([file]) => !file.startsWith(`${workspace}/`)) ||
      journal.transfers.some((transfer) => !transfer.path.startsWith(`${workspace}/docs/`))
    ) {
      throw new Error("el registro de renumerado apunta fuera del workspace");
    }
    const guards: Array<{ lock: LockHandle; from: string; to: string; bytes: string }> = [];
    try {
      for (const move of journal.moves) {
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
      const owners = new Map<string, string>();
      for (const transfer of journal.transfers) {
        if (!(await fs.exists(transfer.path)))
          throw new Error(`falta el marcador ${transfer.path}`);
        const owner = reservationOwnerOf(await fs.readText(transfer.path));
        if (owner !== transfer.from && owner !== transfer.to) {
          throw new Error(`el marcador ${transfer.path} no pertenece a ninguno de los dos dueños`);
        }
        owners.set(transfer.transfer.id, owner);
      }
      const confirmed = await readClaimEvents(fs, paths, {
        lockHeld: true,
        skipRenumberRecovery: true,
      });
      if (confirmed.unreadable > 0)
        throw new Error("claims.jsonl ilegible durante la recuperación");
      for (const transfer of journal.transfers) {
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
      const forward = journal.moves.filter((move) =>
        journal.transfers.some(
          (transfer) => transfer.from === move.from && owners.get(transfer.transfer.id) === move.to,
        ),
      );
      // A transaction with no changed marker is cancelled. Any new owner makes
      // its session's remaining claims move forward, so none is left ownerless.
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
      for (const move of forward) {
        for (const transfer of journal.transfers.filter((item) => item.from === move.from)) {
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
            transfer.before.replace(
              /<!--\s*aw:reserva\s+\S+\s*-->/,
              `<!-- aw:reserva ${move.to} -->`,
            ),
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
      // If no marker moved forward, restore every original marker. An intent
      // still open has already been cancelled against that marker above.
      if (forward.length === 0) {
        for (const transfer of journal.transfers)
          await fs.writeText(transfer.path, transfer.before);
      }
      await fs.remove(path);
      return true;
    } finally {
      for (const guard of guards.reverse()) {
        for (const lockPath of [guard.from, guard.to]) {
          if ((await fs.exists(lockPath)) && (await fs.readText(lockPath)) === guard.bytes)
            await fs.remove(lockPath);
        }
        await guard.lock.release();
      }
    }
  };
  if (lockHeld) return recover();
  const result = await withCwdLock(fs, paths, recover, { waitMs: 2000 });
  if (typeof result === "object" && "error" in result) throw new Error(result.error);
  return result;
}

/** Apply only the previewed local identity moves under the shared workspace lock. */
export async function applyRenumber(
  fs: FileSystemPort,
  paths: PathsService,
  git?: GitPort,
): Promise<{ moved: RenumberMove[]; blocked: string[] } | { error: string }> {
  return withCwdLock(fs, paths, async () => {
    await recoverRenumberJournal(fs, paths, true);
    const plan = await planRenumber(fs, paths, git);
    if (plan.blocked.length > 0) return { moved: [], blocked: plan.blocked };
    const guards: Array<{ lock: LockHandle; original: string; moved: string; bytes: string }> = [];
    try {
      // Hold EVERY affected run lock until the entire set succeeds or rolls
      // back. Releasing after one move lets that run advance before a later
      // failure restores its older bytes.
      for (const move of plan.moves) {
        const original = join(paths.cwdSessionsDir(), move.from, ".flow-run.json.lock");
        const lock = await acquireLock(original, fs);
        guards.push({
          lock,
          original,
          moved: join(paths.cwdSessionsDir(), move.to, ".flow-run.json.lock"),
          bytes: await fs.readText(original),
        });
      }
      const claims = await readClaimEvents(fs, paths, { lockHeld: true });
      if (claims.unreadable > 0)
        throw new Error(
          "claims.jsonl ilegible: no se renumeran reservas sin verificar su propietario",
        );
      const scanned = await scanSlots(fs, paths, true);
      if (scanned.error) throw new Error(scanned.error);
      const transfers: RenumberTransfer[] = [];
      for (const move of plan.moves) {
        const owned = new Map<string, ClaimIdentity>();
        for (const claim of openClaimsOf(claims.events, move.from)) {
          owned.set(`${claim.category}/${claim.correlative}-${claim.name}`, claim);
        }
        for (const slot of scanned.slots) {
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
        for (const claim of owned.values()) {
          const claimed = join(
            paths.workspaceDir(),
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
              marker: relative(paths.workspaceDir(), marker),
              number: claim.correlative,
              from: move.from,
              to: move.to,
            },
          });
        }
      }
      const shared = [
        paths.cwdHistoryFile(),
        join(dirname(paths.cwdHistoryFile()), "HISTORY.legacy.md"),
        paths.cwdSessionBindingsFile(),
        docBranchLedgerPath(paths),
      ];
      const files = [
        ...shared,
        ...plan.moves.flatMap((move) => [
          join(paths.cwdSessionsDir(), move.from, ".custody.json"),
          join(paths.cwdSessionsDir(), move.from, ".flow-run.json"),
          paths.cwdFlowAttemptsFile(move.from),
        ]),
        ...transfers.map((transfer) => transfer.path),
      ];
      const before = new Map<string, string | null>();
      for (const path of files)
        before.set(path, (await fs.exists(path)) ? await fs.readText(path) : null);
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
        for (const move of plan.moves) {
          await moveSessionIdentityLocked(fs, paths, move);
          completed.push(move);
        }
        await fs.remove(renumberJournalPath(paths));
      } catch (error) {
        const recordedBefore = await readClaimEventsRaw(fs, paths);
        const reversals = new Map<string, { transfer: ClaimTransfer; claim: ClaimIdentity }>();
        for (const transfer of transfers) {
          if (
            !recordedBefore.events.some(
              (item) =>
                item.transfer?.id === transfer.transfer.id && item.event === "transfer-confirmed",
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
        for (const move of completed.reverse()) {
          await fs.rename(
            join(paths.cwdSessionsDir(), move.to),
            join(paths.cwdSessionsDir(), move.from),
          );
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
        const recorded = await readClaimEventsRaw(fs, paths);
        for (const transfer of transfers) {
          const matching = recorded.events.filter(
            (item) => item.transfer?.id === transfer.transfer.id,
          );
          if (matching.some((item) => item.event === "transfer-confirmed")) {
            const reversal = reversals.get(transfer.transfer.id);
            if (!reversal)
              throw new Error(`falta intención de reversión para ${transfer.transfer.id}`);
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
        await fs.remove(renumberJournalPath(paths));
        throw error;
      }
      return { moved: plan.moves, blocked: [] };
    } finally {
      for (const guard of guards.reverse()) {
        if ((await fs.exists(guard.moved)) && (await fs.readText(guard.moved)) === guard.bytes)
          await fs.remove(guard.moved);
        await guard.lock.release();
      }
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
  } catch (error) {
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
    throw error;
  }
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
  if (plan.markers.length > 0) {
    const published = await publishArtifacts(
      fs,
      plan.workspace,
      plan.markers.map((hub) => ({
        path: relative(plan.workspace, hub.path),
        content: hub.text,
        overwrite: true,
      })),
    );
    if (!published.ok) throw new Error(published.failure.message);
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
      date: seed.date,
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
    rows_without_date: plan.rows.filter((seed) => seed.date === "—").map((seed) => seed.folder),
    conflicts: plan.conflicts,
    next_correlative: plan.next_correlative,
  };
}
