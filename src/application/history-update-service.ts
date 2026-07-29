import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { type UpsertAction, buildRow, upsertRow } from "./history-table.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { renderRefs } from "./render/history-row.js";
import { type SessionEntry, resolveSessionTarget } from "./session-resolver.js";

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

export type HistoryUpdateResult = HistoryUpdateOutput | HistoryUpdateError;

export async function runHistoryUpdate(
  fs: FileSystemPort,
  paths: PathsService,
  input: HistoryUpdateInput,
): Promise<HistoryUpdateResult> {
  const validation = validate(input);
  if (validation) return validation;
  const code = input.code ?? "";

  // HISTORY is infrastructure: it records a row for a code even when the folder
  // is gone, and it NEVER establishes a conversation association (`bind` off).
  const resolution = await resolveSessionTarget(fs, paths, { code, allowClosed: true });
  const session = resolution.outcome === "resolved" ? resolution.session : null;

  return withCwdLock(fs, paths, () =>
    upsertHistoryRow(fs, paths, historyFields(input, session, code)),
  );
}

export interface HistoryRowFields {
  code: string;
  sesionName: string;
  date: string;
  state: string;
  refs?: string;
}

/**
 * Upsert the HISTORY.md row WITHOUT acquiring the workspace lock — for callers
 * that already hold it. `session-close` mutates the `.closed` marker, the
 * bindings registry and this row inside ONE lock boundary; going through the
 * public command instead would nest the acquisition.
 */
export async function upsertHistoryRow(
  fs: FileSystemPort,
  paths: PathsService,
  fields: HistoryRowFields,
): Promise<HistoryUpdateOutput> {
  const action = await upsertRow(fs, paths.cwdHistoryFile(), fields.code, () =>
    buildRow({
      code: fields.code,
      sesionName: fields.sesionName,
      date: fields.date,
      state: fields.state,
      refs: renderRefs(fields.refs),
    }),
  );
  // `flow` stays in the output shape for consumer compat; sessions carry no
  // flow segment anymore, so it is always null.
  return { code: fields.code, flow: null, action, state: fields.state };
}

/** Merge the caller's overrides with what the resolved session already knows. */
export function historyFields(
  input: HistoryUpdateInput,
  session: SessionEntry | null,
  code: string,
): HistoryRowFields {
  return {
    code: normalizeCode(code),
    sesionName: input.sesionName || session?.name || code,
    date: input.date || session?.date || localDateIso(new Date()),
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

function normalizeCode(code: string): string {
  return code.includes("session") ? (code.replace("session", "").split("-")[0] ?? code) : code;
}
