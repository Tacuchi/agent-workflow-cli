import type { FileSystemPort } from "../ports/file-system.js";
import { type UpsertAction, readHistoryRows, upsertRow } from "./history-table.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { renderRefs } from "./render/history-row.js";
import {
  type SessionCandidate,
  type SessionEntry,
  type SessionResolutionError,
  resolveSessionTarget,
  sessionNumericCode,
  sessionsSharingNumber,
} from "./session-resolver.js";

export interface HistoryUpdateInput {
  code?: string;
  state?: string;
  sesionName?: string;
  date?: string;
  refs?: string;
}

export interface HistoryUpdateOutput {
  code: string;
  flow: string | null;
  action: UpsertAction;
  state: string;
}

export interface HistoryUpdateError {
  error: string;
}

export type HistoryUpdateResult =
  | HistoryUpdateOutput
  | HistoryUpdateError
  | { sessionError: SessionResolutionError };

export async function runHistoryUpdate(
  fs: FileSystemPort,
  paths: PathsService,
  input: HistoryUpdateInput,
): Promise<HistoryUpdateResult> {
  const validation = validate(input);
  if (validation) return validation;
  const code = input.code ?? "";

  // HISTORY is infrastructure and never establishes a conversation association
  // (`bind` off) — but it does need to know WHOSE row it is writing. An
  // unresolved `--code 047` used to degrade the row key to `047` and invent a
  // name from it, which rewrote the row of `047-algo-quick` — a different
  // session — dropping its date and its references on the way.
  //
  // A live session answers that question; so does a row named whole, which is
  // the only way left once the folder is gone. Anything else does not write.
  const resolution = await resolveSessionTarget(fs, paths, {
    code,
    allowClosed: true,
    intent: "write",
  });
  if (resolution.outcome !== "resolved") {
    // A row may outlive its folder and is repairable when named exactly. A
    // numeric collision is different: the resolver already established that a
    // WRITE has no durable target, so an existing row cannot turn that refusal
    // into a disk mutation.
    if (resolution.code === "SESSION_AMBIGUOUS" || !(await namesAnExistingRow(fs, paths, code))) {
      return { sessionError: resolution };
    }
  }
  const session = resolution.outcome === "resolved" ? resolution.session : null;

  // Asked here as well as inside the primitive, and on purpose: the primitive
  // can only throw (its other caller holds the lock and reports the failure as
  // its own), while a command has a result to return and a reader to inform.
  const fields = historyFields(input, session, code);
  const sharing = await sessionsSharingNumber(fs, paths, fields.code);
  if (sharing.length > 1) return { sessionError: sharedNumberError(fields.code, sharing) };

  return withCwdLock(fs, paths, () => upsertHistoryRow(fs, paths, fields));
}

/**
 * Whether `code` is, verbatim, the key of a row the record already holds.
 *
 * A session's FOLDER can be gone while its row is not, and repairing that row is
 * exactly what this command is for: the close path tells its caller to re-run it
 * after a `history_error`, and `discard` retires folders by design. Refusing
 * every unresolved identity froze those rows with no way back.
 *
 * The test is EXACT and nothing weaker. A bare `047` matching `047-algo-quick`
 * is how an update used to rewrite another session's row, degrading its key and
 * dropping its date and references on the way; and a key the row-writer would
 * rename on its way through is not the key being repaired either. Reaching a row
 * whose folder is gone costs naming it whole — which the caller can read off the
 * record it is repairing.
 */
async function namesAnExistingRow(
  fs: FileSystemPort,
  paths: PathsService,
  code: string,
): Promise<boolean> {
  const historyFile = paths.cwdHistoryFile();
  if (!(await fs.exists(historyFile))) return false;
  const rows = readHistoryRows(await fs.readText(historyFile));
  return rows.some((row) => row.key === code);
}

/** The refusal a number two sessions answer to deserves, with both of them named. */
export function sharedNumberError(
  code: string,
  sharing: SessionCandidate[],
): SessionResolutionError {
  const folders = sharing.map((candidate) => candidate.folder);
  return {
    outcome: "error",
    code: "SESSION_AMBIGUOUS",
    message: `el número ${sessionNumericCode(code) ?? code} lo comparten ${sharing.length} carpetas y el registro se indexa por número: escribir la fila de una pisaría la de la otra`,
    candidates: sharing,
    action: `renombrá la carpeta legacy al modelo actual (\`NNN-<slug>\`) antes de registrar su fila: ${folders.join(", ")}`,
  };
}

/**
 * What the caller ASSERTS about the row. Everything optional is a cell nobody
 * named, and a cell nobody named is one the upsert leaves exactly as it is.
 */
export interface HistoryRowFields {
  code: string;
  sesionName?: string;
  date?: string;
  state: string;
  refs?: string;
}

/**
 * Upsert the HISTORY.md row WITHOUT acquiring the workspace lock — for callers
 * that already hold it. `session-close` mutates the `.closed` marker, the
 * bindings registry and this row inside ONE lock boundary; going through the
 * public command instead would nest the acquisition.
 *
 * The shared-number guard lives HERE and not only in the command, because this
 * is the primitive both write paths reach: a close whose number two folders
 * answer to would otherwise rewrite the other session's row, and its caller
 * reports the refusal as `history_error` instead of recording a lie.
 */
export async function upsertHistoryRow(
  fs: FileSystemPort,
  paths: PathsService,
  fields: HistoryRowFields,
): Promise<HistoryUpdateOutput> {
  const sharing = await sessionsSharingNumber(fs, paths, fields.code);
  if (sharing.length > 1) throw new Error(sharedNumberError(fields.code, sharing).message);

  const action = await upsertRow(fs, paths.cwdHistoryFile(), {
    code: fields.code,
    ...(fields.sesionName !== undefined ? { sesionName: fields.sesionName } : {}),
    ...(fields.date !== undefined ? { date: fields.date } : {}),
    state: fields.state,
    // Rendered only when the caller named it: `renderRefs(undefined)` is "—",
    // and writing that over references somebody put there by hand is the very
    // deletion this merge exists to stop.
    ...(fields.refs !== undefined ? { refs: renderRefs(fields.refs) } : {}),
  });
  // `flow` stays in the output shape for consumer compat; sessions carry no
  // flow segment anymore, so it is always null.
  return { code: fields.code, flow: null, action, state: fields.state };
}

/**
 * Merge the caller's overrides with what the resolved session already knows.
 *
 * What neither of them knows stays UNSAID rather than being filled in here: a
 * name derived from the code alone becomes a row key, and a date defaulted to
 * today becomes the session's recorded date — both of them facts about the
 * command that ran, not about the session. Downstream, an unsaid cell keeps
 * whatever the record already holds.
 */
export function historyFields(
  input: HistoryUpdateInput,
  session: SessionEntry | null,
  code: string,
): HistoryRowFields {
  const sesionName = input.sesionName || session?.name;
  const date = input.date || session?.date;
  return {
    // Command input may use an old short spelling (`7`) but a resolved live
    // session already carries the one durable number. Use that shared reading
    // before building the HISTORY key; otherwise `7` + `007-foo` becomes the
    // invented key `7-007-foo`. A retired row has no live folder to canonicalise
    // against, so its exact key stays the repair target.
    code: session === null ? code : (sessionNumericCode(session.folder) ?? code),
    ...(sesionName !== undefined ? { sesionName } : {}),
    ...(date !== undefined ? { date } : {}),
    state: input.state ?? "active",
    ...(input.refs !== undefined ? { refs: input.refs } : {}),
  };
}

function validate(input: HistoryUpdateInput): HistoryUpdateError | null {
  if (!input.code || !input.state) return { error: "--code y --state son obligatorios" };
  if (input.state !== "active" && input.state !== "closed") {
    return { error: "state debe ser 'active' o 'closed'" };
  }
  return null;
}
