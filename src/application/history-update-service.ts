import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type UpsertAction, buildRow, upsertRow } from "./history-table.js";
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
  input: HistoryUpdateInput,
): Promise<HistoryUpdateResult> {
  const validation = validate(input);
  if (validation) return validation;
  const code = input.code ?? "";
  const state = input.state ?? "active";

  const session = await resolveSession(fs, env, code, true);
  const fields = mergeFields(input, session, code);
  const refsRendered = renderRefs(input.refs);
  const codeNum = normalizeCode(code);

  const action = await upsertRow(fs, env.cwd(), codeNum, (hasFlow) =>
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
  return { flow: session?.flow ?? null, sesionName, date, summary };
}

function normalizeCode(code: string): string {
  return code.includes("session") ? (code.replace("session", "").split("-")[0] ?? code) : code;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
