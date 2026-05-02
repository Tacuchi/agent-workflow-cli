import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type UpsertAction, buildRow, upsertRow } from "./history-table.js";
import {
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";
import { renderRefs } from "./render/history-row.js";
import { resolveSession } from "./session-resolver.js";

export interface SessionCloseInput {
  code?: string;
  graduatedDecisions?: string;
  graduatedPlan?: string;
  graduatedScripts?: string;
  graduatedDesign?: string;
  graduatedRfc?: string;
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
};

export async function runSessionClose(
  fs: FileSystemPort,
  env: EnvPort,
  input: SessionCloseInput,
): Promise<SessionCloseFullOutput | SessionCloseError> {
  if (!input.code) return { error: "--code es obligatorio" };
  const session = await resolveSession(fs, env, input.code, true);
  if (!session) return { error: `Sesión no encontrada: ${input.code}` };

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
  const refsCombined = refsParts.length > 0 ? refsParts.join(",") : null;
  const refsRendered = refsCombined ? renderRefs(refsCombined) : "—";

  const cwd = env.cwd();
  const date = session.date ?? formatToday();
  const summary = session.summary ?? "";

  const action = await upsertRow(fs, cwd, session.code ?? input.code, (hasFlow) =>
    buildRow({
      code: session.code ?? input.code ?? "",
      flow: session.flow ?? null,
      sesionName: session.name,
      date,
      state: "closed",
      summary,
      refs: refsRendered,
      hasFlow,
    }),
  );

  const projectMd = await runProjectMdUpsertWrite(fs, env, {
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
      history_action: action,
      refs: refsRendered,
      qtc_project_updated: true,
    },
  };
}

function formatToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
