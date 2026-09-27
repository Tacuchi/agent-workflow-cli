import { join } from "node:path";
import type { CoreDocsCanon } from "../../domain/docs-canon.js";
import type { FlowRunState, PlanExecEntry } from "../../domain/flow/run-state.js";
import { checkSafeRelativePath } from "../../domain/safe-path.js";
import { nodeFromDocPath } from "../../domain/workline-node.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import { parsePhases } from "../parsers/phases.js";
import { parseTasks } from "../parsers/tasks.js";
import { type PathsService, resolveWorkspaceRootFrom } from "../paths-service.js";
import { deriveInputs } from "../session-create-service.js";
import { readCustody } from "../session-custody-service.js";

/** Resolve before scope exists; custody outranks a descriptor that may be ambiguous. */
async function entryPlan(
  fs: FileSystemPort,
  paths: PathsService,
  state: FlowRunState,
  canon: CoreDocsCanon,
): Promise<string | null> {
  if (state.scope?.plan) return state.scope.plan;
  const custody = await readCustody(fs, join(paths.cwdSessionsDir(), state.session));
  if (custody.status === "unreadable") return null;
  if (custody.status === "present") {
    const plans = [
      ...new Set(
        custody.custody.artifacts
          .filter(
            (artifact) =>
              artifact.role === "input" && nodeFromDocPath(artifact.path, canon)?.kind === "plan",
          )
          .map((artifact) => artifact.path),
      ),
    ];
    if (plans.length > 0) return plans.length === 1 ? (plans[0] ?? null) : null;
  }
  const derived = await deriveInputs(fs, paths, state.session, canon);
  return derived.paths[0] ?? null;
}

/** A missing reading stays unknown, never an empty list claiming every phase was checked. */
export async function observePlanEntry(
  fs: FileSystemPort,
  paths: PathsService,
  state: FlowRunState,
): Promise<PlanExecEntry> {
  const unknown: PlanExecEntry = { plan: null, phases_without_open_tasks: null };
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) return unknown;
  const plan = await entryPlan(fs, paths, state, canon.canon);
  if (plan === null || !checkSafeRelativePath(plan).ok) return unknown;
  const root = await resolveWorkspaceRootFrom(fs, paths);
  let text: string;
  try {
    text = await fs.readText(join(root, plan));
  } catch {
    return { plan, phases_without_open_tasks: null };
  }
  const phases = parsePhases(text).items;
  // Entry must remain readable even when its finding is malformed phase numbering.
  if (
    phases.some((phase) => !Number.isSafeInteger(phase.n) || phase.n < 1) ||
    new Set(phases.map((phase) => phase.n)).size !== phases.length
  ) {
    return { plan, phases_without_open_tasks: null };
  }
  const open = new Set(
    parseTasks(text)
      .items.filter((task) => task.status === "open")
      .map((task) => task.phase),
  );
  return {
    plan,
    phases_without_open_tasks: phases
      .filter((phase) => phase.state !== "validada" && !open.has(phase.n))
      .map((phase) => phase.n),
  };
}
