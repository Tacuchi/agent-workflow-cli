import { localDateIso } from "../../application/dates.js";
import { readHubBlock } from "../../application/parsers/hub-block.js";
import { resolveHubRootFrom } from "../../application/paths-service.js";
import {
  type CommitProposal,
  commitApproved,
  proposeCommit,
} from "../../application/plan-run/commit-proposal.js";
import { deliverableViolations } from "../../application/plan-run/deliverables.js";
import {
  type BatchClosed,
  type BatchEvidenceInput,
  type BatchValidation,
  closeBatchInPlan,
  finishPlan,
} from "../../application/plan-run/plan-batch.js";
import { type PlanUnit, ensurePlanUnit, planUnit } from "../../application/plan-run/units.js";
import { hubKey, unitsRoot } from "../../domain/isolation-unit.js";
import type { CommandResult } from "../../domain/types.js";
import { readRequiredStdin } from "../context-id.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import { failSemantic } from "../render.js";
import type { CliContext } from "../types.js";

export const PLAN_RUN_VERBS = [
  "propose-commit",
  "commit",
  "close-batch",
  "finish",
  "unit",
] as const;

export type PlanRunVerb = (typeof PLAN_RUN_VERBS)[number];

export type PlanRunVerbResult =
  | CommitProposal
  | { hash: string; paths: string[] }
  | BatchClosed
  | { plan: string; state: "done"; digest: string }
  | { created: boolean; unit: PlanUnit };

export function isPlanRunVerb(value: string | undefined): value is PlanRunVerb {
  return (PLAN_RUN_VERBS as readonly string[]).includes(value ?? "");
}

/**
 * The stateless execution verbs (spec 066, F4): a commit proposed and approved
 * by digest in the conversation, and a batch or plan closed in the plan itself.
 * QUICK uses only the two commit verbs: git is its whole record.
 */
export async function planRunVerb(
  verb: PlanRunVerb,
  args: ParsedArgs,
  ctx: CliContext,
  stdin: () => Promise<string> = () => readRequiredStdin(),
): Promise<CommandResult<PlanRunVerbResult>> {
  if (verb === "propose-commit" || verb === "commit") return commitVerb(verb, args, ctx);
  if (verb === "unit") return unitVerb(args, ctx);
  const plan = args.values.get("plan");
  const readDigest = args.values.get("read-digest");
  if (plan === undefined || readDigest === undefined) {
    return fail(
      "ARGS_INVALID",
      `aw flow ${verb} necesita --plan y --read-digest`,
      `uso: aw flow ${verb} --plan <ruta> --read-digest <digest> < sobre.json`,
    );
  }
  let body: {
    validations?: BatchValidation[];
    evidence?: BatchEvidenceInput;
    commits?: Record<string, string>;
  };
  try {
    body = JSON.parse(await stdin()) as typeof body;
  } catch {
    return fail(
      "ARGS_INVALID",
      "el sobre de stdin no es JSON",
      "mandá {validations, evidence, commits} por stdin",
    );
  }
  const root = await resolveHubRootFrom(ctx.fs, ctx.paths);
  if (verb === "finish") {
    const done = await finishPlan(ctx.fs, root, {
      plan,
      read_digest: readDigest,
      validations: body.validations ?? [],
      date: localDateIso(new Date()),
    });
    return done.ok
      ? { ok: true, data: done.value, exitCode: 0 }
      : fail(done.failure.code, done.failure.message, done.failure.action);
  }
  const batch = args.values.get("batch");
  if (batch === undefined || body.evidence === undefined) {
    return fail(
      "ARGS_INVALID",
      "close-batch necesita --batch y evidence en el sobre",
      "uso: aw flow close-batch --plan <ruta> --batch Bn --read-digest <digest> < sobre.json",
    );
  }
  const closed = await closeBatchInPlan(ctx.fs, root, {
    plan,
    read_digest: readDigest,
    batch,
    validations: body.validations ?? [],
    evidence: body.evidence,
    commits: body.commits ?? {},
  });
  return closed.ok
    ? { ok: true, data: closed.value, exitCode: 0 }
    : fail(closed.failure.code, closed.failure.message, closed.failure.action);
}

async function commitVerb(
  verb: "propose-commit" | "commit",
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<PlanRunVerbResult>> {
  const alias = flagValue(args, "source");
  const message = args.values.get("message");
  const paths = args.valuesMulti.get("path") ?? [];
  if (alias === undefined || message === undefined || ctx.git === undefined) {
    return fail(
      "ARGS_INVALID",
      `aw flow ${verb} necesita --source, --message y al menos un --path`,
      `uso: aw flow ${verb} --source <alias> --message <mensaje> --path <ruta>...`,
    );
  }
  const root = await resolveHubRootFrom(ctx.fs, ctx.paths);
  const block = await readHubBlock(ctx.fs, root, ctx.paths.blockMarkers());
  const repo =
    alias === "hub" ? root : block?.fuentes.find((source) => source.alias === alias)?.path;
  if (repo === undefined || repo === null) {
    return fail(
      "SOURCE_PATH_MISSING",
      `la fuente '${alias}' no resuelve a una ruta`,
      "declarala con 'aw add-source'",
    );
  }
  if (alias === "hub") {
    const outside = deliverableViolations(paths);
    if (outside.length > 0) {
      return fail(
        "DELIVERABLE_OUTSIDE_DOCS",
        outside.map((item) => `${item.path}: ${item.reason}`).join(" · "),
        "un flujo escribe en el hub sólo su spec o plan y los entregables de docs/diagrams, docs/manuals, docs/reports y docs/scripts",
      );
    }
  }
  if (verb === "propose-commit") {
    const proposal = await proposeCommit(ctx.git, { repo, message, paths });
    return proposal.ok
      ? { ok: true, data: proposal.value, exitCode: 0 }
      : fail(proposal.failure.code, proposal.failure.message, proposal.failure.action);
  }
  const approval = args.values.get("approval");
  if (approval === undefined) {
    return fail(
      "ARGS_INVALID",
      "aw flow commit necesita --approval",
      "aprobá la propuesta y citá su digest",
    );
  }
  const committed = await commitApproved(ctx.git, { repo, message, paths, approval });
  return committed.ok
    ? { ok: true, data: committed.value, exitCode: 0 }
    : fail(committed.failure.code, committed.failure.message, committed.failure.action);
}

/** `aw flow unit`: the isolation unit of one batch of one plan in one source (T4.4). */
async function unitVerb(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<PlanRunVerbResult>> {
  const alias = flagValue(args, "source");
  const plan = args.values.get("plan");
  const batch = args.values.get("batch");
  if (alias === undefined || plan === undefined || batch === undefined || ctx.git === undefined) {
    return fail(
      "ARGS_INVALID",
      "aw flow unit necesita --plan, --batch y --source",
      "uso: aw flow unit --plan <PPP> --batch <Bn> --source <alias>",
    );
  }
  const root = await resolveHubRootFrom(ctx.fs, ctx.paths);
  const block = await readHubBlock(ctx.fs, root, ctx.paths.blockMarkers());
  const source = block?.fuentes.find((entry) => entry.alias === alias);
  if (source?.path === undefined || source.path === null) {
    return fail(
      "SOURCE_PATH_MISSING",
      `la fuente '${alias}' no resuelve a una ruta`,
      "declarala con 'aw add-source'",
    );
  }
  const unit = planUnit({
    worktreesRoot: await ctx.fs
      .realPath(unitsRoot(ctx.paths.userRoot()))
      .catch(() => unitsRoot(ctx.paths.userRoot())),
    hubKey: hubKey(root),
    alias,
    plan,
    batch,
  });
  const ensured = await ensurePlanUnit(ctx.fs, ctx.git, source.path, unit, source.main_branch);
  return { ok: true, data: ensured, exitCode: 0 };
}

function fail<T>(code: string, message: string, action: string): CommandResult<T> {
  return failSemantic<T>({ code, message, action });
}
