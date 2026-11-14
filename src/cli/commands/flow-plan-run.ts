import { localDateIso } from "../../application/dates.js";
import { readHubBlock } from "../../application/parsers/hub-block.js";
import { resolveHubRootFrom } from "../../application/paths-service.js";
import { resolveCheckout } from "../../application/plan-run/checkout.js";
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
import {
  type EnsuredUnit,
  type IsolationUnit,
  ensureUnit,
  planUnit,
  quickUnit,
} from "../../application/plan-run/units.js";
import { hubKey, unitsRoot } from "../../domain/isolation-unit.js";
import type { CommandResult } from "../../domain/types.js";
import type { GitPort } from "../../ports/git.js";
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
  | EnsuredUnit;

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
  const chosen = args.values.get("checkout");
  if (alias === undefined || message === undefined || ctx.git === undefined) {
    return fail(
      "ARGS_INVALID",
      `aw flow ${verb} necesita --source, --message y al menos un --path`,
      `uso: aw flow ${verb} --source <alias> [--checkout <ruta>] --message <mensaje> --path <ruta>...`,
    );
  }
  if (alias === "hub" && chosen !== undefined) {
    return fail(
      "ARGS_INVALID",
      "--checkout no aplica al hub: el hub se resuelve por su raíz",
      "quitá --checkout o nombrá una fuente declarada",
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
  const where =
    alias === "hub"
      ? await hubWhere(ctx.git, root, paths)
      : await sourceWhere(ctx, alias, repo, chosen);
  if (!where.ok) return fail(where.failure.code, where.failure.message, where.failure.action);
  const { checkout, prefix } = where.value;
  const target = { source: alias, repo, checkout, prefix, message, paths };
  if (verb === "propose-commit") {
    const proposal = await proposeCommit(ctx.git, target);
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
  const committed = await commitApproved(ctx.git, { ...target, approval });
  return committed.ok
    ? { ok: true, data: committed.value, exitCode: 0 }
    : fail(committed.failure.code, committed.failure.message, committed.failure.action);
}

type Where =
  | { ok: true; value: { checkout: string; prefix: string } }
  | { ok: false; failure: { code: string; message: string; action: string } };

/**
 * The hub commits at its root with hub-relative paths; inside a bigger
 * repository git spells them with the hub's prefix (spec 067, ID03), and a path
 * already carrying it is refused before the deliverables boundary.
 */
async function hubWhere(git: GitPort, root: string, paths: readonly string[]): Promise<Where> {
  const prefix = (await git.repoPrefix(root)) ?? "";
  const prefixed = prefix === "" ? [] : paths.filter((path) => path.startsWith(prefix));
  if (prefixed.length > 0) {
    return refused(
      "HUB_PATH_PREFIXED",
      prefixed
        .map(
          (path) =>
            `'${path}' trae el prefijo '${prefix}' del repositorio que contiene al hub; se espera '${path.slice(prefix.length)}'`,
        )
        .join(" · "),
      `nombrá las rutas relativas al hub: ${prefixed.map((path) => `'${path.slice(prefix.length)}'`).join(", ")}`,
    );
  }
  const outside = deliverableViolations(paths);
  if (outside.length > 0) {
    return refused(
      "DELIVERABLE_OUTSIDE_DOCS",
      outside.map((item) => `${item.path}: ${item.reason}`).join(" · "),
      "un flujo escribe en el hub sólo su spec o plan y los entregables de docs/diagrams, docs/manuals, docs/reports y docs/scripts",
    );
  }
  return { ok: true, value: { checkout: root, prefix } };
}

/** A source commits in its declared path, or in the worktree of it chosen with --checkout (ID01). */
async function sourceWhere(
  ctx: CliContext,
  alias: string,
  declared: string,
  chosen: string | undefined,
): Promise<Where> {
  const resolved = await resolveCheckout(ctx.fs, ctx.git as GitPort, { alias, declared, chosen });
  return resolved.ok ? { ok: true, value: { checkout: resolved.value, prefix: "" } } : resolved;
}

function refused(code: string, message: string, action: string): Where {
  return { ok: false, failure: { code, message, action } };
}

const QUICK_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * `aw flow unit`: the isolation unit of one batch of one plan, or of one QUICK,
 * in one source (spec 066, T4.4; spec 067, ID04-ID05). It starts from the
 * source's main branch or the base named with --from.
 */
async function unitVerb(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<PlanRunVerbResult>> {
  const alias = flagValue(args, "source");
  const plan = args.values.get("plan");
  const batch = args.values.get("batch");
  const quick = args.values.get("quick");
  const from = args.values.get("from");
  const forPlan = plan !== undefined && batch !== undefined && quick === undefined;
  const forQuick = quick !== undefined && plan === undefined && batch === undefined;
  if (alias === undefined || !(forPlan || forQuick) || ctx.git === undefined) {
    return fail(
      "ARGS_INVALID",
      "aw flow unit necesita --source y, o bien --plan con --batch, o bien --quick",
      "uso: aw flow unit --source <alias> (--plan <PPP> --batch <Bn> | --quick <slug>) [--from <ref>]",
    );
  }
  if (quick !== undefined && !QUICK_SLUG.test(quick)) {
    return fail(
      "ARGS_INVALID",
      `el slug '${quick}' de --quick no está en kebab-case`,
      "usá minúsculas, dígitos y guiones, como 'corrige-login'",
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
  if (from !== undefined && (await ctx.git.refValue(source.path, from)) === null) {
    return fail(
      "UNIT_BASE_MISSING",
      `la base '${from}' no existe en ${source.path}`,
      "nombrá una rama local o una referencia remota ya traída con 'git fetch'",
    );
  }
  const identity = {
    worktreesRoot: await ctx.fs
      .realPath(unitsRoot(ctx.paths.userRoot()))
      .catch(() => unitsRoot(ctx.paths.userRoot())),
    hubKey: hubKey(root),
    alias,
  };
  const unit: IsolationUnit =
    quick !== undefined
      ? quickUnit({ ...identity, slug: quick })
      : planUnit({ ...identity, plan: plan as string, batch: batch as string });
  const ensured = await ensureUnit(ctx.fs, ctx.git, source.path, unit, from ?? source.main_branch);
  return { ok: true, data: ensured, exitCode: 0 };
}

function fail<T>(code: string, message: string, action: string): CommandResult<T> {
  return failSemantic<T>({ code, message, action });
}
