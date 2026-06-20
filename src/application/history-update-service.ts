import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type UpsertAction, buildRow, upsertRow } from "./history-table.js";
import { LockBusyError, acquireLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { renderRefs } from "./render/history-row.js";
import { type SessionEntry, resolveSession } from "./session-resolver.js";

export interface HistoryUpdateInput {
  code?: string;
  state?: string;
  sesionName?: string;
  date?: string;
  summary?: string;
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
  env: EnvPort,
  paths: PathsService,
  input: HistoryUpdateInput,
): Promise<HistoryUpdateResult> {
  const validation = validate(input);
  if (validation) return validation;
  const code = input.code ?? "";
  const state = input.state ?? "active";

  const session = await resolveSession(fs, env, paths, code, true);
  const fields = mergeFields(input, session, code);
  const refsRendered = renderRefs(input.refs);
  const codeNum = normalizeCode(code);

  let lock: import("./lock-service.js").LockHandle;
  try {
    lock = await acquireLock(paths.cwdLockFile(), fs);
  } catch (err) {
    if (err instanceof LockBusyError) {
      return {
        error: `lock ocupado (pid ${err.holder.pid} desde ${err.holder.ts}); reintenta o espera 5min`,
      };
    }
    throw err;
  }

  try {
    const action = await upsertRow(fs, paths.cwdHistoryFile(), codeNum, (hasFlow) =>
      buildRow({
        code: codeNum,
        flow: fields.flow,
        sesionName: fields.sesionName,
        date: fields.date,
        state,
        summary: fields.summary,
        refs: refsRendered,
        hasFlow,
      }),
    );
    return { code: codeNum, flow: fields.flow, action, state };
  } finally {
    await lock.release();
  }
}

function validate(input: HistoryUpdateInput): HistoryUpdateError | null {
  if (!input.code || !input.state) return { error: "--code y --state son obligatorios" };
  if (input.state !== "active" && input.state !== "closed") {
    return { error: "state debe ser 'active' o 'closed'" };
  }
  return null;
}

interface ResolvedFields {
  flow: string | null;
  sesionName: string;
  date: string;
  summary: string;
}

function mergeFields(
  input: HistoryUpdateInput,
  session: SessionEntry | null,
  code: string,
): ResolvedFields {
  const sesionName = input.sesionName || session?.name || code;
  const date = input.date || session?.date || todayIso();
  const summary = input.summary || session?.summary || sesionName.replace(/-/g, " ");
  // Sessions no longer carry a `flow` segment (removed from the model). The
  // HISTORY.md "Flujo" column is preserved for legacy tables and renders "—".
  return { flow: null, sesionName, date, summary };
}

function normalizeCode(code: string): string {
  return code.includes("session") ? (code.replace("session", "").split("-")[0] ?? code) : code;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
