import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { resolveFromPlan, transitionPlanState } from "./from-plan.js";
import { type UpsertAction, buildRow, upsertRow } from "./history-table.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";
import { renderRefs } from "./render/history-row.js";
import { findArtifact } from "./session-artifacts.js";
import { resolveSession } from "./session-resolver.js";

type ResolvedSession = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;

export interface SessionCloseInput {
  code?: string;
  graduatedDecisions?: string;
  graduatedPlan?: string;
  graduatedScripts?: string;
  graduatedDesign?: string;
  graduatedPropuesta?: string;
  graduatedConclusions?: string;
  graduatedManuales?: string;
  graduatedEspecificaciones?: string;
  graduatedRelease?: string;
  allowLooseSlugs?: boolean;
  refs?: string;
}

export interface PlanTransitionInfo {
  plan: string;
  from: string;
  to: string;
}

export interface SessionCloseOutput {
  code: string;
  folder: string;
  history_action: UpsertAction;
  refs: string;
  qtc_project_updated: boolean;
  plan_transition?: PlanTransitionInfo;
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
  graduatedDesign: "especificacion",
  graduatedPropuesta: "propuesta",
  graduatedConclusions: "conclusion",
  graduatedManuales: "manual",
  graduatedEspecificaciones: "especificacion",
  graduatedRelease: "release",
};

const NNN_SLUG_RE = /^\d{3}-[a-z0-9-]+$/i;
const TAGS_REQUIRING_NNN = new Set([
  "dec",
  "conclusion",
  "manual",
  "especificacion",
  "release",
  "scripts",
]);

export async function runSessionClose(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: SessionCloseInput,
): Promise<SessionCloseFullOutput | SessionCloseError> {
  if (!input.code) return { error: "--code es obligatorio" };
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) return { error: `Sesión no encontrada: ${input.code}` };

  const validation = validateGraduationSlugs(input);
  if (validation) return validation;

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

  const planTransition = await maybeTransitionOriginPlan(fs, env, paths, session);

  const sessionClose: SessionCloseOutput = {
    code: session.code ?? input.code ?? "",
    folder: session.folder,
    history_action: actionResult,
    refs: refsRendered,
    qtc_project_updated: true,
  };
  if (planTransition) sessionClose.plan_transition = planTransition;

  return { projectMd, sessionClose };
}

function validateGraduationSlugs(input: SessionCloseInput): SessionCloseError | null {
  if (input.allowLooseSlugs) return null;
  for (const [key, tag] of Object.entries(FLAG_TO_TAG)) {
    if (!TAGS_REQUIRING_NNN.has(tag)) continue;
    const raw = (input as unknown as Record<string, string | undefined>)[key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value.length === 0) continue;
    if (!NNN_SLUG_RE.test(value)) {
      return {
        error: `--${kebabFromCamel(key)} requiere slug con prefijo NNN- (recibido '${value}'). Pasá el valor exacto que devolvió 'agent-workflow graduate' (campo 'next_number-slug'), o usá --allow-loose-slugs si sabés lo que hacés.`,
      };
    }
  }
  return null;
}

function kebabFromCamel(name: string): string {
  return name
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
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

async function maybeTransitionOriginPlan(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  session: ResolvedSession,
): Promise<PlanTransitionInfo | null> {
  const planRelpath = await readOriginPlan(fs, session.path);
  if (planRelpath === null) return null;
  const cwd = env.cwd();
  const resolved = await resolveFromPlan(fs, paths, cwd, planRelpath);
  if ("code" in resolved) {
    return null;
  }
  if (resolved.frontmatter.state !== "active") {
    return null;
  }
  const code = session.code ?? "";
  const trigger = `session-close ${code}`;
  const result = await transitionPlanState(fs, resolved, "done", trigger);
  if (!result.wrote) return null;
  return { plan: resolved.filename, from: result.from, to: "done" };
}

async function readOriginPlan(fs: FileSystemPort, sessionPath: string): Promise<string | null> {
  const objectivePath = await findArtifact(sessionPath, "objective", fs);
  if (!objectivePath) return null;
  const text = await fs.readText(objectivePath);
  const headingMatch = text.match(/^##\s+Origin\s+\(plan\)\s*\n+([\s\S]*?)(?:\n##\s|$)/m);
  if (!headingMatch || !headingMatch[1]) return null;
  const body = headingMatch[1];
  const refMatch = body.match(/Derivado del plan\s+`([^`]+)`/);
  if (!refMatch || !refMatch[1]) return null;
  return refMatch[1].trim();
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
