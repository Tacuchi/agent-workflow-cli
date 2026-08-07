import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import type { DesignRefState } from "./design/design-graph-service.js";
import { projectRun } from "./flow/run-projection.js";
import { firstNonEmptyLine, parseMdSectionBilingual } from "./markdown.js";
import type { PathsService } from "./paths-service.js";
import { findArtifact } from "./session-artifacts.js";
import { resolveSessionTarget } from "./session-resolver.js";
import {
  type IndexedPlan,
  type IndexedSession,
  type IndexedSpec,
  type PipelineItem,
  type SessionUnit,
  type WorklineIndex,
  buildWorklineIndex,
} from "./workline-index-service.js";

/**
 * `resume` — what to pick up, and the exact command that continues it.
 *
 * It decides from the same Workline index `status` projects, so the two can
 * never disagree about what is pending. Two hard rules:
 *
 * - **It never executes the route it proposes.** The command comes back as a
 *   string for the human to run.
 * - **It never writes.** Session targets resolve with `bind: false`, so reading
 *   what to resume does not silently claim the conversation for that session.
 */

export interface ResumeInput {
  /** A doc path (`docs/plans/009-…md`) or a bare document number. */
  target?: string;
  /** A session folder or code — resolved read-only. */
  code?: string;
  contextId?: string;
  now?: Date;
  /** Read isolation units too, so two concurrent flows are told apart. */
  git?: GitPort;
}

export interface ResumeProposal {
  kind: PipelineItem["kind"] | "session";
  /** workspace-relative doc path, or the session folder */
  file: string;
  number: string | null;
  objective: string;
  progress: string;
  /** the next pending step, or what the work is waiting on */
  next: string;
  /** the exact command that continues it — presented, never run */
  command: string;
  /**
   * Design references of this document that are NOT valid. Absent when the
   * document pins none or every one resolves — a resume that always carried the
   * key would say "design: []" about work that has no design at all.
   */
  design?: Array<{ state: DesignRefState; baseline: string; detail: string | null }>;
  /**
   * Isolation units this flow edits in. Present only when it took some — which
   * is what tells two concurrent flows apart: without it `resume` proposes the
   * same next step to both and neither learns which tree is its own.
   */
  units?: SessionUnit[];
}

export type ResumeOutcome =
  | { status: "proposal"; via: "explicit" | "pipeline"; proposal: ResumeProposal }
  | { status: "candidates"; candidates: ResumeProposal[]; action: string }
  | { status: "idle"; action: string }
  | { status: "invalid_target"; target: string; action: string };

export async function runResume(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ResumeInput = {},
): Promise<ResumeOutcome> {
  const index = await buildWorklineIndex(fs, env, paths, {
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.git !== undefined ? { git: input.git } : {}),
  });

  if (input.code !== undefined) return await resumeSession(fs, paths, index, input);
  if (input.target !== undefined) return resumeTarget(index, input.target);
  return await resumePipeline(fs, paths, index);
}

// ── explicit target ──────────────────────────────────────────────────────────

/**
 * An explicit target wins over the pipeline, and matches by exact path or by
 * document number — **never by slug**, which is how the old survey attached a
 * session to the wrong plan. A number that names both a spec and a plan is a
 * genuine tie, so it comes back as candidates, the same answer the pipeline
 * gives for any other tie.
 */
function resumeTarget(index: WorklineIndex, target: string): ResumeOutcome {
  const specs = index.specs.filter((s) => s.file === target || s.number === target);
  const plans = index.plans.filter((p) => p.file === target || p.number === target);

  const matches: ResumeProposal[] = [
    ...specs.map((s) => specProposal(s, index)),
    ...plans.map((plan) => planProposal(plan, index)),
  ];

  const [first] = matches;
  if (first === undefined) {
    return {
      status: "invalid_target",
      target,
      action: `ningún documento coincide con '${target}': pasá una ruta docs/specs|docs/plans o el número, o usá --code para una sesión`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "candidates",
      candidates: matches,
      action: `'${target}' identifica ${matches.length} documentos: repetí con la ruta completa`,
    };
  }
  return { status: "proposal", via: "explicit", proposal: first };
}

async function resumeSession(
  fs: FileSystemPort,
  paths: PathsService,
  index: WorklineIndex,
  input: ResumeInput,
): Promise<ResumeOutcome> {
  // `bind: false` on purpose: this is a read. `sessionReadRequest` would record
  // the conversation→session association, and `resume` must not write.
  const resolution = await resolveSessionTarget(fs, paths, {
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: true,
    bind: false,
  });

  if (resolution.outcome !== "resolved") {
    return {
      status: "invalid_target",
      target: input.code ?? "",
      action: resolution.action,
    };
  }

  const folder = resolution.session.folder;
  const session = index.sessions.find((s) => s.folder === folder);
  const path = session?.path ?? resolution.session.path;
  return {
    status: "proposal",
    via: "explicit",
    proposal: await sessionProposal(fs, paths, folder, path, session),
  };
}

// ── no target: the documental pipeline ───────────────────────────────────────

async function resumePipeline(
  fs: FileSystemPort,
  paths: PathsService,
  index: WorklineIndex,
): Promise<ResumeOutcome> {
  const [head] = index.pipeline;
  if (head === undefined) {
    return { status: "idle", action: "no hay trabajo pendiente: el pipeline está vacío" };
  }

  // A tie is priority + progress, never date. Two items that reach here are
  // equally next, and picking one for the user is what this replaces.
  const tied = index.pipeline.filter(
    (item) =>
      item.priority === head.priority && (item.started ?? false) === (head.started ?? false),
  );

  if (tied.length > 1) {
    const candidates = await Promise.all(
      tied.map((item) => pipelineProposal(fs, paths, index, item)),
    );
    return {
      status: "candidates",
      candidates,
      action: `${tied.length} candidatos con la misma prioridad: elegí uno y volvé a invocar con su ruta`,
    };
  }
  return {
    status: "proposal",
    via: "pipeline",
    proposal: await pipelineProposal(fs, paths, index, head),
  };
}

async function pipelineProposal(
  fs: FileSystemPort,
  paths: PathsService,
  index: WorklineIndex,
  item: PipelineItem,
): Promise<ResumeProposal> {
  if (item.kind === "plan-open") {
    const plan = index.plans.find((p) => p.file === item.file);
    if (plan !== undefined) return planProposal(plan, index);
  }
  if (item.kind === "checkpoint-orphan") {
    const session = index.sessions.find((s) => s.folder === item.file);
    if (session !== undefined) {
      return await sessionProposal(fs, paths, session.folder, session.path, session);
    }
  }
  const spec = index.specs.find((s) => s.file === item.file);
  if (spec !== undefined) return specProposal(spec, index);
  return {
    kind: item.kind,
    file: item.file,
    number: item.number,
    objective: item.summary,
    progress: "—",
    next: item.summary,
    command: item.command,
  };
}

// ── proposals ────────────────────────────────────────────────────────────────

function specProposal(spec: IndexedSpec, index: WorklineIndex): ResumeProposal {
  const planned = index.plans.some(
    (p) => p.spec.status === "resolved" && p.spec.number === spec.number,
  );
  const refine = spec.status !== "ready-for-plan";
  return {
    kind: refine ? "spec-unrefined" : "spec-unplanned",
    file: spec.file,
    number: spec.number,
    objective: `spec ${spec.number}${spec.slug ? ` — ${spec.slug}` : ""}`,
    progress: `status ${spec.status}, ${spec.open_questions} pregunta(s) abierta(s)`,
    next: refine
      ? "refinar hasta ready-for-plan"
      : planned
        ? "ya tiene plan derivado"
        : "generar su plan",
    command: refine ? `/w:spec-refine ${spec.file}` : `/w:plan-new ${spec.file}`,
    ...designOf(index, spec.file),
  };
}

function planProposal(plan: IndexedPlan, index: WorklineIndex): ResumeProposal {
  const [blocked] = plan.blocked_phases;
  const phases =
    plan.phases_total > 0 ? ` · fases ${plan.phases_validated}/${plan.phases_total}` : "";
  const design = designOf(index, plan.file);
  return {
    kind: "plan-open",
    file: plan.file,
    number: plan.number,
    objective: `plan ${plan.number}${plan.slug ? ` — ${plan.slug}` : ""}`,
    progress: `${plan.tasks_done}/${plan.tasks_total} tareas (${plan.progress_pct}%)${phases}`,
    // A missing reference outranks the plan's own next step: plan-exec fails
    // closed on it, so proposing "implementá F3" would send someone into a wall.
    next: describeMissingDesign(design) ?? describePlanNext(plan, blocked),
    command: `/w:plan-exec ${plan.file}`,
    ...design,
  };
}

/** The document's non-valid references, or nothing at all to say. */
function designOf(index: WorklineIndex, file: string): Pick<ResumeProposal, "design"> {
  const design = index.designs.references
    .filter((r) => r.from === file && r.state !== "valid")
    .map((r) => ({ state: r.state, baseline: r.baseline, detail: r.detail }));
  return design.length === 0 ? {} : { design };
}

function describeMissingDesign(design: Pick<ResumeProposal, "design">): string | null {
  const missing = (design.design ?? []).filter((d) => d.state === "missing");
  const [first] = missing;
  if (first === undefined) return null;
  return `DISEÑO IRRESOLUBLE ${first.baseline} — ${first.detail ?? "no resuelve"}`;
}

function describePlanNext(
  plan: IndexedPlan,
  blocked: IndexedPlan["blocked_phases"][number] | undefined,
): string {
  if (blocked !== undefined) {
    return `BLOQUEADA F${blocked.number} — ${blocked.blocker ?? "sin motivo declarado"}`;
  }
  if (plan.plan_state === "inconsistent") {
    return "el plan se declara done pero sus contadores no lo respaldan: repararlo a mano";
  }
  if (plan.final_validation_pending) return "todo ejecutado: falta la validación final y el cierre";
  return "continuar por la primera fase no validada";
}

async function sessionProposal(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
  path: string,
  session: IndexedSession | undefined,
): Promise<ResumeProposal> {
  const objective =
    (await readSection(fs, path, "session", "Objective")) ?? session?.summary ?? folder;
  const pending = await readSection(fs, path, "checkpoint", "Pending / Next");
  const completed = await readSection(fs, path, "checkpoint", "Completed");
  // A run stopped at a boundary is a more precise answer than the CHECKPOINT's
  // prose, and it is the only one that survives the conversation: it names the
  // transition in force and, when something has to run, the exact invocation.
  // The CHECKPOINT stays as the progress line — the two say different things.
  const run = await projectRun(fs, paths, folder);
  const directed = run !== null && run.boundary !== "final";
  return {
    kind: "session",
    file: folder,
    number: session?.code ?? null,
    objective,
    progress: completed === undefined ? "sin checkpoint" : `checkpoint presente: ${completed}`,
    next: directed
      ? `${run.summary}${pending === undefined ? "" : ` · CHECKPOINT: ${pending}`}`
      : (pending ?? "el checkpoint no declara trabajo pendiente"),
    command: directed ? run.command : `aw session-resume --code ${folder} --reopen`,
    ...(session !== undefined && session.units.length > 0 ? { units: session.units } : {}),
  };
}

async function readSection(
  fs: FileSystemPort,
  sessionPath: string,
  artifact: "session" | "checkpoint",
  heading: string,
): Promise<string | undefined> {
  try {
    const file = await findArtifact(sessionPath, artifact, fs);
    if (!file) return undefined;
    const section = parseMdSectionBilingual(await fs.readText(file), heading);
    return section === undefined ? undefined : firstNonEmptyLine(section);
  } catch {
    return undefined;
  }
}
