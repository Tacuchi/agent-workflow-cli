/**
 * CLI-owned publication of one plan-execution batch.
 *
 * The plan document is the progress board.  This service derives the exact
 * checkbox and phase edits from a sealed batch snapshot, then publishes those
 * bytes and the run-state trace under the run lock.  It deliberately accepts no
 * a pre-batch boolean asserted by an agent: the document and the batch are
 * the only authorities on what can be credited.
 */

import { join } from "node:path";
import type { CapabilityFailure } from "../domain/capability/protocol.js";
import {
  type FlowRunState,
  type PlanExecBatch,
  withPlanExecBatchLoop,
  withPlanExecBatchPublication,
  withPlanExecBatchPublicationPrepared,
  withPlanExecBatchStage,
} from "../domain/flow/run-state.js";
import { baseDigest, sealProposal } from "../domain/proposal.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type FlowRunLocation, applyUnderLock } from "./flow/run-state-service.js";
import { applyLocalProposal } from "./local-proposal.js";
import { scanMarkdown } from "./markdown.js";
import { type PhaseState, parsePhases } from "./parsers/phases.js";
import { parsePlanStatus } from "./parsers/plan-status.js";
import { type TaskItem, parseTasks } from "./parsers/tasks.js";
import type { PathsService } from "./paths-service.js";

const TASK_ID = /\b(T\d+\.\d+)\b/;
const PHASE_HEADING = /^\s*###\s+F(\d+)\b/i;
const PHASE_BOUNDARY = /^\s*#{1,3}\s+/;
const PHASE_STATE = /^\s*>\s*(?:\*\*)?Estado(?:\*\*)?\s*:\s*.*$/i;
const PHASE_BLOCKER = /^\s*>\s*(?:\*\*)?Bloqueo(?:\*\*)?\s*:\s*.*$/i;
const PLAN_STATUS = /^\s*>\s*Estado\s*:\s*.*$/i;
const PLAN_CLOSURE = /^\s*>\s*Cierre\s*:\s*.*$/i;

export interface BatchPhaseUpdate {
  phase: number;
  state: PhaseState;
  /** `undefined` preserves the existing blocker; `null` removes it. */
  blocker?: string | null;
}

export interface InferPlanExecBatchInput {
  id: string;
  iteration: number;
  mode: PlanExecBatch["mode"];
  phases: number[];
}

export type BatchInference =
  | { ok: true; batch: PlanExecBatch }
  | { ok: false; failure: CapabilityFailure };

/**
 * Build the state snapshot from the actual plan text. A caller declares only a
 * phase range; task ids and the plan digest are derived here.
 */
export function inferPlanExecBatch(text: string, input: InferPlanExecBatchInput): BatchInference {
  const phases = uniquePositive(input.phases);
  if (input.id.trim().length === 0 || !Number.isInteger(input.iteration) || input.iteration < 1) {
    return fail("PLAN_EXEC_BATCH_INVALID", "el batch no tiene id o iteración válidos");
  }
  if (phases.length === 0)
    return fail("PLAN_EXEC_BATCH_INVALID", "el batch no declara ninguna fase");
  const parsedPhases = parsePhases(text);
  const known = new Set(parsedPhases.items.map((phase) => phase.n));
  const absent = phases.filter((phase) => !known.has(phase));
  if (absent.length > 0) {
    return fail(
      "PLAN_EXEC_BATCH_INVALID",
      `el batch nombra fases que el plan no declara: ${absent.map((phase) => `F${phase}`).join(", ")}`,
    );
  }
  const tasks = parseTasks(text)
    .items // A batch only owns work still open when its snapshot is sealed. Already
    // checked tasks stay evidence of an earlier iteration; including them here
    // would let a retry appear to re-accredit somebody else's completed work.
    .filter(
      (task) => task.status === "open" && task.phase !== undefined && phases.includes(task.phase),
    )
    .map((task) => taskIdOf(task.text))
    .filter((id): id is string => id !== null);
  if (tasks.length === 0 || new Set(tasks).size !== tasks.length) {
    return fail(
      "PLAN_EXEC_BATCH_INVALID",
      "las fases del batch no exponen tareas Tn.m únicas que el CLI pueda acreditar",
    );
  }
  return {
    ok: true,
    batch: {
      id: input.id,
      iteration: input.iteration,
      mode: input.mode,
      phases,
      tasks,
      plan_digest: baseDigest(text),
      stage: "inferred",
    },
  };
}

export interface PreparePlanExecBatchPublicationInput {
  plan: string;
  batch: PlanExecBatch;
  /** These are exact task ids, not a claim that arbitrary work happened. */
  completed_tasks: string[];
  phase_updates: BatchPhaseUpdate[];
  transition: string;
}

export interface PreparedPlanExecBatchPublication {
  batch: PlanExecBatch;
  plan: string;
  before_digest: string;
  after_digest: string;
  content: string;
  transition: string;
  phase_updates: BatchPhaseUpdate[];
}

export type BatchPreparation =
  | { ok: true; prepared: PreparedPlanExecBatchPublication }
  | { ok: false; failure: CapabilityFailure };

/** Validate the batch against the plan and build the one exact plan-document edit. */
export function preparePlanExecBatchPublication(
  text: string,
  input: PreparePlanExecBatchPublicationInput,
): BatchPreparation {
  const before = baseDigest(text);
  if (before !== input.batch.plan_digest) {
    return fail(
      "PLAN_EXEC_BATCH_STALE",
      "el plan cambió desde que se infirió el batch",
      "re-inferí el batch sobre los bytes vigentes; no se acreditan tareas contra un plan movido",
    );
  }
  const completed = uniqueStrings(input.completed_tasks);
  if (!sameSet(completed, input.batch.tasks)) {
    return fail(
      "PLAN_EXEC_BATCH_TASK_SET_INVALID",
      "la publicación no acredita exactamente las tareas del batch",
      `este batch sólo puede acreditar: ${input.batch.tasks.join(", ")}`,
    );
  }
  const parsedTasks = parseTasks(text).items;
  const byId = new Map(
    parsedTasks
      .map((task) => [taskIdOf(task.text), task] as const)
      .filter((entry): entry is [string, TaskItem] => entry[0] !== null),
  );
  const missing = completed.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return fail(
      "PLAN_EXEC_BATCH_TASK_UNKNOWN",
      `el plan no declara ${missing.join(", ")}`,
      "re-inferí el batch: sólo se marcan tareas que el plan vigente contiene",
    );
  }
  const outside = completed.filter((id) => {
    const task = byId.get(id);
    return task?.phase === undefined || !input.batch.phases.includes(task.phase);
  });
  if (outside.length > 0) {
    return fail(
      "PLAN_EXEC_BATCH_TASK_OUTSIDE_PHASE",
      `${outside.join(", ")} no pertenece a una fase del batch`,
      "corregí el rango del batch: una publicación no puede acreditar tareas de otra fase",
    );
  }
  const invalidPhase = input.phase_updates.find(
    (update) => !Number.isInteger(update.phase) || update.phase < 1,
  );
  if (invalidPhase !== undefined) {
    return fail(
      "PLAN_EXEC_BATCH_PHASE_INVALID",
      "la publicación declara una fase inválida",
      "cada transición de fase debe nombrar un número F positivo del batch",
    );
  }
  const seenUpdatePhases = new Set<number>();
  const duplicatePhase = input.phase_updates.find((update) => {
    if (seenUpdatePhases.has(update.phase)) return true;
    seenUpdatePhases.add(update.phase);
    return false;
  });
  if (duplicatePhase !== undefined) {
    return fail(
      "PLAN_EXEC_BATCH_PHASE_DUPLICATE",
      `la publicación declara F${duplicatePhase.phase} más de una vez`,
      "dejá una sola transición final por fase: dos estados competirían por los mismos bytes",
    );
  }
  const updates = normalizePhaseUpdates(input.phase_updates);
  const updateOutside = updates.filter((update) => !input.batch.phases.includes(update.phase));
  if (updateOutside.length > 0) {
    return fail(
      "PLAN_EXEC_BATCH_PHASE_OUTSIDE",
      `la publicación intenta cambiar ${updateOutside.map((update) => `F${update.phase}`).join(", ")} fuera del batch`,
      "una transición sólo puede cambiar los estados de fase que su batch aisló",
    );
  }
  const knownPhases = new Set(parsePhases(text).items.map((phase) => phase.n));
  const unknownPhase = updates.find((update) => !knownPhases.has(update.phase));
  if (unknownPhase !== undefined) {
    return fail(
      "PLAN_EXEC_BATCH_PHASE_UNKNOWN",
      `el plan no declara F${unknownPhase.phase}`,
      "re-inferí el batch sobre el plan vigente",
    );
  }
  const marked = markTasks(text, new Set(completed));
  if (!marked.ok) return marked;
  const phased = rewritePhases(marked.content, updates);
  if (!phased.ok) return phased;
  return {
    ok: true,
    prepared: {
      batch: input.batch,
      plan: input.plan,
      before_digest: before,
      after_digest: baseDigest(phased.content),
      content: phased.content,
      transition: input.transition,
      phase_updates: updates,
    },
  };
}

/** The deterministic plan-document edit performed only by the terminal flow row. */
export interface PreparePlanExecDoneSealInput {
  /** Workspace-relative plan path, used only in actionable refusals. */
  plan: string;
  /** The run evidence that the closure line records. */
  closure: string;
}

export interface PreparedPlanExecDoneSeal {
  before_digest: string;
  after_digest: string;
  content: string;
  /** The exact required `done` + `Cierre` bytes already existed. */
  already_sealed: boolean;
}

export type PlanExecDonePreparation =
  | { ok: true; prepared: PreparedPlanExecDoneSeal }
  | { ok: false; failure: CapabilityFailure };

/**
 * Re-check the document facts that make a plan closable and build its final
 * header rewrite.  This is deliberately separate from the flow-state checks:
 * the document parser owns checkboxes/phases/status, while the caller owns
 * validation, integration and reconciliation evidence.
 */
export function preparePlanExecDoneSeal(
  text: string,
  input: PreparePlanExecDoneSealInput,
): PlanExecDonePreparation {
  const tasks = parseTasks(text);
  if (tasks.open > 0) {
    return fail(
      "PLAN_EXEC_DONE_TASKS_OPEN",
      `${input.plan} todavía tiene ${tasks.open} tarea(s) abierta(s)`,
      "cerrá únicamente los batches que el CLI ya infirió y publicó antes de sellar el plan",
    );
  }
  const phases = parsePhases(text);
  const unvalidated = phases.items.filter((phase) => phase.state !== "validada");
  if (unvalidated.length > 0) {
    return fail(
      "PLAN_EXEC_DONE_PHASES_OPEN",
      `${input.plan} todavía tiene fases sin validar: ${unvalidated.map((phase) => `F${phase.n}`).join(", ")}`,
      "resolvé el batch o el bloqueo de cada fase antes de la validación final",
    );
  }
  const status = parsePlanStatus(text);
  if (status.declared === "unknown") {
    return fail(
      "PLAN_EXEC_DONE_STATUS_INVALID",
      `${input.plan} declara un estado de plan ilegible`,
      "normalizá el preámbulo del plan antes de sellar su cierre",
    );
  }
  const closure = input.closure.trim();
  if (closure.length === 0) {
    return fail(
      "PLAN_EXEC_DONE_CLOSURE_INVALID",
      "el cierre del plan no tiene evidencia textual",
      "volvé a la frontera final con una corrida que conserve su evidencia de validación e integración",
    );
  }

  const next = rewritePlanDonePreamble(text, closure);
  return {
    ok: true,
    prepared: {
      before_digest: baseDigest(text),
      after_digest: baseDigest(next),
      content: next,
      already_sealed: next === text && status.declared === "done" && status.closure === closure,
    },
  };
}

export interface PublishPlanExecBatchInput extends PreparePlanExecBatchPublicationInput {
  root: string;
  location: FlowRunLocation;
  state_digest: string;
}

export type BatchPublish =
  | {
      ok: true;
      batch: PlanExecBatch;
      written: string[];
      already_applied: boolean;
      state: FlowRunState;
    }
  | { ok: false; failure: CapabilityFailure };

/**
 * Publish plan progress and its v10 trace as one recoverable transition.
 *
 * The run lock keeps its cursor/CAS stable. `applyLocalProposal` then performs
 * the plan-document CAS under the workspace lock. If a process dies after the
 * document write but before the run-state write, the identical retry observes
 * `already_applied` and seals the trace; if either base moved it refuses stale.
 */
export async function publishPlanExecBatch(
  fs: FileSystemPort,
  paths: PathsService,
  input: PublishPlanExecBatchInput,
): Promise<BatchPublish> {
  // Persist the sealed before/after pair first. The plan write deliberately
  // happens OUTSIDE this lock: `applyLocalProposal` has its own workspace lock,
  // and a long nested lock would turn recovery into a deadlock. More importantly,
  // the staged state survives a crash between these two operations.
  const staged = await applyUnderLock<StagedBatchPublication>(
    fs,
    input.location,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recovery branches are the one sealed state machine for the pre-write intent.
    async (current) => {
      if (current === null) return { ok: false as const, failure: missingRun() };
      const text = await readPlan(fs, input.root, input.plan);
      if (!text.ok) return text;
      const digest = baseDigest(text.content);
      const existing = (current.batches ?? []).find((batch) => batch.id === input.batch.id);

      if (existing !== undefined && !sameBatchDefinition(existing, input.batch)) {
        return {
          ok: false as const,
          failure: failure(
            "PLAN_EXEC_BATCH_CONFLICT",
            `el batch '${input.batch.id}' ya fue sellado con otro rango o digest de plan`,
            "no reutilices un id de batch: re-inferí una nueva iteración sobre el plan vigente",
          ),
        };
      }
      const publication = existing?.publication;
      if (publication !== undefined) {
        // `publication` can only be reached through an existing batch; spell the
        // guard out for the state-recovery branch instead of casting a corrupt
        // partial object into an authority.
        if (existing === undefined) return { ok: false as const, failure: missingBatch() };
        if (publication.plan !== input.plan || publication.transition !== input.transition) {
          return {
            ok: false as const,
            failure: failure(
              "PLAN_EXEC_BATCH_CONFLICT",
              `el batch '${input.batch.id}' ya tiene otra publicación pendiente`,
              "reanudá la publicación sellada; no cambies su plan ni su transición a mitad de recuperación",
            ),
          };
        }
        if (publication.status === "applied") {
          if (digest !== publication.after_plan_digest) {
            return {
              ok: false as const,
              failure: recoveryStale(input.plan),
            };
          }
          const next = withPlanExecBatchLoop(
            current,
            loopAfterPublication(text.content, existing.iteration),
          );
          if (next === current) {
            return {
              ok: true as const,
              state: next,
              value: { batch: existing, prepared: null, already_applied: true },
              persist: false,
            };
          }
          return {
            ok: true as const,
            state: next,
            value: { batch: existing, prepared: null, already_applied: true },
          };
        }
        // The document landed before the process could seal the final state.
        // Finish from the pre-written digest; do not derive a new batch or mark
        // anything a second time.
        if (digest === publication.after_plan_digest) {
          let next = withPlanExecBatchPublication(current, existing.id, digest);
          next = withPlanExecBatchStage(
            next,
            existing.id,
            "closed",
            publication.transition,
            "completed",
          );
          next = withPlanExecBatchLoop(
            next,
            loopAfterPublication(text.content, existing.iteration),
          );
          const closed = batchOf(next, existing.id);
          if (closed === null) return { ok: false as const, failure: missingBatch() };
          return {
            ok: true as const,
            state: next,
            value: { batch: closed, prepared: null, already_applied: true },
          };
        }
        if (digest !== publication.before_plan_digest) {
          return { ok: false as const, failure: recoveryStale(input.plan) };
        }
        const prepared = preparePlanExecBatchPublication(text.content, input);
        if (!prepared.ok) return { ok: false as const, failure: prepared.failure };
        if (prepared.prepared.after_digest !== publication.after_plan_digest) {
          return {
            ok: false as const,
            failure: failure(
              "PLAN_EXEC_BATCH_CONFLICT",
              "el reintento no reconstruye los mismos bytes sellados para el batch",
              "conservá las tareas, estados y transición de la publicación pendiente; si cambió el plan, re-inferí otro batch",
            ),
          };
        }
        return {
          ok: true as const,
          state: current,
          value: { batch: existing, prepared: prepared.prepared, already_applied: false },
          persist: false,
        };
      }

      if (existing === undefined) {
        return { ok: false as const, failure: batchNotInferred(input.batch.id) };
      }
      const prepared = preparePlanExecBatchPublication(text.content, input);
      if (!prepared.ok) return { ok: false as const, failure: prepared.failure };
      let next = current;
      next = withPlanExecBatchPublicationPrepared(next, input.batch.id, {
        plan: input.plan,
        before_plan_digest: prepared.prepared.before_digest,
        after_plan_digest: prepared.prepared.after_digest,
        transition: input.transition,
      });
      const stagedBatch = batchOf(next, input.batch.id);
      if (stagedBatch === null) return { ok: false as const, failure: missingBatch() };
      return {
        ok: true as const,
        state: next,
        value: { batch: stagedBatch, prepared: prepared.prepared, already_applied: false },
      };
    },
    { expectDigest: input.state_digest },
  );
  if (!staged.ok) return staged;
  if (staged.value.already_applied) {
    return {
      ok: true,
      batch: staged.value.batch,
      written: [],
      already_applied: true,
      state: staged.state,
    };
  }
  const prepared = staged.value.prepared;
  if (prepared === null) {
    return { ok: false, failure: missingBatch() };
  }

  const proposal = sealProposal({
    operation: "plan-exec.batch-publication",
    artifacts: [{ path: input.plan, content: prepared.content, overwrite: true }],
    bases: [{ path: input.plan, digest: prepared.before_digest }],
    effects: ["mutate_overwrite"],
    requiresApproval: [],
  });
  const applied = await applyLocalProposal(fs, paths, {
    root: input.root,
    proposal,
    approval: { digest: proposal.digest, granted: [] },
    selfAuthorized: ["mutate_overwrite"],
  });
  if (!applied.ok) return { ok: false, failure: applied.failure };

  const finalized = await applyUnderLock<PlanExecBatch>(
    fs,
    input.location,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every branch verifies the same sealed intent before the final CAS.
    async (current) => {
      if (current === null) return { ok: false as const, failure: missingRun() };
      const existing = batchOf(current, input.batch.id);
      const publication = existing?.publication;
      if (existing === null || publication === undefined) {
        return { ok: false as const, failure: missingBatch() };
      }
      const text = await readPlan(fs, input.root, input.plan);
      if (!text.ok) return text;
      const digest = baseDigest(text.content);
      if (publication.status === "applied") {
        if (digest !== publication.after_plan_digest)
          return { ok: false as const, failure: recoveryStale(input.plan) };
        return { ok: true as const, state: current, value: existing, persist: false };
      }
      if (digest !== publication.after_plan_digest) {
        return { ok: false as const, failure: recoveryStale(input.plan) };
      }
      let next = withPlanExecBatchPublication(current, existing.id, digest);
      next = withPlanExecBatchStage(
        next,
        existing.id,
        "closed",
        publication.transition,
        "completed",
      );
      next = withPlanExecBatchLoop(next, loopAfterPublication(text.content, existing.iteration));
      const closed = batchOf(next, existing.id);
      if (closed === null) return { ok: false as const, failure: missingBatch() };
      return { ok: true as const, state: next, value: closed };
    },
    { expectDigest: staged.state.digest },
  );
  if (!finalized.ok) return finalized;
  return {
    ok: true,
    batch: finalized.value,
    written: applied.result.written,
    already_applied: applied.result.already_applied,
    state: finalized.state,
  };
}

interface StagedBatchPublication {
  batch: PlanExecBatch;
  prepared: PreparedPlanExecBatchPublication | null;
  already_applied: boolean;
}

type BatchTextRewrite = { ok: true; content: string } | { ok: false; failure: CapabilityFailure };

function markTasks(text: string, wanted: ReadonlySet<string>): BatchTextRewrite {
  const seen = new Set<string>();
  const lines = text.split("\n").map((line) => {
    const match = /^(\s*[-*]\s*)\[([ xX])\](\s+.*)$/.exec(line);
    if (match === null) return line;
    const id = taskIdOf(match[3] ?? "");
    if (id === null || !wanted.has(id)) return line;
    seen.add(id);
    return `${match[1]}[x]${match[3]}`;
  });
  const missing = [...wanted].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return fail(
      "PLAN_EXEC_BATCH_TASK_UNKNOWN",
      `no se pudo ubicar la casilla de ${missing.join(", ")}`,
      "el plan cambió de forma: re-inferí el batch antes de publicar",
    );
  }
  return { ok: true, content: lines.join("\n") };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is one bounded Markdown block rewrite whose alternatives preserve exact bytes.
function rewritePhases(text: string, updates: readonly BatchPhaseUpdate[]): BatchTextRewrite {
  if (updates.length === 0) return { ok: true, content: text };
  const byPhase = new Map(updates.map((update) => [update.phase, update]));
  const lines = text.split("\n");
  const seen = new Set<number>();
  for (let start = 0; start < lines.length; start += 1) {
    const heading = PHASE_HEADING.exec(lines[start] ?? "");
    if (heading?.[1] === undefined) continue;
    const phase = Number(heading[1]);
    const update = byPhase.get(phase);
    if (update === undefined) continue;
    let end = start + 1;
    while (end < lines.length && !PHASE_BOUNDARY.test(lines[end] ?? "")) end += 1;
    let stateLine = -1;
    let blockerLine = -1;
    for (let i = start + 1; i < end; i += 1) {
      if (stateLine < 0 && PHASE_STATE.test(lines[i] ?? "")) stateLine = i;
      if (blockerLine < 0 && PHASE_BLOCKER.test(lines[i] ?? "")) blockerLine = i;
    }
    if (stateLine < 0) {
      return fail(
        "PLAN_EXEC_BATCH_PHASE_STATE_MISSING",
        `F${phase} no declara una línea '> Estado:' que el CLI pueda transicionar`,
        "normalizá el plan con plan-refine antes de acreditar la fase",
      );
    }
    lines[stateLine] = `> Estado: ${update.state}`;
    if (update.blocker === undefined) {
      seen.add(phase);
      continue;
    }
    if (update.blocker === null) {
      if (blockerLine >= 0) lines.splice(blockerLine, 1);
    } else if (blockerLine >= 0) {
      lines[blockerLine] = `> Bloqueo: ${update.blocker}`;
    } else {
      lines.splice(stateLine + 1, 0, `> Bloqueo: ${update.blocker}`);
    }
    seen.add(phase);
  }
  const missing = updates.filter((update) => !seen.has(update.phase));
  if (missing.length > 0) {
    return fail(
      "PLAN_EXEC_BATCH_PHASE_UNKNOWN",
      `no se pudo ubicar ${missing.map((update) => `F${update.phase}`).join(", ")}`,
      "re-inferí el batch sobre el plan vigente",
    );
  }
  return { ok: true, content: lines.join("\n") };
}

/** Rewrite only the plan preamble — never a `> Estado:` owned by a phase. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded Markdown scan/rewrite keeps plan and phase status surfaces separate.
function rewritePlanDonePreamble(text: string, closure: string): string {
  const scanned = scanMarkdown(text);
  const [title, ...rest] = scanned.headings;
  const firstSection = title?.level === 1 ? rest[0] : title;
  const end = firstSection?.line ?? scanned.lines.length;
  const lines = [...scanned.lines];
  let stateAt = -1;
  let closureAt = -1;
  let lastQuote = -1;
  for (let index = 0; index < end; index += 1) {
    if (scanned.fenced[index]) continue;
    const line = lines[index] ?? "";
    if (/^\s*>/.test(line)) lastQuote = index;
    const bare = line.replace(/\*/g, "");
    if (stateAt < 0 && PLAN_STATUS.test(bare)) stateAt = index;
    if (closureAt < 0 && PLAN_CLOSURE.test(bare)) closureAt = index;
  }

  if (stateAt < 0) {
    const titleLine = title?.level === 1 ? title.line + 1 : 0;
    stateAt = Math.max(titleLine, lastQuote + 1);
    lines.splice(stateAt, 0, "> Estado: done");
    if (closureAt >= stateAt) closureAt += 1;
  } else {
    lines[stateAt] = "> Estado: done";
  }
  if (closureAt < 0) {
    lines.splice(stateAt + 1, 0, `> Cierre: ${closure}`);
  } else {
    lines[closureAt] = `> Cierre: ${closure}`;
  }
  return lines.join("\n");
}

function taskIdOf(text: string): string | null {
  return TASK_ID.exec(text)?.[1] ?? null;
}

/**
 * Derive the next cursor segment from the exact bytes just published.
 *
 * Only an unchecked task under a declared phase keeps PLAN-exec in the batch
 * loop.  A stray checkbox outside the phase grammar is not silently credited as
 * a new batch; the document parser/final gate remains responsible for rejecting
 * that malformed plan rather than this publisher guessing a phase for it.
 */
function loopAfterPublication(text: string, closedIteration: number) {
  const pendingTasks = parseTasks(text).items.some(
    (task) => task.status === "open" && task.phase !== undefined,
  );
  // A phase without a task is not silently declared complete.  It keeps the
  // loop visible, where the next inference returns the typed plan-refine
  // refusal instead of letting final validation/Git run over an unvalidated
  // phase.
  const pendingPhases = parsePhases(text).items.some((phase) => phase.state !== "validada");
  const pending = pendingTasks || pendingPhases;
  return { pending, iteration: pending ? closedIteration + 1 : null };
}

function uniquePositive(values: readonly number[]): number[] {
  return [...new Set(values)]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

/** Input validation already established one valid update per phase. */
function normalizePhaseUpdates(values: readonly BatchPhaseUpdate[]): BatchPhaseUpdate[] {
  return values.map((update) => ({ ...update })).sort((left, right) => left.phase - right.phase);
}

function sameSet<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameBatchDefinition(left: PlanExecBatch, right: PlanExecBatch): boolean {
  return (
    left.id === right.id &&
    left.iteration === right.iteration &&
    left.mode === right.mode &&
    left.plan_digest === right.plan_digest &&
    sameSet(left.phases, right.phases) &&
    sameSet(left.tasks, right.tasks)
  );
}

function batchOf(state: FlowRunState, id: string): PlanExecBatch | null {
  return (state.batches ?? []).find((batch) => batch.id === id) ?? null;
}

async function readPlan(
  fs: FileSystemPort,
  root: string,
  plan: string,
): Promise<{ ok: true; content: string } | { ok: false; failure: CapabilityFailure }> {
  try {
    return { ok: true, content: await fs.readText(join(root, plan)) };
  } catch {
    return {
      ok: false,
      failure: failure(
        "PLAN_EXEC_BATCH_PLAN_UNREADABLE",
        `no se pudo leer '${plan}' para publicar el batch`,
        "restaurá el plan y reintentá; no se acredita progreso sin el documento fuente",
      ),
    };
  }
}

function recoveryStale(plan: string): CapabilityFailure {
  return failure(
    "PLAN_EXEC_BATCH_RECOVERY_STALE",
    `el plan '${plan}' no coincide con los bytes sellados de la publicación pendiente`,
    "no se reinterpreta ni acredita sobre bytes movidos: restaurá el before/after sellado o re-inferí otro batch",
  );
}

function missingBatch(): CapabilityFailure {
  return failure(
    "PLAN_EXEC_BATCH_INVALID",
    "el batch no pudo quedar en el estado de corrida",
    "reintentá la publicación desde la corrida que lo infirió",
  );
}

function batchNotInferred(id: string): CapabilityFailure {
  return failure(
    "PLAN_EXEC_BATCH_NOT_INFERRED",
    `el batch '${id}' no fue sellado en batch-inference antes de la publicación`,
    "volvé a la frontera plan-exec.batch-inference; el cierre no fabrica snapshots retrospectivos",
  );
}

function missingRun(): CapabilityFailure {
  return failure(
    "FLOW_RUN_ABSENT",
    "no hay corrida a la que publicar el batch",
    "adoptá o iniciá plan-exec antes de acreditar trabajo",
  );
}

function fail(
  code: string,
  message: string,
  action?: string,
): { ok: false; failure: CapabilityFailure } {
  return { ok: false, failure: failure(code, message, action) };
}

function failure(
  code: string,
  message: string,
  action = "revisá el batch y reintentá",
): CapabilityFailure {
  return { code, message, action };
}
