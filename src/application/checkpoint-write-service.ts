import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { findActiveSessions } from "./checkpoint-service.js";
import { totalInScope } from "./checkpoint/files-touched.js";
import {
  appendSealedBlock,
  blocksUnder,
  formatCheckpointMd,
  isPristineCheckpoint,
} from "./checkpoint/markdown.js";
import { extractSessionState } from "./checkpoint/state-reader.js";
import { localMinuteIso, parseLocalMinuteIso } from "./dates.js";
import {
  type LifecycleDegraded,
  type LifecycleOptions,
  resolveLifecycleTarget,
} from "./lifecycle-target.js";
import { withCwdLock } from "./lock-service.js";
import { parseMdValue } from "./markdown.js";
import { type PathsService, resolveWorkspaceRoot } from "./paths-service.js";
import { relpath } from "./paths.js";
import { hashContextId } from "./session-binding-service.js";
import { writeSessionNarrative } from "./session-narrative.js";
import { readSessionState } from "./session-resolver.js";
import type { SessionCandidate, SessionEntry } from "./session-resolver.js";

// This module deliberately owns NO placeholder marker of its own. `_[AI:` used
// to be declared here as well as in `checkpoint-service.ts`, with incompatible
// meanings: over there it classifies a checkpoint as a draft that still needs
// the agent (coherent, and it stays), here it granted permission to destroy the
// file. Since the template always emits the marker, that permission was
// permanent. Provenance decides who may overwrite now, and the one surviving
// marker means one thing only.

/** Said to the caller whenever content was kept instead of being regenerated. */
const PRESERVED_REASON =
  "CHECKPOINT.md tiene contenido escrito y se conservó; pasar --force para regenerarlo";

export interface CheckpointWriteOutput {
  session: string;
  checkpoint_path: string;
  lines_written?: number;
  progress_pct?: number | null;
  tasks_open?: number;
  tasks_closed?: number;
  files_touched_count?: number;
  skipped?: boolean;
  /** The existing CHECKPOINT had content: nothing was written, nothing was lost. */
  preserved?: true;
  reason?: string;
  /**
   * Refuge checkpoints folded into this session's CHECKPOINT on the way, by
   * workspace-relative path. Absent when there was none to adopt.
   */
  refuge_adopted?: string[];
  /** Refuges nobody could adopt any more, removed on the way (see {@link sweepRefuges}). */
  refuges_swept?: string[];
}

/**
 * The session could not be resolved: the host's compaction goes ahead, Workline
 * writes nothing on any session line and says the continuity is degraded.
 * `primary_session: null` is the point — no active session gets presented as
 * this conversation's line.
 */
export interface CheckpointWriteDegraded {
  skipped: true;
  reason: string;
  continuity: "degraded";
  primary_session: null;
  active_sessions: string[];
  candidates: SessionCandidate[];
  action: string;
  /**
   * Where the state was parked instead, workspace-relative — `null` when there
   * was no active candidate that could ever adopt it (see {@link parkRefuge}).
   */
  refuge_path: string | null;
  refuges_swept?: string[];
}

export type CheckpointWriteResult = CheckpointWriteOutput | CheckpointWriteDegraded;

/** Injectable clock for the refuge's date, its adoption window and the sweep. */
export interface RefugeClock {
  now?: Date;
}

export interface CheckpointWriteOptions extends LifecycleOptions, RefugeClock {
  force?: boolean;
}

/**
 * PreCompact payload. `--code` used to be honoured only for legacy
 * `sessionNNN-*` folders, so a perfectly unambiguous current-model code was
 * silently skipped whenever a second session was active. It now goes through
 * the canonical resolver like everything else.
 */
export async function runCheckpointWrite(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  options: CheckpointWriteOptions = {},
): Promise<CheckpointWriteResult> {
  // Binds: writing a CHECKPOINT and refreshing SESSION.md IS this conversation
  // claiming the line, and the next hook run (which carries no `--code`) needs
  // the association to land on the same one.
  const target = await resolveLifecycleTarget(fs, paths, options, "bind");
  if (target.outcome !== "resolved") return unresolved(fs, paths, target, options);
  const session = target.session;
  const now = options.now ?? new Date();
  const cpPath = join(session.path, "CHECKPOINT.md");

  const locked = await withCwdLock(fs, paths, () =>
    writeResolvedCheckpoint(fs, env, git, paths, session, options, now, cpPath),
  );
  if (!("error" in locked)) return locked;
  const reason = `no se pudo escribir CHECKPOINT.md: ${locked.error}`;
  const candidate: SessionCandidate = {
    folder: session.folder,
    code: session.code,
    state: "active",
  };
  const refugePath = await writeRefugeCheckpoint(fs, paths, {
    reason,
    action: `reintentá 'aw checkpoint-write --code ${session.folder}'`,
    candidates: [candidate],
    unique: true,
    ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
    now,
  });
  return {
    skipped: true,
    reason,
    continuity: "degraded",
    primary_session: null,
    active_sessions: [session.folder],
    candidates: [candidate],
    action: `aw checkpoint-write --code ${session.folder}`,
    refuge_path: refugePath,
  };
}

async function writeResolvedCheckpoint(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  session: SessionEntry,
  options: CheckpointWriteOptions,
  now: Date,
  cpPath: string,
): Promise<CheckpointWriteResult> {
  if ((await readSessionState(fs, session.path)) !== "active") {
    return {
      session: session.folder,
      checkpoint_path: cpPath,
      skipped: true,
      reason: "sesión cerrada",
    };
  }
  if (await hasContentToPreserve(fs, cpPath, options.force === true)) {
    // Adoption runs even here: preservation protects written prose from being
    // REGENERATED, and folding a refuge in only appends to it.
    const adopted = await adoptRefuge(fs, paths, session, adoptionScope(options, now));
    return {
      session: session.folder,
      checkpoint_path: cpPath,
      skipped: true,
      preserved: true,
      reason: PRESERVED_REASON,
      ...adoptedField(adopted.adopted),
      ...sweptField(await sweepRefuges(fs, paths, now)),
    };
  }

  // Read BEFORE the write that replaces it: an adopted refuge is not part of any
  // template, so regenerating without carrying it across would drop the state
  // the refuge existed to save (its file on disk is long gone).
  const carried = await carriedAdoptions(fs, cpPath);

  // The workspace root rather than the raw cwd. Today the two coincide by
  // construction — session resolution already refuses to run from a
  // subdirectory, so nothing reaches here with a deeper cwd — and what actually
  // bounds the reading is `repoPrefix` inside the collection. This stays the
  // resolved root anyway: it is the value the boundary is DEFINED as, so the
  // day session resolution learns to walk up, the inventory does not silently
  // widen to the parent repository along with it.
  const workspaceRoot = await resolveWorkspaceRoot(fs, env, paths);
  const state = await extractSessionState(fs, git, workspaceRoot, session.path);
  const md = withCarried(formatCheckpointMd(state), carried);
  await fs.mkdirp(session.path);
  await fs.writeText(cpPath, md);
  // The CHECKPOINT is where progress lives, so writing one is exactly when the
  // session's entry point stops being current. Refreshed here and never on a
  // read, which is what keeps a `status` or a `resume` from rewriting history.
  await writeSessionNarrative(fs, paths, { folder: session.folder, path: session.path });

  // Last, never first: a refuge is folded into the checkpoint this run just
  // produced, so the file it appends to is already there.
  const adopted = await adoptRefuge(fs, paths, session, adoptionScope(options, now));

  return {
    session: session.folder,
    checkpoint_path: cpPath,
    lines_written: md.replace(/\n$/, "").split("\n").length,
    progress_pct: state.progress_pct,
    tasks_open: state.tasks.open,
    tasks_closed: state.tasks.closed,
    files_touched_count: totalInScope(state.files_touched),
    ...adoptedField(adopted.adopted),
    ...sweptField(await sweepRefuges(fs, paths, now)),
  };
}

export interface AutoCompactOnCloseOutput {
  /** At most ONE entry: the resolved target, never "every active session". */
  checkpoints_written: Array<{
    session?: string;
    checkpoint_path?: string;
    progress_pct?: number | null;
    skipped?: boolean;
    preserved?: true;
    reason?: string;
    error?: string;
    refuge_adopted?: string[];
  }>;
  continuity?: "degraded";
  primary_session?: null;
  /** Why no session resolved; only on the degraded branch. */
  reason?: string;
  candidates?: SessionCandidate[];
  action?: string;
  /** Same meaning as in {@link CheckpointWriteDegraded}; only on the degraded branch. */
  refuge_path?: string | null;
  refuges_swept?: string[];
}

export interface AutoCompactOnCloseOptions extends LifecycleOptions, RefugeClock {}

/**
 * SessionEnd. It used to iterate EVERY active session, so closing one host
 * conversation wrote checkpoints over lines belonging to others. It now
 * checkpoints the resolved target and nothing else; with no sufficient identity
 * it writes no session line at all and parks a refuge instead.
 */
export async function runAutoCompactOnClose(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  options: AutoCompactOnCloseOptions = {},
): Promise<AutoCompactOnCloseOutput> {
  const now = options.now ?? new Date();
  // Does NOT bind: the host is exiting, so there is no later turn the
  // association could serve, and establishing one is a locked write that fails
  // the whole resolution when it cannot be taken — which would cost the
  // checkpoint this surface exists to save.
  const target = await resolveLifecycleTarget(fs, paths, options, "read-only");
  if (target.outcome !== "resolved") {
    // Park first: the fresh refuge names only active sessions and is stamped
    // now, so the sweep that follows can never take it.
    const refugePath = await parkRefuge(fs, paths, target, options.contextId, now);
    return {
      checkpoints_written: [],
      continuity: "degraded",
      primary_session: null,
      reason: target.reason,
      candidates: target.candidates,
      action: target.action,
      refuge_path: refugePath,
      ...sweptField(await sweepRefuges(fs, paths, now)),
    };
  }
  const locked = await withCwdLock(fs, paths, async (): Promise<AutoCompactOnCloseOutput> => {
    if ((await readSessionState(fs, target.session.path)) !== "active") {
      return {
        checkpoints_written: [
          { session: target.session.folder, skipped: true, reason: "sesión cerrada" },
        ],
      };
    }
    const workspaceRoot = await resolveWorkspaceRoot(fs, env, paths);
    const entry = await writeCheckpointForTarget(fs, git, workspaceRoot, target.session);
    // Only over a checkpoint that exists: a failed write cannot adopt its refuge.
    if (entry.error === undefined) {
      const adopted = await adoptRefuge(fs, paths, target.session, adoptionScope(options, now));
      return {
        checkpoints_written: [{ ...entry, ...adoptedField(adopted.adopted) }],
        ...sweptField(await sweepRefuges(fs, paths, now)),
      };
    }
    return { checkpoints_written: [entry], ...sweptField(await sweepRefuges(fs, paths, now)) };
  });
  if (!("error" in locked)) return locked;
  const reason = `no se pudo escribir CHECKPOINT.md: ${locked.error}`;
  const candidate: SessionCandidate = {
    folder: target.session.folder,
    code: target.session.code,
    state: "active",
  };
  const refugePath = await writeRefugeCheckpoint(fs, paths, {
    reason,
    action: `reintentá 'aw checkpoint-write --code ${target.session.folder}'`,
    candidates: [candidate],
    unique: true,
    ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
    now,
  });
  return {
    checkpoints_written: [{ session: target.session.folder, error: locked.error }],
    continuity: "degraded",
    primary_session: null,
    reason,
    candidates: [candidate],
    action: `aw checkpoint-write --code ${target.session.folder}`,
    refuge_path: refugePath,
  };
}

async function writeCheckpointForTarget(
  fs: FileSystemPort,
  git: GitPort,
  workspaceRoot: string,
  session: SessionEntry,
): Promise<AutoCompactOnCloseOutput["checkpoints_written"][number]> {
  const cpPath = join(session.path, "CHECKPOINT.md");
  // No `force` here on purpose: SessionEnd is a hook, and a hook is never the
  // declared intention that AC-02 asks for before overwriting content.
  if (await hasContentToPreserve(fs, cpPath, false)) {
    return {
      session: session.folder,
      checkpoint_path: cpPath,
      skipped: true,
      preserved: true,
      reason: PRESERVED_REASON,
    };
  }
  try {
    const carried = await carriedAdoptions(fs, cpPath);
    const state = await extractSessionState(fs, git, workspaceRoot, session.path);
    const md = withCarried(formatCheckpointMd(state), carried);
    await fs.mkdirp(session.path);
    await fs.writeText(cpPath, md);
    return {
      session: session.folder,
      checkpoint_path: cpPath,
      progress_pct: state.progress_pct,
    };
  } catch (err) {
    return {
      session: session.folder,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

/**
 * The single guard both lifecycle write paths ask before touching the file.
 *
 * Absent file → nothing to lose. Sealed and intact → the CLI's own untouched
 * template, so regenerating it is free. Anything else — filled in, hand-edited,
 * or written by a version that predates the seal — is somebody's work, and only
 * `--force` gets past it.
 */
async function hasContentToPreserve(
  fs: FileSystemPort,
  cpPath: string,
  force: boolean,
): Promise<boolean> {
  if (force) return false;
  if (!(await fs.exists(cpPath))) return false;
  return !isPristineCheckpoint(await fs.readText(cpPath));
}

/**
 * The refuge sections an existing CHECKPOINT already carries.
 *
 * Read before every regeneration and written back after it (see
 * {@link withCarried}). "Preserve" protects somebody's prose; carrying protects
 * the CLI's own folded-in state, which preservation deliberately does NOT cover
 * because a checkpoint the CLI wrote must stay regenerable.
 */
async function carriedAdoptions(fs: FileSystemPort, cpPath: string): Promise<string[]> {
  if (!(await fs.exists(cpPath))) return [];
  return blocksUnder(await fs.readText(cpPath), ADOPTED_HEADING);
}

function withCarried(md: string, carried: string[]): string {
  return carried.reduce((text, block) => appendSealedBlock(text, block), md);
}

async function unresolved(
  fs: FileSystemPort,
  paths: PathsService,
  target: LifecycleDegraded,
  options: CheckpointWriteOptions,
): Promise<CheckpointWriteDegraded> {
  const now = options.now ?? new Date();
  const actives = await findActiveSessions(fs, paths);
  // Same order as SessionEnd's degraded branch: park, then sweep.
  const refugePath = await parkRefuge(fs, paths, target, options.contextId, now);
  return {
    skipped: true,
    reason: target.reason,
    continuity: "degraded",
    primary_session: null,
    active_sessions: actives.map((a) => a.folder),
    candidates: target.candidates,
    action: target.action,
    refuge_path: refugePath,
    ...sweptField(await sweepRefuges(fs, paths, now)),
  };
}

// ── the refuge: state a lifecycle surface saves when no session resolves ─────
//
// This exists because the PreCompact hook stopped being allowed to block (see
// `resolveLifecycleTarget`). Losing the protective pause without replacing it
// would mean the compaction that follows an unresolved target takes the run's
// context away and leaves nothing behind. So the reason, the candidates and the
// way out are written to a file OUTSIDE any session — nothing has to be guessed
// to place it — and the first invocation allowed to adopt it folds it into that
// session's CHECKPOINT (see {@link refugeAdoptable}). One nobody can adopt any
// more is swept (see {@link refugeSweepable}), so the directory never becomes a
// pile of orphans.

/** `- Fecha:` / `- Conversación:` / `- Candidatas:` — the lines adoption reads back. */
const REFUGE_DATE_KEY = "Fecha";
const REFUGE_CONVERSATION_KEY = "Conversación";
const REFUGE_CANDIDATES_KEY = "Candidatas";
const REFUGE_NO_CANDIDATES = "ninguna";
const REFUGE_CANDIDATE_SEPARATOR = " · ";

/**
 * How long a refuge stays reserved for the conversation that parked it.
 *
 * Its candidates are every session active at the time, not its own, so while
 * its conversation can still come back nobody else may fold it in: with runs in
 * parallel the first one to name its session would take everybody's refuges.
 * A day covers a conversation resumed the next morning; past it, a refuge whose
 * candidates are all gone is swept instead of waiting for anybody.
 */
const REFUGE_ADOPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The heading an adopted refuge lands under, inside the CHECKPOINT's sealed body. */
const ADOPTED_HEADING = "## Refugio adoptado";

/**
 * What `- Conversación:` says — and what the file is called — when the host gave
 * no conversation id.
 *
 * Such a refuge cannot be matched to anybody, so only an explicit `--code` on
 * one of its candidates adopts it: a person naming the session IS the missing
 * identity. The name carries no instant on purpose: stamping it would make every
 * compaction of every id-less invocation pile up another file, where the digest
 * case leaves exactly one. One file, latest reason, same rule.
 */
const REFUGE_NO_CONVERSATION = "desconocida";

/**
 * The conversation is named by the SHA-256 of its id, never by the id.
 *
 * Same rule as the bindings registry (`hashContextId`): the host's opaque
 * conversation id never reaches disk in the clear. It also makes the file name
 * safe by construction — 64 hex characters cannot escape a directory — and
 * stable, so a conversation that compacts five times leaves ONE refuge with its
 * latest reason instead of five.
 */
const REFUGE_DIGEST_PREFIX = "sha256:";

export interface RefugeCheckpointInput {
  reason: string;
  action: string;
  candidates: SessionCandidate[];
  contextId?: string;
  /** Injectable clock for the refuge's own `- Fecha:`. */
  now?: Date;
  /** A lock loser must never overwrite a refuge another invocation is adopting. */
  unique?: boolean;
}

/** One parked refuge, as read back from disk. */
export interface RefugeEntry {
  /** Absolute path — what adoption removes. */
  path: string;
  /** Workspace-relative path — what a caller reports. */
  relative: string;
  date: string;
  /** `sha256:…` digest of the owning conversation; `null` when it declared none. */
  conversation: string | null;
  /** The session folders it named as candidates, without their state. */
  candidates: string[];
  /** When it was parked; `null` when its `- Fecha:` cannot be read. */
  parkedAt: Date | null;
  body: string;
}

/** Where the parked state goes, and its workspace-relative path for the caller. */
export async function writeRefugeCheckpoint(
  fs: FileSystemPort,
  paths: PathsService,
  input: RefugeCheckpointInput,
): Promise<string> {
  const now = input.now ?? new Date();
  const digest = input.contextId !== undefined ? hashContextId(input.contextId) : null;
  const dir = paths.cwdSessionsRefugeDir();
  const path = join(
    dir,
    `${digest ?? REFUGE_NO_CONVERSATION}${input.unique ? `-${randomUUID()}` : ""}.md`,
  );
  await fs.mkdirp(dir);
  await fs.writeText(path, refugeBody(input, now, digest));
  return relpath(path, paths.workspaceDir());
}

/**
 * A refuge, but ONLY when somebody could adopt it later — and naming only the
 * sessions that could.
 *
 * A closed session is not a destination: every write refuses it, so listing it
 * would promise an adoption that cannot happen. With no active candidate — a
 * workspace between runs, which is the ordinary state, or a `--code` that named
 * a closed or missing session — the parked file would name nobody, and the
 * notice on stderr is the whole answer.
 */
async function parkRefuge(
  fs: FileSystemPort,
  paths: PathsService,
  target: LifecycleDegraded,
  contextId: string | undefined,
  now: Date,
): Promise<string | null> {
  const candidates = target.candidates.filter((candidate) => candidate.state === "active");
  if (candidates.length === 0) return null;
  return writeRefugeCheckpoint(fs, paths, {
    reason: target.reason,
    action: target.action,
    candidates,
    ...(contextId !== undefined ? { contextId } : {}),
    now,
  });
}

export interface RefugeAdoptionScope {
  contextId?: string;
  /** The invocation named the session itself, which is what adopts a refuge nobody else can. */
  explicitCode?: boolean;
  now?: Date;
}

/** Who is asking to fold a refuge into the session it is writing. */
interface RefugeClaim {
  /** `sha256:…` of the invoking conversation; `null` when the invocation carries no id. */
  conversation: string | null;
  explicitCode: boolean;
  /** Folder of the session being written. */
  session: string;
  now: Date;
}

/**
 * Whether this claim may adopt this refuge.
 *
 * Its own conversation always may, into whichever session it resolves. Anybody
 * else needs an explicit `--code` on one of its candidates, and only once nobody
 * else can claim it: it has no conversation, the invocation cannot say whose it
 * is (hosts that give the agent's commands no id), or the window is over.
 */
function refugeAdoptable(
  refuge: Pick<RefugeEntry, "conversation" | "candidates" | "parkedAt">,
  claim: RefugeClaim,
): boolean {
  if (refuge.conversation !== null && refuge.conversation === claim.conversation) return true;
  if (!claim.explicitCode || !refuge.candidates.includes(claim.session)) return false;
  return (
    refuge.conversation === null ||
    claim.conversation === null ||
    outsideAdoptionWindow(refuge, claim.now)
  );
}

/**
 * Whether nobody can adopt this refuge any more: none of its candidates is
 * active, and its conversation cannot reclaim it either — it has none, or the
 * window is over. Its content is a reason, candidates and an action, never work
 * state, so removing it loses nothing anybody could recover.
 */
export function refugeSweepable(
  refuge: Pick<RefugeEntry, "conversation" | "candidates" | "parkedAt">,
  activeSessions: ReadonlySet<string>,
  now: Date,
): boolean {
  if (refuge.candidates.some((candidate) => activeSessions.has(candidate))) return false;
  return refuge.conversation === null || outsideAdoptionWindow(refuge, now);
}

/**
 * A date that cannot be read counts as outside the window: nobody can show the
 * owning conversation is still inside it, and this module never writes one.
 */
function outsideAdoptionWindow(refuge: Pick<RefugeEntry, "parkedAt">, now: Date): boolean {
  if (refuge.parkedAt === null) return true;
  return now.getTime() - refuge.parkedAt.getTime() > REFUGE_ADOPTION_WINDOW_MS;
}

/**
 * Remove every refuge nobody can adopt any more, and name them.
 *
 * Runs on every lifecycle write, which is also every adoption. Exported so the
 * workspace residue sweep reuses this rule instead of writing a second one.
 * Like adoption, it never throws out of a lifecycle surface: a refuge it could
 * not remove is simply not reported, and the next write tries again.
 */
export async function sweepRefuges(
  fs: FileSystemPort,
  paths: PathsService,
  now: Date = new Date(),
  apply = true,
): Promise<string[]> {
  const swept: string[] = [];
  try {
    const active = new Set((await findActiveSessions(fs, paths)).map((session) => session.folder));
    for (const refuge of await listRefugeCheckpoints(fs, paths)) {
      if (!refugeSweepable(refuge, active, now)) continue;
      if (!apply) {
        swept.push(refuge.relative);
        continue;
      }
      try {
        await fs.remove(refuge.path);
        swept.push(refuge.relative);
      } catch {
        // Left for the next write; reporting it would claim a removal that did not happen.
      }
    }
  } catch {
    // Same contract as adoption: the caller's result stands without the field.
  }
  return swept;
}

/**
 * Fold every refuge this invocation may adopt ({@link refugeAdoptable}) into
 * the session's CHECKPOINT, and remove it.
 *
 * Adding a section is what makes this safe next to the preservation guard: that
 * guard refuses to REGENERATE a written checkpoint, and folding text in takes
 * nothing away from one. It goes in through {@link appendSealedBlock} rather
 * than by appending past the seal, so a checkpoint that was still the CLI's own
 * output stays that way — otherwise the first adoption would freeze the file
 * forever behind "there is content to preserve". Removing the refuge afterwards
 * is not tidying: it is what keeps the next invocation from adopting the same
 * text again — but ONLY once the block is demonstrably in the file, because two
 * concurrent hooks read the same `existing` and the loser's append is not in
 * what finally lands. Removing on the strength of its own write would delete the
 * parked state from both places it existed in. A refuge left on disk costs one
 * more adoption attempt; a refuge deleted for nothing is irrecoverable.
 */
export async function adoptRefuge(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  scope: RefugeAdoptionScope = {},
): Promise<{ adopted: string[] }> {
  const claim: RefugeClaim = {
    conversation: digestOfContext(scope.contextId),
    explicitCode: scope.explicitCode === true,
    session: session.folder,
    now: scope.now ?? new Date(),
  };
  const cpPath = join(session.path, "CHECKPOINT.md");
  const adopted: string[] = [];
  // Nothing that happens in here may throw out of a lifecycle surface: a
  // non-zero exit is how a host HOLDS its compaction, and holding it was the
  // irrecoverable trap these surfaces stopped being allowed to set. A failure
  // reports "nothing adopted" and leaves the refuge for the next invocation.
  try {
    for (const refuge of await listRefugeCheckpoints(fs, paths)) {
      if (!refugeAdoptable(refuge, claim)) continue;
      const block = adoptedBlock(refuge);
      // The block as it reads BACK: the plain-append path collapses the trailing
      // blank line, so only the text up to its last character is what both
      // append paths leave verbatim in the file.
      const folded = block.trimEnd();
      const existing = (await fs.exists(cpPath)) ? await fs.readText(cpPath) : "";
      // Already in there — an earlier run adopted it and could not remove the
      // file, or the run this one raced got there first. The state is safe, so
      // the refuge is spent and appending again would only duplicate it.
      if (existing.includes(folded)) {
        await discardRefuge(fs, refuge.path);
        continue;
      }
      await fs.mkdirp(session.path);
      await fs.writeText(cpPath, appendSealedBlock(existing, block));
      if (!(await fs.readText(cpPath)).includes(folded)) continue;
      await discardRefuge(fs, refuge.path);
      adopted.push(refuge.relative);
    }
  } catch {
    // Deliberately silent: the caller's contract is the checkpoint it already
    // wrote, and `refuge_adopted` is simply absent.
  }
  return { adopted };
}

/**
 * Drop a refuge whose text is in the CHECKPOINT.
 *
 * Cleanup, not the adoption itself: the state is already saved, so a removal
 * that fails must not cost the run. The next invocation finds the file again,
 * recognises its own block and retries the removal.
 */
async function discardRefuge(fs: FileSystemPort, path: string): Promise<void> {
  try {
    await fs.remove(path);
  } catch {
    // Left on disk on purpose. It is re-read, not re-adopted.
  }
}

/**
 * The refuge waiting for this conversation, for a surface that only reports.
 *
 * Symmetric with {@link parkRefuge} on purpose: an invocation with no
 * conversation id parks an ANONYMOUS refuge, so that is exactly the one it must
 * be told about. Cutting off at "no id, no answer" made the one invocation
 * shape that can create such a refuge the only one unable to report it — and in
 * the single channel the model reads, `refuge: null` does not say "I don't
 * know", it says there is none.
 */
export async function findRefugeForContext(
  fs: FileSystemPort,
  paths: PathsService,
  contextId?: string,
): Promise<{ path: string; date: string } | null> {
  const wanted = digestOfContext(contextId);
  const refuges = await listRefugeCheckpoints(fs, paths);
  const found = refuges.find((refuge) => refuge.conversation === wanted);
  return found !== undefined ? { path: found.relative, date: found.date } : null;
}

export async function listRefugeCheckpoints(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<RefugeEntry[]> {
  const dir = paths.cwdSessionsRefugeDir();
  if (!(await fs.exists(dir))) return [];
  const refuges: RefugeEntry[] = [];
  for (const entry of await fs.list(dir)) {
    if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
    const body = await fs.readText(entry.path);
    const conversation = parseMdValue(body, REFUGE_CONVERSATION_KEY);
    const date = parseMdValue(body, REFUGE_DATE_KEY);
    refuges.push({
      path: entry.path,
      relative: relpath(entry.path, paths.workspaceDir()),
      date: date ?? "sin fecha",
      conversation: conversation?.startsWith(REFUGE_DIGEST_PREFIX) ? conversation : null,
      candidates: refugeCandidates(parseMdValue(body, REFUGE_CANDIDATES_KEY)),
      parkedAt: date !== undefined ? parseLocalMinuteIso(date) : null,
      body,
    });
  }
  // Deterministic order, so an adoption of several refuges reads the same way twice.
  return refuges.sort((a, b) => a.path.localeCompare(b.path));
}

/** The folders of a `- Candidatas:` line as {@link refugeBody} writes it: `a (active) · b (active)`. */
function refugeCandidates(line: string | undefined): string[] {
  if (line === undefined || line === REFUGE_NO_CANDIDATES) return [];
  return line
    .split(REFUGE_CANDIDATE_SEPARATOR)
    .map((candidate) => candidate.replace(/\s*\([^)]*\)$/, "").trim())
    .filter((folder) => folder.length > 0);
}

function digestOfContext(contextId?: string): string | null {
  return contextId !== undefined && contextId.trim().length > 0
    ? `${REFUGE_DIGEST_PREFIX}${hashContextId(contextId)}`
    : null;
}

function adoptionScope(options: LifecycleOptions, now: Date): RefugeAdoptionScope {
  return {
    ...(options.contextId !== undefined ? { contextId: options.contextId } : {}),
    explicitCode: (options.code?.trim().length ?? 0) > 0,
    now,
  };
}

function adoptedBlock(refuge: RefugeEntry): string {
  // The refuge's own H1 would land as a second title inside the CHECKPOINT, and
  // the heading below already says where the text came from. Everything else
  // goes in verbatim: an adoption that summarised would be an adoption that loses.
  const body = refuge.body.replace(/^#[^\n]*\n/, "").trim();
  return `${ADOPTED_HEADING} (${refuge.date})\n\n${body}\n\n`;
}

function refugeBody(input: RefugeCheckpointInput, now: Date, digest: string | null): string {
  const candidates = input.candidates
    .map((c) => `${c.folder} (${c.state})`)
    .join(REFUGE_CANDIDATE_SEPARATOR);
  return `${[
    "# CHECKPOINT de refugio",
    "",
    "> Lo escribió un hook de ciclo de vida (PreCompact o SessionEnd): la",
    "> compactación —o el cierre— siguió adelante, pero no se pudo resolver a qué",
    "> sesión pertenece esta conversación, así que su estado queda acá en vez de",
    "> perderse. Lo adopta su conversación en cuanto resuelva una sesión, o un",
    "> `aw checkpoint-write --code <NNN>` sobre una candidata cuando ya nadie más",
    "> puede reclamarlo.",
    "",
    `- ${REFUGE_DATE_KEY}: ${localMinuteIso(now)}`,
    `- ${REFUGE_CONVERSATION_KEY}: ${digest !== null ? `${REFUGE_DIGEST_PREFIX}${digest}` : REFUGE_NO_CONVERSATION}`,
    `- Motivo: ${input.reason}`,
    `- ${REFUGE_CANDIDATES_KEY}: ${candidates.length > 0 ? candidates : REFUGE_NO_CANDIDATES}`,
    `- Acción: ${input.action}`,
  ].join("\n")}\n`;
}

/** Present only when something was actually adopted — an empty list says nothing. */
function adoptedField(adopted: string[]): { refuge_adopted?: string[] } {
  return adopted.length > 0 ? { refuge_adopted: adopted } : {};
}

/** Same rule as {@link adoptedField}, for what the sweep removed. */
function sweptField(swept: string[]): { refuges_swept?: string[] } {
  return swept.length > 0 ? { refuges_swept: swept } : {};
}
