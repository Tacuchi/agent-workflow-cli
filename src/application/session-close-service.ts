import { createHash } from "node:crypto";
import { join } from "node:path";
import { leadingCorrelative } from "../domain/correlative.js";
import { FOLDER_RESERVATION_MARKER, reservationMarker } from "../domain/reservation.js";
import { stripNarrativeBlock } from "../domain/session/narrative.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { CommitReceipt, GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import {
  appendClaimEvent,
  readClaimEvents,
  releaseAlreadyRecorded,
  wasPublished,
} from "./claims-ledger.js";
import { localDateIso } from "./dates.js";
import { locateRun, readRun } from "./flow/run-state-service.js";
import { readHistoryRows } from "./history-table.js";
import { historyFields, sharedNumberError, upsertHistoryRow } from "./history-update-service.js";
import { withCwdLock } from "./lock-service.js";
import { parseMdSectionBilingual } from "./markdown.js";
import { readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { readScriptsArtifacts } from "./release-data/artifacts.js";
import { listGraduatedBundles } from "./release-data/bundles.js";
import {
  archiveSessionMinimum,
  copySessionEvidence,
  sessionScratchReferences,
} from "./session-archive-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { invalidateBindingsTo } from "./session-binding-service.js";
import { readCustody } from "./session-custody-service.js";
import { writeSessionNarrative } from "./session-narrative.js";
import {
  ABANDONED_MARKER,
  CLOSED_MARKER,
  PAUSED_MARKER,
  type SessionEntry,
  type SessionResolutionError,
  resolveSessionTarget,
  sessionsSharingNumber,
} from "./session-resolver.js";
import { type WorkspaceCommitProposal, runWorkspaceCommit } from "./workspace-commit-service.js";

export interface SessionCloseInput {
  code?: string;
  force?: boolean;
  abandon?: boolean;
  /** Explicit consent to copy cited scratchpad files into the versioned minimum. */
  withEvidence?: boolean;
  /** Optional refs for the HISTORY row (`kind:val` CSV; free text renders as-is). */
  refs?: string;
  /**
   * Refuse to close while the session still holds an isolation unit.
   *
   * OFF by default, and the asymmetry is the decision: a person running
   * `aw session-close` is closing a line on purpose and may have reasons this
   * service cannot see, so it gets the receipt and the close. A FLOW finalizing
   * itself is not deciding anything — it is reporting that a run is over — and a
   * run whose result still lives only on `aw/<session>` is not over. So the
   * directed close passes this, and the refusal is what keeps "finished" from
   * being written over work no branch anybody reads contains.
   */
  requireIntegrated?: boolean;
  /** Workspace-relative reservations still backing an unpublished proposal. */
  preserveReservations?: readonly string[];
}

export interface SessionCloseOutput {
  code: string;
  folder: string;
  closed: boolean;
  checkpoint_path: string;
  backlog_path: string;
  refs?: string;
  /** HISTORY.md row upsert performed by close (durable record of closed work). */
  history?: { action: string; state: string };
  /** Non-fatal: close succeeds even if the HISTORY write failed. */
  history_error?: string;
  /** Conversation associations dropped because they pointed at this session. */
  bindings_invalidated: number;
  /**
   * Units this session still holds, with the command that integrates each one.
   *
   * Closing does NOT integrate and does not release: the work in a unit is
   * commits nobody has merged yet, and a close that quietly disposed of them
   * would be the one way this feature could lose work. So the close SAYS it,
   * and leaves the decision where it belongs.
   */
  pending_integration?: Array<{
    alias: string;
    branch: string;
    path: string;
    command: string;
    dirty?: boolean | null;
  }>;
  /**
   * How to get back to a session that closed still holding units.
   *
   * Reported beside `pending_integration` and only with it, because without it
   * the receipt hands out a command that no longer works: every integrate command
   * above resolves its session, and a closed one is refused. Naming the reopen is
   * what keeps the remedy usable after the act that made it necessary.
   */
  reopen?: string;
  /** Pending work preserved by the owning flow before closing at a boundary. */
  pending_work?: string[];
  /** Read-only guidance from the run's effective decision notes. */
  outdated_documents?: string[];
  /**
   * Non-fatal, and never silent: the isolation state could not be read.
   *
   * Same rule as `reservations_error`, for the same reason — an absent
   * `pending_integration` beside this field means "nobody could tell", which is
   * a different fact from "there was nothing to integrate".
   */
  pending_integration_error?: string;
  /** Sources with no resolvable location here: their units could not be verified. */
  unverifiable_sources?: Array<{ alias: string; reason: string }>;
  /**
   * Numbering reservations this session held and never completed, now removed.
   *
   * The opposite decision from a unit, for the opposite reason: a unit holds
   * commits nobody merged, and a reservation holds NOTHING — it is a claimed
   * correlative whose document was never written. Leaving it behind is what put
   * empty files in `docs/plans` that later readers had to interpret. Only slots
   * still holding exactly this session's marker are released; anything published,
   * edited or owned elsewhere is left alone.
   */
  reservations_released?: string[];
  /**
   * Non-fatal: close succeeds even if the reservations could not be scanned.
   *
   * Reported rather than swallowed, for the same reason `history_error` is: a
   * slot that could not be given back is still held, and an empty
   * `reservations_released` would say "there was nothing to release".
   */
  reservations_error?: string;
  /** Non-blocking reminder: migration SQL not traced by a published bundle. */
  sql_pending_export?: { files: string[]; command: string };
  sql_pending_export_error?: string;
  archive_paths?: string[];
  archive_error?: string;
  commit_proposal?: WorkspaceCommitProposal;
  commit_proposal_error?: string;
  commit_receipt?: CommitReceipt;
  commit_error?: string;
  scratch_references?: string[];
  evidence_copied?: string[];
}

export interface SessionCloseFullOutput {
  sessionClose: SessionCloseOutput;
}

/** The close that did NOT happen, and everything needed to make it possible. */
export interface SessionCloseHeldOutput {
  sessionHeld: {
    code: string;
    folder: string;
    closed: false;
    reason: string;
    pending_integration: NonNullable<SessionCloseOutput["pending_integration"]>;
    /** One call that integrates every unit of this session, in alias order. */
    integrate: string;
  };
}

export interface SessionCloseError {
  error: string;
  code?: string;
}

export type SessionCloseResult =
  | SessionCloseFullOutput
  | SessionCloseHeldOutput
  | SessionCloseError
  | { sessionError: SessionResolutionError };

export async function runSessionClose(
  fs: FileSystemPort,
  paths: PathsService,
  input: SessionCloseInput,
  isolation?: IsolationReader,
  git?: GitPort,
  process?: ProcessPort,
): Promise<SessionCloseResult> {
  if (await fs.exists(join(paths.cwdRoot(), "renumber-pending.json"))) {
    try {
      const { recoverRenumberJournal } = await import("./workspace-migrate/apply.js");
      await recoverRenumberJournal(fs, paths);
    } catch (error) {
      return {
        error: `renumerado pendiente: ${error instanceof Error ? error.message : String(error)}`,
        code: "SESSION_RENUMBER_PENDING",
      };
    }
  }
  // Closing is destructive to continuity: it always names its target. Falling
  // back to "the sole active one" would let a conversation close a line it
  // never selected.
  if (!input.code) return { error: "--code es obligatorio" };
  const resolution = await resolveSessionTarget(fs, paths, {
    code: input.code,
    allowClosed: true,
    intent: "write",
  });
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;
  if (session.state === "abandoned" && input.abandon !== true) {
    return {
      error: `la sesión ${session.folder} está abandonada; sólo --reopen la reactiva`,
      code: "SESSION_ABANDONED",
    };
  }
  if (input.force !== true && input.abandon !== true) {
    const incomplete = await incompleteSessionReason(fs, session.path);
    if (incomplete !== null) return { error: incomplete, code: "SESSION_INCOMPLETE" };
  }

  // The record indexes rows by number, so two folders sharing one means this
  // close could only register by overwriting the other session's row. Asked HERE
  // rather than only inside the primitive: down there the lock is held and
  // `.closed` is already on disk, so the refusal came back as a non-fatal
  // `history_error` on a session that had ALREADY been closed — a half mutation,
  // with the durable record still calling it active and no way to repair it. The
  // whole close is refused instead, and the one remedy is named before anything
  // moves.
  const sharing = await sessionsSharingNumber(fs, paths, session.folder);
  if (sharing.length > 1) return { sessionError: sharedNumberError(session.folder, sharing) };
  let sqlPending: SessionCloseOutput["sql_pending_export"];
  let sqlPendingError: string | undefined;
  try {
    sqlPending = await pendingSqlExport(fs, paths, session);
  } catch (error) {
    sqlPendingError = error instanceof Error ? error.message : String(error);
  }

  // Validate before mutating either the checkpoint or the closed marker.
  const checkpointPath = canonicalArtifactPath(session.path, "checkpoint");

  // BEFORE the marker, and that is the whole of it: `.closed` is what makes the
  // integrate commands below stop resolving, so a check that ran after writing it
  // would be a receipt for a state it had just made harder to leave.
  const units = await heldUnits(isolation, session.folder);
  if (input.requireIntegrated === true && (units.held.length > 0 || units.error !== undefined)) {
    return refuseHeld(session.code ?? input.code, session.folder, units);
  }

  const gitState =
    git === undefined
      ? "fuentes no verificables (sin adaptador git)"
      : await sourceGitState(fs, paths, git);

  const historyFile = paths.cwdHistoryFile();
  const registeredClosed =
    (await fs.exists(historyFile)) &&
    readHistoryRows(await fs.readText(historyFile)).some(
      (row) => row.key === session.folder && row.state === "closed",
    );
  const needsRefs = !registeredClosed;
  let published: string | undefined;
  try {
    published = needsRefs ? await publishedRefs(fs, session.path) : undefined;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      code: "SESSION_CUSTODY_UNREADABLE",
    };
  }
  const run = needsRefs ? await readRun(fs, locateRun(paths, session.folder)) : null;
  const plan = run?.ok ? run.state.scope?.plan : undefined;
  const refs =
    [input.refs?.trim(), published, plan].filter((item) => item && item.length > 0).join(",") ||
    undefined;
  const closure = await closeUnderLock(
    fs,
    paths,
    session,
    {
      code: session.code ?? input.code,
      ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
    },
    checkpointPath,
    gitState,
    input.force === true || input.abandon === true,
    input.abandon === true,
    input.preserveReservations ?? [],
    input.withEvidence === true,
  );
  if ("error" in closure) return closure;

  const sessionClose: SessionCloseOutput = {
    code: session.code ?? input.code,
    folder: session.folder,
    closed: true,
    checkpoint_path: checkpointPath,
    backlog_path: canonicalArtifactPath(session.path, "backlog"),
    ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
    bindings_invalidated: closure.bindings_invalidated,
    ...(closure.history ? { history: closure.history } : {}),
    ...(closure.history_error !== undefined ? { history_error: closure.history_error } : {}),
    ...(sqlPending === undefined ? {} : { sql_pending_export: sqlPending }),
    ...(sqlPendingError === undefined ? {} : { sql_pending_export_error: sqlPendingError }),
    ...(closure.archive_paths === undefined ? {} : { archive_paths: closure.archive_paths }),
    ...(closure.archive_error === undefined ? {} : { archive_error: closure.archive_error }),
    ...(closure.scratch_references?.length
      ? { scratch_references: closure.scratch_references }
      : {}),
    ...(closure.evidence_copied?.length ? { evidence_copied: closure.evidence_copied } : {}),
  };
  reportHeld(sessionClose, session.folder, units);
  reportReservations(sessionClose, closure.reservations);
  if (git && process) {
    const offer = await runWorkspaceCommit(fs, git, process, paths, { code: session.folder });
    if ("proposal" in offer) sessionClose.commit_proposal = offer.proposal;
    else sessionClose.commit_proposal_error = offer.error;
  }
  return { sessionClose };
}

async function incompleteSessionReason(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<string | null> {
  const file = join(sessionPath, "SESSION.md");
  if (!(await fs.exists(file))) return null; // historical sessions without this artifact
  const text = stripNarrativeBlock(await fs.readText(file));
  const origin = parseMdSectionBilingual(text, "Origin");
  if (
    origin !== undefined &&
    !origin.split("\n").some((line) => {
      const value = line.trim();
      return value !== "" && value !== "-" && !value.startsWith("<!--");
    })
  )
    return "SESSION.md tiene ## Origin en blanco; completalo antes de cerrar";
  const criteria = parseMdSectionBilingual(text, "Success criteria");
  if (criteria === undefined) return null;
  for (const match of criteria.matchAll(/^\s*[-*]\s*\[\s\]\s*(.+)?$/gm)) {
    const text = match[1]?.trim() ?? "";
    if (
      !/(?:\braz[oó]n\b|\bmotivo\b|\bporque\b|\bbloquead[oa]\b|\bpendiente por\b|—\s+\S)/i.test(
        text,
      )
    ) {
      return `SESSION.md tiene un criterio sin marcar y sin razón escrita: ${text || "(vacío)"}`;
    }
  }
  return null;
}

async function pendingSqlExport(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
): Promise<SessionCloseOutput["sql_pending_export"]> {
  const scripts = (await readScriptsArtifacts(fs, session.path)).filter(
    (file) => !file.is_rollback,
  );
  if (scripts.length === 0) return undefined;
  const bundles = await listGraduatedBundles(fs, paths.workspaceDir(), paths);
  const exported = new Set<string>();
  for (const bundle of bundles) {
    const manifest = join(bundle.path, "bundle.json");
    if (!(await fs.exists(manifest))) continue;
    try {
      const parsed: unknown = JSON.parse(await fs.readText(manifest));
      if (typeof parsed !== "object" || parsed === null) continue;
      const origin = (
        parsed as {
          origin?: { sessions?: Array<{ session: string; files: Array<{ digest: string }> }> };
        }
      ).origin;
      for (const entry of origin?.sessions ?? []) {
        if (entry.session === session.folder)
          for (const file of entry.files) exported.add(file.digest);
      }
    } catch {
      /* A bundle without readable metadata cannot claim this SQL. */
    }
  }
  const pending: string[] = [];
  for (const file of scripts) {
    const text = await fs.readText(file.path);
    if (
      /--\s*\[Q\d+\].*Type:\s*A\b/i.test(text) &&
      !/--\s*(?:\[M\d+\]|@category:\s*0[1-5]|Type:\s*B\b)/i.test(text)
    )
      continue;
    if (
      !/(?:--\s*(?:\[M\d+\]|@category:\s*0[1-5]|Type:\s*B\b)|\b(?:CREATE|ALTER|DROP|UPDATE|DELETE|INSERT|GRANT|REVOKE|TRUNCATE)\b)/i.test(
        text,
      )
    )
      continue;
    const digest = `sha256:${createHash("sha256")
      .update(await fs.readBytes(file.path))
      .digest("hex")}`;
    if (!exported.has(digest)) pending.push(file.name);
  }
  return pending.length > 0
    ? {
        files: pending,
        command: `aw export-scripts prepare --sessions ${leadingCorrelative(session.folder) ?? session.code ?? session.folder}`,
      }
    : undefined;
}

/** Units survived the close: say so, and say how to come back for them. */
function reportHeld(output: SessionCloseOutput, folder: string, units: HeldUnits): void {
  if (units.error !== undefined) output.pending_integration_error = units.error;
  if (units.unverifiable.length > 0) output.unverifiable_sources = units.unverifiable;
  if (units.held.length === 0) return;
  output.pending_integration = units.held;
  output.reopen = `aw session-resume --code ${folder} --reopen`;
}

function reportReservations(
  output: SessionCloseOutput,
  reservations: { released: string[]; error?: string },
): void {
  if (reservations.released.length > 0) output.reservations_released = reservations.released;
  if (reservations.error !== undefined) output.reservations_error = reservations.error;
}

/** The close that stopped, told so the reader can act without asking anything else. */
function refuseHeld(code: string, folder: string, units: HeldUnits): SessionCloseHeldOutput {
  return {
    sessionHeld: {
      code,
      folder,
      closed: false,
      reason:
        units.error !== undefined
          ? `no se pudo comprobar si la sesión conserva unidades — ${units.error}`
          : `la sesión todavía tiene ${units.held.length} unidad(es) sin integrar: su trabajo son commits que no están en ninguna rama de trabajo`,
      pending_integration: units.held,
      integrate: `aw worktree integrate --code ${folder}`,
    },
  };
}

/** Reads this workspace's live isolation units; absent when the caller has no git port. */
export type IsolationReader = () => Promise<
  | Array<{ alias: string; session: string; path: string; branch: string; dirty?: boolean | null }>
  | {
      units: Array<{
        alias: string;
        session: string;
        path: string;
        branch: string;
        dirty?: boolean | null;
      }>;
      unreadable: Array<{ alias: string; error: string; code?: string }>;
    }
>;

/** What the session holds, and whether that reading could be made at all. */
interface HeldUnits {
  held: NonNullable<SessionCloseOutput["pending_integration"]>;
  error?: string;
  unverifiable: NonNullable<SessionCloseOutput["unverifiable_sources"]>;
}

/**
 * The units this session holds — or the fact that nobody could tell.
 *
 * The two are different answers and this used to flatten them into one: an
 * unreadable isolation state came back as an empty list, which reads as "there is
 * nothing to integrate". Harmless while closing only REPORTED; not harmless now
 * that it can refuse, because the one state that must never close silently is
 * exactly the one whose evidence could not be read.
 */
async function heldUnits(
  isolation: IsolationReader | undefined,
  folder: string,
): Promise<HeldUnits> {
  if (isolation === undefined) return { held: [], unverifiable: [] };
  let inventory: Awaited<ReturnType<IsolationReader>>;
  try {
    inventory = await isolation();
  } catch (error) {
    return {
      held: [],
      unverifiable: [],
      error: `no se pudieron leer las unidades de ${folder}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const units = Array.isArray(inventory) ? inventory : inventory.units;
  const unreadable = Array.isArray(inventory) ? [] : inventory.unreadable;
  const unverifiable = unreadable
    .filter((item) => item.code === "SOURCE_PATH_MISSING")
    .map((item) => ({ alias: item.alias, reason: item.error }));
  const otherErrors = unreadable.filter((item) => item.code !== "SOURCE_PATH_MISSING");
  return {
    unverifiable,
    ...(otherErrors.length > 0
      ? {
          error: `inventario ilegible: ${otherErrors.map((item) => `${item.alias}: ${item.error}`).join("; ")}`,
        }
      : {}),
    held: units
      .filter((u) => u.session === folder)
      .map((u) => ({
        alias: u.alias,
        branch: u.branch,
        path: u.path,
        ...(u.dirty === undefined ? {} : { dirty: u.dirty }),
        command: `aw worktree integrate --source ${u.alias} --code ${folder}`,
      })),
  };
}

/**
 * Give back every correlative this session claimed and never wrote into.
 *
 * Bytes-exact and owner-scoped, which is the whole safety argument: the only
 * files it can remove are the ones still holding this session's own marker, so a
 * published document, a slot somebody edited and another session's reservation
 * are all invisible to it. Non-fatal — a close that failed over garbage
 * collection would strand a session — but never silent: what it could not scan
 * comes back as the error beside what it did release, because an empty list and
 * an unreadable directory are different facts.
 *
 * The scan walks every immediate subdirectory of `docs/`, not a list of
 * categories: the claim mechanism is category-agnostic, and a hardcoded list is a
 * second place to update the day something else claims a number.
 */
async function releaseReservations(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
  preserve: readonly string[],
): Promise<{ released: string[]; error?: string }> {
  const marker = reservationMarker(folder);
  const docs = join(paths.workspaceDir(), "docs");
  const retained = new Set(preserve.map((path) => join(paths.workspaceDir(), path)));
  const released: string[] = [];
  try {
    const ledger = await readClaimEvents(fs, paths, { lockHeld: true });
    if (ledger.unreadable > 0)
      throw new Error("claims.jsonl no permite liberar reservas con seguridad");
    if (!(await fs.exists(docs))) return { released };
    for (const category of await fs.list(docs)) {
      if (category.type !== "dir") continue;
      for (const entry of await fs.list(category.path)) {
        const correlative = leadingCorrelative(entry.name);
        if (
          (entry.type !== "file" && entry.type !== "dir") ||
          correlative === null ||
          retained.has(entry.path)
        ) {
          continue;
        }
        if (entry.type === "dir") {
          const contents = await fs.list(entry.path);
          if (contents.length !== 1 || contents[0]?.name !== FOLDER_RESERVATION_MARKER) continue;
        }
        if (
          (await fs.readText(
            entry.type === "dir" ? join(entry.path, FOLDER_RESERVATION_MARKER) : entry.path,
          )) !== marker
        )
          continue;
        // The record goes in BEFORE the file is removed, and the order is the
        // whole safety argument. Recording after would leave a window — an I/O
        // error, a Ctrl-C, a SIGKILL — where the marker is already gone and no
        // line says the correlative came back: a number freed with zero durable
        // trace, which is exactly the state this ledger exists to end.
        //
        // Reversed, the worst case is a conservative OVER-statement: a `released`
        // record for a marker still on disk. A retry or a recovery reconciles
        // that; nothing reconciles a silent deletion. Same doctrine the baseline
        // seal follows — before, not after, and not only on success.
        const claim = {
          category: category.name,
          correlative,
          name: entry.name.slice(correlative.length + 1),
          owner: folder,
        };
        if (wasPublished(ledger.events, claim)) continue;
        if (!releaseAlreadyRecorded(ledger.events, claim)) {
          await appendClaimEvent(fs, paths, {
            at: new Date().toISOString(),
            event: "released",
            claim,
            cause: "aw session-close: la reserva seguía intacta al cerrar su sesión",
          });
        }
        await fs.remove(entry.path);
        released.push(`docs/${category.name}/${entry.name}`);
      }
    }
  } catch (error) {
    return {
      released: released.sort(),
      error: `no se pudo revisar las reservas de ${folder} en docs/: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { released: released.sort() };
}

interface Closure {
  bindings_invalidated: number;
  reservations: { released: string[]; error?: string };
  archive_paths?: string[];
  archive_error?: string;
  scratch_references?: string[];
  evidence_copied?: string[];
  history?: { action: string; state: string };
  history_error?: string;
}

/**
 * The whole shared-state mutation of a close, under ONE lock acquisition:
 * invalidate the associations pointing here, write the `.closed` marker, upsert
 * the HISTORY row. HISTORY goes through the lock-free primitive on purpose —
 * its public command takes the lock itself, and nesting would deadlock.
 *
 * The registry goes FIRST: if it cannot be read, the close aborts having
 * mutated nothing, rather than leaving a closed session that conversations are
 * still associated with.
 */
async function closeUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  row: { code: string; refs?: string },
  checkpointPath: string,
  gitState: string,
  force: boolean,
  abandon: boolean,
  preserveReservations: readonly string[],
  withEvidence: boolean,
): Promise<Closure | SessionCloseError> {
  // `failure` (not `error`) so the busy-lock envelope `withCwdLock` returns
  // stays distinguishable from a failure raised inside the critical section.
  type Locked = { ok: true; closure: Closure } | { ok: false; failure: SessionCloseError };

  const result = await withCwdLock(fs, paths, async (): Promise<Locked> => {
    if (!(await fs.exists(session.path))) {
      return {
        ok: false,
        failure: {
          error: `${session.folder} cambió de nombre antes del cierre; resolvé otra vez la sesión`,
          code: "SESSION_RENUMBER_STALE",
        },
      };
    }
    const currentSharing = await sessionsSharingNumber(fs, paths, session.folder);
    if (currentSharing.length > 1) {
      return {
        ok: false,
        failure: {
          error: `el número de ${session.folder} volvió a colisionar; ejecutá aw workspace-migrate --renumber`,
          code: "SESSION_AMBIGUOUS",
        },
      };
    }
    const checkpoint = (await fs.exists(checkpointPath))
      ? await fs.readText(checkpointPath)
      : "# CHECKPOINT\n\n## Completed\n\n## Pending / Next\n";
    // A retry after an approved exceptional close must finish finalize even if
    // the previous process died after writing .closed but before recording it.
    if (
      !force &&
      !(await fs.exists(join(session.path, CLOSED_MARKER))) &&
      /_\[AI:[^\n]*\]_/.test(checkpoint)
    ) {
      return {
        ok: false,
        failure: {
          error: "CHECKPOINT contiene placeholders sin llenar; completalos o usá --force",
          code: "CHECKPOINT_INCOMPLETE",
        },
      };
    }
    let body = checkpoint.replace(/\n+## Closure\n\n- Cierre: [^\n]*\n?/g, "").trimEnd();
    if (!/^## (?:Completed|Last action|Lo (?:último|ultimo) que hice)\s*$/m.test(body)) {
      body += "\n\n## Completed";
    }
    if (!/^## (?:Pending \/ Next|Pending|Next step|Pr(?:ó|o)ximo paso)\s*$/m.test(body)) {
      body += "\n\n## Pending / Next";
    }
    const invalidated = await invalidateBindingsTo(fs, paths, session.folder);
    if (!invalidated.ok) {
      return { ok: false, failure: { error: invalidated.reason, code: "SESSION_BINDING_INVALID" } };
    }
    await fs.writeText(join(session.path, CLOSED_MARKER), "");
    if (abandon) await fs.writeText(join(session.path, ABANDONED_MARKER), "");
    await fs.remove(join(session.path, PAUSED_MARKER));
    // Never claim closure in the CHECKPOINT before the marker exists. A write
    // failure afterwards can be repaired by the idempotent close retry.
    await fs.writeText(checkpointPath, `${body}\n\n## Closure\n\n- Cierre: ${gitState}\n`);
    const closure: Closure = {
      bindings_invalidated: invalidated.removed,
      reservations: { released: [] },
    };
    try {
      const history = await upsertHistoryRow(
        fs,
        paths,
        historyFields(
          { ...row, state: abandon ? "abandoned" : "closed", date: localDateIso(new Date()) },
          session,
          row.code,
        ),
      );
      closure.history = { action: history.action, state: history.state };
    } catch (err) {
      // Non-fatal, as before: the caller re-runs `aw history-update` on this.
      closure.history_error = err instanceof Error ? err.message : String(err);
    }
    // The same workspace lock excludes renumbering while checking and releasing
    // the marker; a close must not release a claim another session just acquired.
    closure.reservations = await releaseReservations(
      fs,
      paths,
      session.folder,
      preserveReservations,
    );
    // The narrative belongs to the same locked identity as the marker, HISTORY
    // and reservation sweep. A concurrent renumber cannot move it in between.
    await writeSessionNarrative(fs, paths, { folder: session.folder, path: session.path });
    try {
      closure.scratch_references = await sessionScratchReferences(fs, session.path);
      if (withEvidence)
        closure.evidence_copied = await copySessionEvidence(
          fs,
          session.path,
          closure.scratch_references,
        );
      closure.archive_paths = await archiveSessionMinimum(fs, paths, session.folder, session.path);
    } catch (error) {
      closure.archive_error = `no se pudo archivar el mínimo: ${error instanceof Error ? error.message : String(error)}; reintentá aw session-close --code ${session.folder}`;
    }
    return { ok: true, closure };
  });

  if ("error" in result) return { error: result.error, code: "LOCK_BUSY" };
  return result.ok ? result.closure : result.failure;
}

async function publishedRefs(fs: FileSystemPort, sessionPath: string): Promise<string | undefined> {
  const custody = await readCustody(fs, sessionPath);
  if (custody.status === "unreadable") throw new Error(custody.reason);
  if (custody.status !== "present") return undefined;
  const paths = new Set(
    custody.custody.effects
      .filter((effect) => effect.kind === "artifact_published")
      .flatMap((effect) => effect.paths),
  );
  return paths.size === 0 ? undefined : [...paths].sort().join(",");
}

async function sourceGitState(
  fs: FileSystemPort,
  paths: PathsService,
  git: GitPort,
): Promise<string> {
  const block = await readWorkspaceBlock(fs, paths.workspaceDir(), paths.blockMarkers());
  if (!block || block.fuentes.length === 0) return "sin fuentes declaradas";
  const result: string[] = [];
  for (const source of block.fuentes) {
    if (source.path === null) {
      result.push(`${source.alias}: ruta no disponible`);
      continue;
    }
    try {
      const branch = await git.currentBranch(source.path);
      if (!branch) {
        result.push(`${source.alias}: rama no disponible`);
        continue;
      }
      const upstream = await git.upstreamBranch(source.path, branch);
      if (upstream === null) {
        result.push(`${source.alias}: ${branch}, sin upstream, publicada: no`);
        continue;
      }
      const { ahead, behind } = await git.aheadBehind(source.path, branch, upstream);
      result.push(
        `${source.alias}: ${branch}, upstream ${upstream}, adelante ${ahead}, atrás ${behind}, publicada: ${upstream.startsWith("refs/remotes/") && upstream.endsWith(`/${branch}`) && ahead === 0 ? "sí" : "no"}`,
      );
    } catch (error) {
      result.push(
        `${source.alias}: estado git no disponible (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return result.join("; ");
}
