import type { CliAnswer } from "../../domain/flow/authority.js";
import { runCheckBranch } from "../check-branch-service.js";
import { runNextNumber } from "../dev-only-services.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import { canonicalJson } from "../semantic-operation/protocol.js";
import { sessionSlug } from "../session-resolver.js";
import { type WorktreeListOutput, runWorktree } from "../worktree-service.js";
import type {
  InternalActionDeps,
  InternalActionOutcome,
  InternalActionRun,
} from "./internal-actions.js";
import { locateRun, readRun } from "./run-state-service.js";

/**
 * The boundaries the CLI answers itself, because answering them takes no
 * judgment (plan 082 F6 · spec 061 AC-08).
 *
 * Each derivation runs the same service the agent used to be told to run, and
 * hands back the MINIMAL answer the agent would have sent — the outcome and the
 * real output. That answer then travels the submit road like any other: it is
 * completed, observed and judged, so an automatic answer earns nothing a sent
 * one would not. A derivation that cannot run leaves the boundary to the agent.
 */
export async function deriveCliAnswer(
  deps: InternalActionDeps,
  run: InternalActionRun,
  answer: CliAnswer,
): Promise<InternalActionOutcome> {
  switch (answer) {
    case "plan-exec.scope":
      return scopeOfPlan(deps, run);
    case "worktree.verify":
      return verifyUnits(deps, run);
    case "worktree.integrate":
      return integrateUnits(deps, run);
    case "sources.verify":
      return verifySources(deps, run);
    case "next-number.claim":
      return claimNumber(deps, run);
  }
}

function answered(body: Record<string, unknown>, summary: string): InternalActionOutcome {
  return { ok: true, summary, output: canonicalJson(body), effects: [] };
}

function unanswered(summary: string): InternalActionOutcome {
  return { ok: false, summary, output: "", effects: [] };
}

/**
 * The execution answer: completed when `passed`, blocked otherwise, with the real
 * output as its detail. `report` travels beside it for the directive, never in
 * the answer that is judged.
 */
function executed(passed: boolean, output: unknown, summary: string): InternalActionOutcome {
  return answered(
    {
      outcome: passed ? "completed" : "blocked",
      detail: `${summary}\n${canonicalJson(output)}`,
      report: output,
    },
    summary,
  );
}

/** The plan and sources the execution entry already read: the union of its `> Fuentes:`. */
async function scopeOfPlan(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const read = await readRun(deps.fs, locateRun(deps.paths, run.session));
  if (!read.ok) return unanswered(read.failure.message);
  const entry = read.state.plan_exec_entry;
  if (entry?.plan == null || entry.sources === undefined || entry.sources.length === 0) {
    return unanswered("la entrada no leyó el plan ni sus fuentes: el scope queda a la respuesta");
  }
  return answered(
    { decisions: { plan: entry.plan, sources: [...entry.sources] } },
    `scope derivado del plan ${entry.plan}: ${entry.sources.join(", ")}`,
  );
}

/** Every scoped source holds this session's unit, or sits on its expected branch in place. */
async function verifyUnits(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const scope = run.scope;
  if (scope === null) return unanswered("la corrida todavía no fijó su scope");
  const aliases = scope.sources.filter((alias) => alias !== "workspace");
  if (scope.isolation === "in-place") {
    const verdicts = [];
    for (const alias of aliases) {
      verdicts.push(
        await runCheckBranch(deps.fs, deps.env, deps.git, deps.paths, {
          alias,
          sessionCode: run.session,
        }),
      );
    }
    const off = verdicts.filter((verdict) => !verdict.match).map((verdict) => verdict.alias);
    return executed(
      off.length === 0,
      verdicts,
      off.length === 0
        ? `ramas verificadas en su lugar: ${aliases.join(", ") || "ninguna fuente"}`
        : `la rama no coincide en ${off.join(", ")}`,
    );
  }
  const listed = (await runWorktree(deps, {
    action: "list",
    sessionCode: run.session,
  })) as WorktreeListOutput;
  const held = new Set(
    listed.units.filter((unit) => unit.session_active).map((unit) => unit.alias),
  );
  const missing = aliases.filter((alias) => !held.has(alias));
  return executed(
    missing.length === 0,
    listed,
    missing.length === 0
      ? `unidades verificadas: ${aliases.join(", ") || "ninguna fuente"}`
      : `sin unidad de esta sesión: ${missing.join(", ")}`,
  );
}

/** The session's units merged into their sources' working branches, or the conflict kept. */
async function integrateUnits(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const report = await runWorktree(deps, { action: "integrate", sessionCode: run.session });
  if ("error" in report) {
    return executed(false, report, `la integración no corrió: ${String(report.error)}`);
  }
  if (!("pending" in report) || !("integrated" in report)) {
    return unanswered("la integración no devolvió el reporte de la sesión");
  }
  const pending = report.pending;
  return executed(
    pending.length === 0,
    report,
    pending.length === 0
      ? "unidades integradas"
      : `integración pendiente en ${pending.join(", ")}: resolvé el merge y volvé a correr aw flow advance`,
  );
}

/** Every declared source on its expected branch; a workspace with none has nothing to verify. */
async function verifySources(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const verdict = await runCheckBranch(deps.fs, deps.env, deps.git, deps.paths, {
    sessionCode: run.session,
  });
  const nothing = verdict.reason === "no_sources_declared";
  const off = (verdict.sources ?? []).filter((one) => !one.match).map((one) => one.alias);
  return executed(
    verdict.match || nothing,
    verdict,
    nothing
      ? "sin fuentes declaradas: no hay rama que verificar"
      : verdict.match
        ? "ramas verificadas"
        : `la rama no coincide en ${off.join(", ")}`,
  );
}

/** This run's plan number, reserved under the workspace lock for its own session. */
async function claimNumber(
  deps: InternalActionDeps,
  run: InternalActionRun,
): Promise<InternalActionOutcome> {
  const slug = sessionSlug(run.session, "plan-new");
  if (slug === null) return unanswered("la sesión no nombra un slug de plan-new");
  const canon = await resolveCoreDocsCanon(deps.fs, deps.paths);
  if (!canon.ok) return unanswered(canon.error);
  const data = await runNextNumber(deps.fs, deps.env, deps.paths, {
    directory: canon.canon.plan,
    claim: { name: `plan-${slug}.md`, owner: run.session },
  });
  const claimed = (data as { claimed_path?: string | null }).claimed_path ?? null;
  return executed(
    claimed !== null,
    data,
    claimed === null ? "el reclamo no devolvió claimed_path" : `reclamado: ${claimed}`,
  );
}
