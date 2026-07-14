import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { type UpsertAction, buildRow, upsertRow } from "./history-table.js";
import { withCwdLock } from "./lock-service.js";
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

  return withCwdLock(fs, paths, async () => {
    const action = await upsertRow(fs, paths.cwdHistoryFile(), codeNum, () =>
      buildRow({
        code: codeNum,
        sesionName: fields.sesionName,
        date: fields.date,
        state,
        refs: refsRendered,
      }),
    );
    // `flow` stays in the output shape for consumer compat; sessions carry no
    // flow segment anymore, so it is always null.
    return { code: codeNum, flow: null, action, state };
  });
}

function validate(input: HistoryUpdateInput): HistoryUpdateError | null {
  if (!input.code || !input.state) return { error: "--code y --state son obligatorios" };
  if (input.state !== "active" && input.state !== "closed") {
    return { error: "state debe ser 'active' o 'closed'" };
  }
  return null;
}

interface ResolvedFields {
  sesionName: string;
  date: string;
}

function mergeFields(
  input: HistoryUpdateInput,
  session: SessionEntry | null,
  code: string,
): ResolvedFields {
  const sesionName = input.sesionName || session?.name || code;
  const date = input.date || session?.date || localDateIso(new Date());
  return { sesionName, date };
}

function normalizeCode(code: string): string {
  return code.includes("session") ? (code.replace("session", "").split("-")[0] ?? code) : code;
}
