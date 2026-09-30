/** CLI-owned batch commit: preflight all sources, persist each receipt, recover git-only cuts. */
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import {
  type FlowRunState,
  type PlanExecBatch,
  withPlanExecBatchUpdate,
} from "../../domain/flow/run-state.js";
import type { CommitReceipt, DirtyPath } from "../../ports/git.js";
import { canonicalJson, semanticDigest } from "../semantic-operation/protocol.js";
import { recordCommit } from "../session-custody-recorder.js";
import { resolveCheckoutCandidates } from "./checkout-observation.js";
import type {
  InternalActionDeps,
  InternalActionOutcome,
  InternalActionRun,
} from "./internal-actions.js";
import { applyUnderLock, locateRun, readRun } from "./run-state-service.js";

type Source = NonNullable<PlanExecBatch["commit_proposal"]>["sources"][number];
interface CheckedSource {
  source: Source;
  path: string;
  receipt: CommitReceipt | null;
}

const failed = (code: string, message: string, action: string): CapabilityFailure => ({
  code,
  message,
  action,
});
const refused = (failure: CapabilityFailure): InternalActionOutcome => ({
  ok: false,
  summary: `plan-exec.batch-commit: ${failure.message}`,
  output: canonicalJson({ code: failure.code, failure }),
  effects: [],
});

function ready(state: FlowRunState): PlanExecBatch | CapabilityFailure {
  const batch = (state.batches ?? []).find(
    (item) => item.iteration === state.batch_loop?.iteration,
  );
  if (!batch?.snapshot || !batch.commit_proposal || !batch.credit || !batch.review) {
    return failed(
      "PLAN_EXEC_BATCH_COMMIT_UNREADY",
      "faltan instantánea, propuesta aprobada, acreditación o revisión",
      "volvé a la validación/revisión del lote",
    );
  }
  const proposal = batch.commit_proposal;
  if (
    !proposal.sources.length ||
    new Set(proposal.sources.map((source) => source.alias)).size !== proposal.sources.length ||
    proposal.sources.some((source) => batch.snapshot?.[source.alias] === undefined) ||
    proposal.approved_digest !== proposal.digest ||
    semanticDigest({ batch: batch.id, snapshot: batch.snapshot, sources: proposal.sources }) !==
      proposal.digest
  ) {
    return failed(
      "PLAN_EXEC_BATCH_COMMIT_DIGEST_MISMATCH",
      "la propuesta no coincide con su aprobación",
      "revisá la propuesta y pedí de nuevo aprobación",
    );
  }
  return batch;
}

/** Final fence, including sources omitted from a no-changes proposal. */
export async function verifyBatchGitState(
  deps: InternalActionDeps,
  run: InternalActionRun,
  batch: PlanExecBatch,
  inPlace: boolean,
): Promise<CapabilityFailure | null> {
  if (batch.snapshot === undefined || batch.commit_result === undefined) return null;
  const roots = await resolveCheckoutCandidates(deps.fs, deps.paths, run.session);
  for (const [alias, base] of Object.entries(batch.snapshot)) {
    const path = roots.find((entry) => entry.source === alias)?.root;
    if (path === undefined)
      return failed(
        "PLAN_EXEC_BATCH_COMMIT_REFUSED",
        `${alias}: unidad no observable`,
        "restaurá la unidad antes de cerrar el lote",
      );
    try {
      const [head, branch, dirty] = await Promise.all([
        deps.git.head(path),
        deps.git.currentBranch(path),
        deps.git.dirtyPaths(path),
      ]);
      if (
        head !== (batch.commit_result[alias]?.after ?? base.head) ||
        branch !== base.branch ||
        (!inPlace && dirty.length !== 0) ||
        (inPlace &&
          dirty.some((entry) =>
            batch.commit_proposal?.sources
              .find((source) => source.alias === alias)
              ?.paths.includes(entry.path),
          ))
      ) {
        return failed(
          "PLAN_EXEC_BATCH_COMMIT_REFUSED",
          `${alias}: HEAD, rama o rutas sucias desde la propuesta`,
          "recuperá git antes de publicar batch-close",
        );
      }
    } catch (error) {
      return failed(
        "PLAN_EXEC_BATCH_COMMIT_REFUSED",
        `${alias}: ${String(error)}`,
        "recuperá git antes de publicar batch-close",
      );
    }
  }
  return null;
}

/** A git-only commit left by an interrupted operation is ours only with all three identities. */
async function recognize(
  deps: InternalActionDeps,
  path: string,
  source: Source,
  base: NonNullable<PlanExecBatch["snapshot"]>[string],
  head: string,
  branch: string,
  dirty: DirtyPath[],
  inPlace: boolean,
): Promise<CommitReceipt> {
  const info = await deps.git.commitInfo(path, head);
  if (
    branch !== base.branch ||
    info.parents.length !== 1 ||
    info.parents[0] !== base.head ||
    info.message !== source.message ||
    info.paths.join("\0") !== [...source.paths].sort().join("\0") ||
    (inPlace ? dirty.some((entry) => source.paths.includes(entry.path)) : dirty.length !== 0)
  ) {
    throw new Error(`${source.alias}: HEAD se movió con un commit ajeno a la propuesta`);
  }
  return { before: base.head, after: head, branch, parents: info.parents };
}

async function checkSource(
  deps: InternalActionDeps,
  batch: PlanExecBatch,
  source: Source | undefined,
  alias: string,
  roots: { source: string; root: string }[],
  inPlace: boolean,
): Promise<CheckedSource | null> {
  const path = roots.find((item) => item.source === alias)?.root;
  const base = batch.snapshot?.[alias];
  if (!path || !base) throw new Error(`unidad ${alias} sin instantánea`);
  const [head, branch, dirty] = await Promise.all([
    deps.git.head(path),
    deps.git.currentBranch(path),
    deps.git.dirtyPaths(path),
  ]);
  const recorded = batch.commit_result?.[alias] ?? null;
  if (recorded !== null) {
    return checkRecordedSource(source, path, recorded, alias, base, head, branch, dirty, inPlace);
  }
  if (source === undefined) {
    if (head !== base.head || branch !== base.branch || (!inPlace && dirty.length !== 0))
      throw new Error(`${alias}: una fuente sin rutas propuestas cambió antes del commit`);
    return null;
  }
  if (head !== base.head) {
    if (head === null || branch === undefined)
      throw new Error(`${source.alias}: HEAD o rama cambió`);
    return {
      source,
      path,
      receipt: await recognize(deps, path, source, base, head, branch, dirty, inPlace),
    };
  }
  validateProposedPaths(source, base, branch, dirty, inPlace);
  return { source, path, receipt: null };
}

async function commitOne(
  deps: InternalActionDeps,
  run: InternalActionRun,
  batch: PlanExecBatch,
  checked: CheckedSource,
  state: FlowRunState,
): Promise<FlowRunState> {
  const { source, path } = checked;
  const receipt =
    checked.receipt ?? (await deps.git.commitPaths(path, source.message, source.paths));
  const [head, dirty] = await Promise.all([deps.git.head(path), deps.git.dirtyPaths(path)]);
  const info = await deps.git.commitInfo(path, receipt.after);
  if (
    head !== receipt.after ||
    (run.scope?.isolation !== "in-place" && dirty.length !== 0) ||
    (run.scope?.isolation === "in-place" &&
      dirty.some((entry) => source.paths.includes(entry.path))) ||
    receipt.before !== info.parents[0] ||
    info.parents.length !== 1 ||
    info.message !== source.message ||
    info.paths.join("\0") !== [...source.paths].sort().join("\0")
  )
    throw new Error(`${source.alias}: el commit no quedó en git o dejó rutas sucias`);
  const recorded = await applyUnderLock<null>(
    deps.fs,
    locateRun(deps.paths, run.session),
    (current) => {
      if (current === null)
        return {
          ok: false,
          failure: failed(
            "FLOW_RUN_ABSENT",
            "se perdió la corrida al guardar el recibo",
            "reanudá sin crear un segundo commit",
          ),
        };
      return {
        ok: true,
        state: withPlanExecBatchUpdate(current, batch.id, (item) => ({
          ...item,
          commit_result: { ...item.commit_result, [source.alias]: receipt },
        })),
        value: null,
      };
    },
    { expectDigest: state.digest },
  );
  if (!recorded.ok) throw new Error(recorded.failure.message);
  const custody = await recordCommit(deps, run.session, source.alias, receipt);
  if (custody.status === "unreadable") throw new Error(`custodia ilegible: ${custody.reason}`);
  return recorded.state;
}

export async function commitBatch(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const read = await readRun(deps.fs, locateRun(deps.paths, run.session));
  if (!read.ok) return refused(read.failure);
  const batch = ready(read.state);
  if (!("id" in batch)) return refused(batch);
  try {
    const roots = await resolveCheckoutCandidates(deps.fs, deps.paths, run.session);
    // Every preflight happens before the first commit; a failure touches no source.
    const checkedAll = await Promise.all(
      Object.keys(batch.snapshot ?? {}).map((alias) =>
        checkSource(
          deps,
          batch,
          batch.commit_proposal?.sources.find((source) => source.alias === alias),
          alias,
          roots,
          run.scope?.isolation === "in-place",
        ),
      ),
    );
    const checked = checkedAll.filter((item): item is CheckedSource => item !== null);
    let state = read.state;
    for (const source of checked) state = await commitOne(deps, run, batch, source, state);
    return {
      ok: true,
      summary: `batch ${batch.id}: ${checked.map((item) => item.source.alias).join(", ")} commiteadas y verificadas`,
      output: canonicalJson({
        batch: batch.id,
        receipts: state.batches?.find((item) => item.id === batch.id)?.commit_result,
      }),
      effects: ["execute", "local_additive"],
      state,
    };
  } catch (error) {
    return refused(
      failed(
        "PLAN_EXEC_BATCH_COMMIT_REFUSED",
        String(error),
        "revisá git y reanudá la misma frontera; no crees otro commit a mano",
      ),
    );
  }
}

function validateProposedPaths(
  source: Source,
  base: NonNullable<PlanExecBatch["snapshot"]>[string],
  branch: string | undefined,
  dirty: DirtyPath[],
  inPlace: boolean,
): void {
  const proposed = dirty.filter((entry) => source.paths.includes(entry.path));
  const shared =
    inPlace &&
    base.dirty.some(
      (entry) => dirty.find((now) => now.path === entry.path)?.digest !== entry.digest,
    );
  if (
    branch !== base.branch ||
    shared ||
    proposed.map((entry) => `${entry.path}:${entry.digest}`).join("\0") !==
      source.dirty.map((entry) => `${entry.path}:${entry.digest}`).join("\0") ||
    (!inPlace && dirty.length !== proposed.length)
  ) {
    throw new Error(`${source.alias}: las rutas, sus bytes o la rama cambiaron`);
  }
}

function checkRecordedSource(
  source: Source | undefined,
  path: string,
  recorded: CommitReceipt,
  alias: string,
  base: NonNullable<PlanExecBatch["snapshot"]>[string],
  head: string | null,
  branch: string | undefined,
  dirty: DirtyPath[],
  inPlace: boolean,
): CheckedSource {
  if (
    source === undefined ||
    head !== recorded.after ||
    branch !== base.branch ||
    (!inPlace && dirty.length !== 0) ||
    (inPlace && dirty.some((entry) => source.paths.includes(entry.path)))
  )
    throw new Error(`${alias}: el recibo ya no coincide con git`);
  return { source, path, receipt: recorded };
}
