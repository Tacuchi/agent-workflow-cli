import { join } from "node:path";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import {
  type FlowRunState,
  type PlanExecBatch,
  checkAgainstJourney,
  withReinferredPlanExecBatch,
} from "../../domain/flow/run-state.js";
import { baseDigest, matchTextSeal } from "../../domain/proposal.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { parseTasks } from "../parsers/tasks.js";
import { type PathsService, resolveWorkspaceRootFrom } from "../paths-service.js";
import { planLineDiff, sealedPlanPath } from "../plan-exec-plan-diff.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { directiveFor, resolveBoundary } from "./advance.js";
import { journeyForRun } from "./run-journey.js";
import { applyUnderLock, locateRun, readRun } from "./run-state-service.js";

export interface ReinferBatchPreview {
  reinfer_batch: true;
  session: string;
  batch: string;
  old_digest: string;
  new_digest: string;
  diff: string;
  approval_digest: string;
  next: string;
}

type Prepared =
  | { ok: true; preview: ReinferBatchPreview; anchor: string | null; text: string }
  | { ok: false; failure: CapabilityFailure };

function refuse(code: string, message: string, action: string): Prepared {
  return { ok: false, failure: { code, message, action } };
}

const taskIds = (text: string, phases: readonly number[]): string[] =>
  parseTasks(text)
    .items.filter((item) => item.phase !== undefined && phases.includes(item.phase))
    .map((item) => /^T\d+\.\d+\b/.exec(item.text)?.[0] ?? "")
    .sort();

/** Preview on the exact run/plan pair; also called INSIDE the apply lock. */
async function previewOf(
  fs: FileSystemPort,
  paths: PathsService,
  state: FlowRunState,
): Promise<Prepared> {
  if (state.flow !== "plan-exec" || state.scope?.plan === undefined) {
    return refuse(
      "PLAN_EXEC_BATCH_NOT_INFERRED",
      "la corrida no fijó un plan ejecutable",
      "iniciá plan-exec sobre el plan correcto",
    );
  }
  const journey = journeyForRun(state);
  const incoherent = checkAgainstJourney(state, journey);
  if (incoherent !== null) return { ok: false, failure: incoherent };
  const batch = (state.batches ?? []).find((item) => item.published_plan_digest === undefined);
  if (batch === undefined) {
    return refuse(
      "PLAN_EXEC_BATCH_ALREADY_PUBLISHED",
      "no hay un lote inferido sin publicar",
      "un lote publicado no se re-sella; si se acreditó mal, usá aw flow annul",
    );
  }
  if (
    batch.publication !== undefined ||
    batch.commit_result !== undefined ||
    batch.commit_proposal?.approved_digest !== undefined
  ) {
    return refuse(
      "PLAN_EXEC_BATCH_PUBLICATION_PENDING",
      `${batch.id} ya inició su publicación o commit`,
      "terminá o recuperá la publicación sellada antes de re-inferir",
    );
  }
  const stopped = resolveBoundary(state, journey).stopped?.id ?? null;
  if (["plan-exec.batch-commit-authorization", "plan-exec.batch-commit"].includes(stopped ?? "")) {
    return refuse(
      "PLAN_EXEC_BATCH_PUBLICATION_PENDING",
      "el commit del lote ya está en curso",
      "resolvé ese commit antes de cambiar el plan",
    );
  }
  const location = locateRun(paths, state.session);
  const root = await resolveWorkspaceRootFrom(fs, paths);
  let sealed: string;
  let current: string;
  try {
    sealed = await fs.readText(sealedPlanPath(location.dir, batch.plan_digest));
    current = await fs.readText(join(root, state.scope.plan));
  } catch {
    return refuse(
      "PLAN_EXEC_BATCH_SNAPSHOT_MISSING",
      `no hay copia legible del plan sellado para ${batch.id}`,
      "un lote anterior no tiene copia para mostrar el diff; restaurá el plan original o reabrí el lote con aw flow annul",
    );
  }
  if (matchTextSeal(batch.plan_digest, sealed) === null) {
    return refuse(
      "PLAN_EXEC_BATCH_SNAPSHOT_INVALID",
      "la copia del plan no corresponde al digest del lote",
      "restaurá la copia original de la sesión",
    );
  }
  const taskFailure = validateReinferredTasks(sealed, current, batch);
  if (taskFailure !== null) return taskFailure;
  const anchor = [
    "plan-exec.deferred-check",
    "plan-exec.review-findings",
    "plan-exec.batch-commit-proposal",
    "plan-exec.batch-close",
  ].includes(stopped ?? "")
    ? stopped
    : null;
  const diff = planLineDiff(sealed, current);
  const newDigest = baseDigest(current);
  const approvalDigest = semanticDigest({
    session: state.session,
    batch: batch.id,
    old: batch.plan_digest,
    now: newDigest,
    diff,
  });
  return {
    ok: true,
    anchor,
    text: current,
    preview: {
      reinfer_batch: true,
      session: state.session,
      batch: batch.id,
      old_digest: batch.plan_digest,
      new_digest: newDigest,
      diff,
      approval_digest: approvalDigest,
      next: `aw flow recover --session ${state.session} --reinfer-batch --approval ${approvalDigest}`,
    },
  };
}

export async function previewReinferBatch(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
): Promise<Prepared> {
  const read = await readRun(fs, locateRun(paths, session));
  return read.ok ? previewOf(fs, paths, read.state) : { ok: false, failure: read.failure };
}

export async function applyReinferBatch(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
  approval: string,
): Promise<{ ok: true; directive: FlowDirective } | { ok: false; failure: CapabilityFailure }> {
  const location = locateRun(paths, session);
  const written = await applyUnderLock<FlowDirective>(fs, location, async (state) => {
    if (state === null)
      return {
        ok: false,
        failure: { code: "FLOW_RUN_ABSENT", message: "no hay corrida", action: "iniciá plan-exec" },
      };
    const prepared = await previewOf(fs, paths, state);
    if (!prepared.ok) return prepared;
    if (prepared.preview.approval_digest !== approval) {
      return {
        ok: false,
        failure: {
          code: "PLAN_EXEC_BATCH_REINFER_STALE",
          message: "la vista previa cambió antes del re-sellado",
          action: `volvé a previsualizar con aw flow recover --session ${session} --reinfer-batch`,
        },
      };
    }
    const snapshotFailure = await publishReinferredPlan(fs, location.dir, prepared);
    if (snapshotFailure !== null) return snapshotFailure;
    const root = await resolveWorkspaceRootFrom(fs, paths);
    try {
      const live = await fs.readText(join(root, state.scope?.plan ?? ""));
      if (matchTextSeal(prepared.preview.new_digest, live) === null) {
        return {
          ok: false,
          failure: {
            code: "PLAN_EXEC_BATCH_REINFER_STALE",
            message: "el plan cambió durante el re-sellado",
            action: `volvé a previsualizar con aw flow recover --session ${session} --reinfer-batch`,
          },
        };
      }
    } catch {
      return {
        ok: false,
        failure: {
          code: "PLAN_EXEC_BATCH_PLAN_UNREADABLE",
          message: "el plan dejó de ser legible durante el re-sellado",
          action: "restaurá el acceso al plan y volvé a previsualizar",
        },
      };
    }
    const next = withReinferredPlanExecBatch(
      state,
      prepared.preview.batch,
      prepared.preview.new_digest,
      prepared.anchor,
    );
    const built = directiveFor(next, resolveBoundary(next, journeyForRun(next)), [], {
      nextAction: `lote ${prepared.preview.batch} re-inferido; volvé a correr validación y revisión sobre el nuevo plan`,
    });
    if (!built.ok) return built;
    return { ok: true, state: built.state, value: built.directive };
  });
  return written.ok
    ? { ok: true, directive: written.value }
    : { ok: false, failure: written.failure };
}

function validateReinferredTasks(
  sealed: string,
  current: string,
  batch: PlanExecBatch,
): Prepared | null {
  const prior = taskIds(sealed, batch.phases);
  const now = taskIds(current, batch.phases);
  const originallyOpen = parseTasks(sealed)
    .items.filter(
      (item) =>
        item.status === "open" && item.phase !== undefined && batch.phases.includes(item.phase),
    )
    .map((item) => /^T\d+\.\d+\b/.exec(item.text)?.[0] ?? "")
    .sort();
  if (
    prior.includes("") ||
    prior.join("\0") !== now.join("\0") ||
    originallyOpen.join("\0") !== [...batch.tasks].sort().join("\0")
  ) {
    return refuse(
      "PLAN_EXEC_BATCH_TASK_SET_INVALID",
      "cambió el conjunto de tareas del lote",
      "refiná el plan: re-inferir conserva id, fases y tareas",
    );
  }
  return null;
}

async function publishReinferredPlan(
  fs: FileSystemPort,
  directory: string,
  prepared: Extract<Prepared, { ok: true }>,
): Promise<Extract<Prepared, { ok: false }> | null> {
  const copy = sealedPlanPath(directory, prepared.preview.new_digest);
  try {
    await fs.mkdirp(join(directory, ".plan-seals"));
    const saved = await fs.publishTextExclusive(copy, prepared.text);
    if (
      !saved.created &&
      matchTextSeal(prepared.preview.new_digest, await fs.readText(copy)) === null
    )
      throw new Error("la copia nueva difiere del digest");
  } catch {
    return {
      ok: false,
      failure: {
        code: "PLAN_EXEC_BATCH_SNAPSHOT_UNAVAILABLE",
        message: "no se pudo guardar el nuevo plan sellado",
        action: "revisá la sesión y reintentá la misma aprobación",
      },
    };
  }
  return null;
}
