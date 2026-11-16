import type { FileSystemPort } from "../ports/file-system.js";
import { type UpsertAction, upsertRow } from "./history-table.js";
import type { PathsService } from "./paths-service.js";
import { renderRefs } from "./render/history-row.js";
import {
  type SessionCandidate,
  type SessionResolutionError,
  sessionNumericCode,
  sessionsSharingNumber,
} from "./session-resolver.js";

export interface HistoryUpdateOutput {
  code: string;
  flow: string | null;
  action: UpsertAction;
  state: string;
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
    action: `ejecutá \`aw hub-migrate --renumber\` antes de registrar la fila: ${folders.join(", ")}`,
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
 * Upsert the HISTORY.md row WITHOUT acquiring the hub lock — for callers
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
