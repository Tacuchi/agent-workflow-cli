import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type UpsertAction, buildRow, upsertRow } from "./history-table.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";
import { renderRefs } from "./render/history-row.js";
import { resolveSession } from "./session-resolver.js";

type ResolvedSession = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;

export interface SessionCloseInput {
  code?: string;
  graduatedDecisions?: string;
  graduatedPlan?: string;
  graduatedScripts?: string;
  graduatedDesign?: string;
  graduatedRfc?: string;
  graduatedConclusions?: string;
  refs?: string;
}

export interface SessionCloseOutput {
  code: string;
  folder: string;
  history_action: UpsertAction;
  refs: string;
  qtc_project_updated: boolean;
}

export interface SessionCloseFullOutput {
  projectMd: ProjectMdUpsertOutput;
  sessionClose: SessionCloseOutput;
}

export interface SessionCloseError {
  error: string;
}

const FLAG_TO_TAG: Record<string, string> = {
  graduatedDecisions: "dec",
  graduatedPlan: "plan",
  graduatedScripts: "scripts",
  graduatedDesign: "design",
  graduatedRfc: "rfc",
  graduatedConclusions: "conclusion",
};

export async function runSessionClose(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: SessionCloseInput,
): Promise<SessionCloseFullOutput | SessionCloseError> {
  if (!input.code) return { error: "--code es obligatorio" };
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) return { error: `Sesión no encontrada: ${input.code}` };

  const refsRendered = buildCloseRefs(input);
  const actionResult = await markHistoryClosed(fs, paths, session, input, refsRendered);
  if (typeof actionResult === "object") return actionResult;

  const projectMd = await runProjectMdUpsertWrite(fs, env, paths, {
    op: "remove-session",
    sessionFolder: session.folder,
  });
  if ("error" in projectMd) {
    return { error: projectMd.error };
  }

  return {
    projectMd,
    sessionClose: {
      code: session.code ?? input.code ?? "",
      folder: session.folder,
      history_action: actionResult,
      refs: refsRendered,
      qtc_project_updated: true,
    },
  };
}

function buildCloseRefs(input: SessionCloseInput): string {
  const refsParts = collectCloseRefs(input);
  const refsCombined = refsParts.length > 0 ? refsParts.join(",") : null;
  return refsCombined ? renderRefs(refsCombined) : "—";
}

function collectCloseRefs(input: SessionCloseInput): string[] {
  const refsParts: string[] = [];
  for (const [key, tag] of Object.entries(FLAG_TO_TAG)) {
    const value = (input as unknown as Record<string, string | undefined>)[key];
    if (value !== undefined && value.trim().length > 0) {
      refsParts.push(`${tag}:${value.trim()}`);
    }
  }
  if (input.refs && input.refs.trim().length > 0) {
    refsParts.push(input.refs.trim());
  }
  return refsParts;
}

async function markHistoryClosed(
  fs: FileSystemPort,
  paths: PathsService,
  session: ResolvedSession,
  input: SessionCloseInput,
  refsRendered: string,
): Promise<UpsertAction | SessionCloseError> {
  const codeNorm = session.code ?? input.code ?? "";
  const upsertResult = await withCwdLock(fs, paths, () =>
    upsertRow(fs, paths.cwdHistoryFile(), codeNorm, (hasFlow) =>
      buildRow({
        code: codeNorm,
        flow: session.flow ?? null,
        sesionName: session.name,
        date: session.date ?? formatToday(),
        state: "closed",
        summary: session.summary ?? "",
        refs: refsRendered,
        hasFlow,
      }),
    ),
  );
  if (upsertResult && typeof upsertResult === "object" && "error" in upsertResult) {
    return { error: upsertResult.error };
  }
  return upsertResult;
}

function formatToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
