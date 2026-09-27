/**
 * `aw flow annul` — reopen a mis-accredited batch and every later one.
 *
 * Kept apart from the engine's own service because it reads the plan document
 * from the workspace root, which needs the environment the engine modules never
 * read. What it shares with `restart` — the session guard and the re-adoption —
 * it takes from `flow-service`.
 */

import { join } from "node:path";
import { legacyRunNeedsAdoption, restartInvocation } from "../../domain/flow/run-state.js";
import { type LocalProposal, sealProposal } from "../../domain/proposal.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { applyLocalProposal } from "../local-proposal.js";
import { type PathsService, resolveWorkspaceRoot } from "../paths-service.js";
import { preparePlanExecAnnulment } from "../plan-exec-batch-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import {
  type AdvanceFlowResult,
  type RestartFlowInput,
  reseat,
  writableSession,
} from "./flow-service.js";
import { locateRun, readRun } from "./run-state-service.js";

export interface AnnulFlowInput extends RestartFlowInput {
  env: EnvPort;
  /** The first batch to annul: `batch-N`, or just `N`. Every later batch goes too. */
  from: string;
}

/** What `aw flow annul` would reopen, and the digest that approves exactly that. */
export interface AnnulPreview {
  session: string;
  plan: string;
  batches: { id: string; phases: number[]; tasks: string[]; kind?: "validation-only" }[];
  phases: number[];
  tasks: string[];
  /** The plan was sealed `done`; applying takes the seal off. */
  unseals_done: boolean;
  digest: string;
  /** The exact command that applies this preview. */
  next: string;
}

type Refusal = Extract<AdvanceFlowResult, { ok: false }>;

type AnnulPreparation =
  | { ok: true; preview: AnnulPreview; proposal: LocalProposal; root: string }
  | Refusal;

export type AnnulPrepareResult = { ok: true; preview: AnnulPreview } | Refusal;

/**
 * Preview an annulment, writing nothing.
 *
 * Read from the LIVE registry: its batches are where the phases and tasks each
 * close credited are recorded, so the preview names exactly what those closes
 * did — not what the plan happens to show now. A run the CLI cannot read has no
 * batches to trust; its way out is `aw flow restart`, and its phases are fixed in
 * the plan by hand.
 */
export async function prepareAnnulment(
  fs: FileSystemPort,
  paths: PathsService,
  input: AnnulFlowInput,
): Promise<AnnulPrepareResult> {
  // Without binding the conversation: a preview writes nothing at all.
  const target = await writableSession(fs, paths, input, "anular", false);
  if (!target.ok) return target.result as Refusal;
  const prepared = await annulmentOf(fs, paths, target.session.folder, input);
  return prepared.ok ? { ok: true, preview: prepared.preview } : prepared;
}

/**
 * Apply the annulment the approval names, or nothing.
 *
 * The preview is recomputed and must still carry the approved digest; the plan
 * is rewritten through the workspace-lock publication with its current bytes as
 * the compare-and-swap base; then the run leaves through the same re-adoption as
 * `restart`, with the annulment in its trace. Git is never touched.
 */
export async function applyAnnulment(
  fs: FileSystemPort,
  paths: PathsService,
  input: AnnulFlowInput & { approval: string },
): Promise<AdvanceFlowResult> {
  const target = await writableSession(fs, paths, input, "anular");
  if (!target.ok) return target.result;
  const prepared = await annulmentOf(fs, paths, target.session.folder, input);
  if (!prepared.ok) return prepared;
  const { preview, proposal, root } = prepared;
  if (input.approval.trim() !== preview.digest) {
    return annulRefusal(
      "FLOW_ANNUL_APPROVAL_MISMATCH",
      "lo aprobado no es lo que se anularía: el plan o la corrida cambiaron desde la vista previa",
      `volvé a correr 'aw flow annul --session ${preview.session} --from ${input.from}', leé la vista previa vigente y aprobá ese digest`,
    );
  }
  const applied = await applyLocalProposal(fs, paths, {
    root,
    proposal,
    approval: { digest: proposal.digest, granted: ["mutate_overwrite"] },
    selfAuthorized: [],
  });
  if (!applied.ok) return { ok: false, failure: applied.failure };
  const ids = preview.batches.map((batch) => batch.id);
  // Past this point the plan is already reopened. If the re-adoption fails, the
  // way out is the same two commands again: the rewrite is then a no-op and the
  // run is re-adopted with the annulment in its trace.
  return reseat(fs, paths, target.session, input, {
    cause: async () => `FLOW_ANNULLED: se anularon ${ids.join(", ")}`,
    events: () => [
      {
        kind: "annulled",
        transition: ANNUL_OPERATION,
        operation: ANNUL_OPERATION,
        batches: ids,
        phases: preview.phases,
        tasks: preview.tasks,
        digest: preview.digest,
      },
    ],
  });
}

const ANNUL_OPERATION = "flow.annul";

/** The preview and the sealed plan rewrite behind it, recomputed from live state. */
async function annulmentOf(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
  input: AnnulFlowInput,
): Promise<AnnulPreparation> {
  const read = await readRun(fs, locateRun(paths, session));
  if (!read.ok) {
    return annulRefusal(read.failure.code, read.failure.message, read.failure.action);
  }
  const state = read.state;
  if (legacyRunNeedsAdoption(state)) {
    return annulRefusal(
      "FLOW_ANNUL_NO_BATCHES",
      `la corrida v${state.version} de '${session}' no registra lotes que se puedan anular`,
      `anular sólo actúa sobre los lotes del registro vivo: sacá la corrida con '${restartInvocation(session)}' y corregí las fases del plan a mano`,
    );
  }
  const closed = (state.batches ?? []).filter((batch) => batch.published_plan_digest !== undefined);
  if (state.scope === null || closed.length === 0) {
    return annulRefusal(
      "FLOW_ANNUL_NO_BATCHES",
      `la corrida de '${session}' todavía no cerró ningún lote de un plan`,
      state.flow === "plan-exec"
        ? "no hay nada que anular: seguí la corrida con 'aw flow advance' y anulá después de cerrar el lote que haga falta"
        : `'${state.flow}' no ejecuta lotes de un plan: anular es sólo para corridas de plan-exec`,
    );
  }
  const iteration = /^(?:batch-)?([1-9][0-9]*)$/i.exec(input.from.trim())?.[1];
  const first = closed.find((batch) => String(batch.iteration) === iteration);
  if (first === undefined) {
    return annulRefusal(
      "FLOW_ANNUL_BATCH_UNKNOWN",
      `'${input.from}' no es un lote cerrado de esta corrida`,
      `elegí uno de: ${closed.map((batch) => batch.id).join(", ") || "(ninguno cerrado todavía)"}`,
    );
  }
  const annulled = closed.filter((batch) => batch.iteration >= first.iteration);
  const phases = [...new Set(annulled.flatMap((batch) => batch.phases))].sort((a, b) => a - b);
  const tasks = [...new Set(annulled.flatMap((batch) => batch.tasks))];
  const root = await resolveWorkspaceRoot(fs, input.env, paths);
  const plan = state.scope.plan;
  let text: string;
  try {
    text = await fs.readText(join(root, plan));
  } catch {
    return annulRefusal(
      "FLOW_ANNUL_PLAN_UNREADABLE",
      `no se puede leer '${plan}'`,
      `restaurá '${plan}' antes de anular`,
    );
  }
  const rewrite = preparePlanExecAnnulment(text, { plan, tasks, phases });
  if (!rewrite.ok) return { ok: false, failure: rewrite.failure };
  const proposal = sealProposal({
    operation: ANNUL_OPERATION,
    artifacts: [{ path: plan, content: rewrite.prepared.content, overwrite: true }],
    bases: [{ path: plan, digest: rewrite.prepared.before_digest }],
    scope: { workspace_root: root },
    effects: ["mutate_overwrite"],
    requiresApproval: ["mutate_overwrite"],
  });
  const digest = annulDigest(
    session,
    annulled.map((batch) => ({ id: batch.id, kind: batch.kind ?? "changes" })),
    proposal.digest,
  );
  return {
    ok: true,
    root,
    proposal,
    preview: {
      session,
      plan,
      batches: annulled.map((batch) => ({
        id: batch.id,
        phases: batch.phases,
        tasks: batch.tasks,
        ...(batch.kind === "validation-only" ? { kind: batch.kind } : {}),
      })),
      phases,
      tasks,
      unseals_done: rewrite.prepared.unsealed,
      digest,
      next: `aw flow annul --session ${session} --from ${input.from} --approval ${digest}`,
    },
  };
}

/**
 * What the person approves: this session, these batches, these plan bytes.
 *
 * The bytes alone would not do — two ranges can produce the same rewrite (every
 * one is a no-op once the plan is already reopened), and a digest shown for
 * `--from 4` must not apply `--from 3` and record batches nobody approved.
 */
function annulDigest(
  session: string,
  batches: readonly { id: string; kind: string }[],
  proposal: string,
): string {
  return semanticDigest({ operation: ANNUL_OPERATION, session, batches, proposal });
}

function annulRefusal(code: string, message: string, action: string): Refusal {
  return { ok: false, failure: { code, message, action } };
}
