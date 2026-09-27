import { join } from "node:path";
import { coreDocumentKindForPath } from "../domain/docs-canon.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { resolveCoreDocsCanon } from "./docs-canon-service.js";
import { readWorkspaceBlock } from "./parsers/project-block.js";
import { type PathsService, resolveWorkspaceRootFrom } from "./paths-service.js";
import {
  type PlanLineageFailure,
  type PlanLineageSeal,
  observePlanLineageSeal,
} from "./plan-lineage-seal.js";
import { type PlanLocatorReason, locatePlanDocument } from "./plan-locator.js";
import {
  type SourceBoundaryFailure,
  validatePlanSourceBoundary,
  validateSourceBoundedSemantics,
} from "./source-boundary-policy.js";

/** A failure the plan grammar can raise over a plan's bytes: sources, closure or lineage. */
export type PlanGrammarFailure = SourceBoundaryFailure | PlanLineageFailure;

export type PlanGrammarCode = PlanGrammarFailure["code"];

/** Which gate judges a violation: saving the plan, entering its execution, or both. */
export type PlanLintMoment = "publication" | "execution-entry" | "both";

export interface PlanLintViolation {
  code: PlanGrammarCode;
  /** One-based line, when the rule is tied to one. */
  line: number | null;
  message: string;
  /** What to do about it, in the words the gate itself uses. */
  rule: string;
  moment: PlanLintMoment;
}

export interface PlanLintReport {
  plan: string;
  /** `false` when the WORKSPACE block could not be read: publication then judges semantics only. */
  workspace_block: boolean;
  violations: PlanLintViolation[];
}

export type PlanLintResult =
  | { ok: true; report: PlanLintReport }
  | { ok: false; failure: { code: string; message: string; action: string } };

export const PLAN_LINT_COMMAND = "aw plan lint <plan>";

const LOCATOR_CODES: Record<PlanLocatorReason, string> = {
  invalid: "PLAN_LINT_TARGET_INVALID",
  absent: "PLAN_LINT_PLAN_ABSENT",
  ambiguous: "PLAN_LINT_TARGET_AMBIGUOUS",
};

/**
 * What to do about a plan grammar failure, said at the moment it was found.
 *
 * Structure goes to the refinement that owns it; a clause that names no
 * observable check is a phrase to fix where it is being written, and at a save
 * proposal nothing is even saved yet. Every answer names the lint, which lists
 * the whole grammar at once instead of one refusal per attempt.
 */
export function planBoundaryAction(
  code: PlanGrammarCode,
  moment: "proposal" | "execution-entry",
): string {
  const then =
    moment === "proposal"
      ? "corregilo en los bytes y volvé a proponer la vista previa"
      : "corregilo con /w:plan-refine antes de volver a entrar a ejecución";
  return `${actionFor(code, moment, then)} · '${PLAN_LINT_COMMAND}' lista todas las violaciones de una vez`;
}

/** The same rule said about a plan on disk: there is no preview to re-propose yet. */
function lintRule(code: PlanGrammarCode, moment: PlanLintMoment): string {
  const then =
    moment === "execution-entry"
      ? "corregilo con /w:plan-refine antes de entrar a ejecución"
      : "corregilo en el plan y volvé a correr el lint";
  return actionFor(code, moment === "execution-entry" ? moment : "proposal", then);
}

function actionFor(
  code: PlanGrammarCode,
  moment: "proposal" | "execution-entry",
  then: string,
): string {
  switch (code) {
    case "PLAN_SOURCE_BOUNDARY_MISSING":
      return `falta la declaración estructural: '> Límite de ejecución: checkout' bajo el título y '> Fuentes:' en cada fase — ${then}`;
    case "PLAN_ISOLATION_INVALID":
      return `'> Aislamiento:' sólo admite unidad; corregí la cabecera — ${then}`;
    case "PLAN_SOURCE_UNKNOWN":
      return `ese alias no está en la tabla Fuentes del bloque WORKSPACE: declaralo ahí, o usá uno de los que ya están — ${then}`;
    case "PLAN_TASK_SOURCE_OUTSIDE_PHASE":
      return `la fuente de una tarea es un subconjunto de la de su fase: ajustá una de las dos — ${then}`;
    case "PLAN_SOURCE_EXTERNAL_CLOSURE":
      return `una cláusula de cierre no puede apoyarse en una superficie externa: llevá esa comprobación a '## Handoff operativo' y dejá en la cláusula una del checkout — ${then}`;
    case "PLAN_LINEAGE_UNSEALED":
      return `declará el linaje en la cabecera: '> Derived from <ruta de la spec>' si el plan deriva de una, o '> Standalone: <de dónde salió>' si nació de la conversación — ${then}`;
    case "PLAN_SOURCE_LOCAL_PROOF_MISSING":
      return moment === "proposal"
        ? "nombrá en esa cláusula el comando, el archivo o la ruta que produce la comprobación, y volvé a proponer la vista previa"
        : "es una frase del documento y no su estructura: nombrá en esa cláusula el comando, el archivo o la ruta que produce la comprobación";
    default:
      return then;
  }
}

/**
 * The whole plan grammar, judged the way both gates judge it — without a session.
 *
 * Publication runs the source policy over the proposed bytes (only its semantic
 * half when the WORKSPACE block cannot be read) plus the lineage seal; the
 * execution entry runs the full source policy against the declared aliases.
 * The lint calls those same functions over the plan on disk, so it cannot
 * disagree with either gate, and it writes nothing: no session, no run, no seal.
 */
export async function lintPlan(
  fs: FileSystemPort,
  paths: PathsService,
  target: string,
): Promise<PlanLintResult> {
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return refuse(
      "PLAN_LINT_DOCS_CANON_INVALID",
      `no se puede ubicar el plan: ${canon.error}`,
      "corregí [docs] para conservar el layout canónico y volvé a correr el lint",
    );
  }
  const root = await resolveWorkspaceRootFrom(fs, paths);
  const located = await locatePlanDocument(fs, root, canon.canon.plan, target);
  if (!located.ok) return refuse(LOCATOR_CODES[located.reason], located.message, located.action);
  // The gates judge only plan Markdown: anything else under the folder is not
  // published as a plan and cannot enter execution, so it is not linted as one.
  if (coreDocumentKindForPath(located.path, canon.canon) !== "plan") {
    return refuse(
      "PLAN_LINT_TARGET_INVALID",
      `'${located.path}' no es un Markdown de plan bajo '${canon.canon.plan}/'`,
      `pasá la ruta de un plan '${canon.canon.plan}/NNN-plan-<slug>.md' o su correlativo`,
    );
  }
  const absolute = join(root, located.path);
  if (!(await fs.exists(absolute))) {
    return refuse(
      "PLAN_LINT_PLAN_ABSENT",
      `'${located.path}' no existe`,
      `verificá la ruta del plan bajo '${canon.canon.plan}/' o pasá su correlativo`,
    );
  }
  let text: string;
  try {
    text = await fs.readText(absolute);
  } catch {
    return refuse(
      "PLAN_LINT_PLAN_UNREADABLE",
      `'${located.path}' existe y no se puede leer`,
      "revisá los permisos del archivo y volvé a correr el lint",
    );
  }
  const block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
  const declared = block === null ? null : block.fuentes.map((source) => source.alias);

  const publication = await planGrammarAtPublication(fs, root, text, declared, canon.canon.spec);
  const entry = planGrammarAtEntry(text, declared);

  return {
    ok: true,
    report: {
      plan: located.path,
      workspace_block: declared !== null,
      violations: mergeMoments(publication.failures, entry),
    },
  };
}

/**
 * What publication refuses in a plan's bytes, and the seal it would stamp.
 *
 * The source policy runs whole against the declared aliases, or only its
 * semantic half when the WORKSPACE block cannot be read: answering an unreadable
 * block with "that alias does not exist" would reject a plan for something the
 * plan did not do. The lineage seal runs in the same stage, so one refusal
 * carries both. `aw flow`'s publication and the lint call this one function.
 */
export async function planGrammarAtPublication(
  fs: FileSystemPort,
  root: string,
  text: string,
  declared: readonly string[] | null,
  specDir: string,
): Promise<{ failures: PlanGrammarFailure[]; seal: PlanLineageSeal }> {
  const failures: PlanGrammarFailure[] =
    declared === null
      ? validateSourceBoundedSemantics(text)
      : validatePlanSourceBoundary(text, declared);
  const seal = await observePlanLineageSeal(fs, root, text, specDir);
  if (seal.status === "refused") failures.push(seal.failure);
  return { failures, seal };
}

/**
 * What the execution entry refuses: the full source policy, where only the
 * reserved `workspace` alias resolves when the WORKSPACE block is unreadable.
 */
export function planGrammarAtEntry(
  text: string,
  declared: readonly string[] | null,
): SourceBoundaryFailure[] {
  return validatePlanSourceBoundary(text, declared ?? []);
}

/** One violation per failure, tagged with every gate that raises it, in line order. */
function mergeMoments(
  publication: readonly PlanGrammarFailure[],
  entry: readonly PlanGrammarFailure[],
): PlanLintViolation[] {
  const keyOf = (failure: PlanGrammarFailure) =>
    `${failure.code}\u0000${failure.line ?? ""}\u0000${failure.message}`;
  const atEntry = new Set(entry.map(keyOf));
  const atPublication = new Set(publication.map(keyOf));
  const violations: PlanLintViolation[] = [
    ...publication.map((failure) =>
      violationOf(failure, atEntry.has(keyOf(failure)) ? "both" : "publication"),
    ),
    ...entry
      .filter((failure) => !atPublication.has(keyOf(failure)))
      .map((failure) => violationOf(failure, "execution-entry")),
  ];
  return violations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function violationOf(failure: PlanGrammarFailure, moment: PlanLintMoment): PlanLintViolation {
  return {
    code: failure.code,
    line: failure.line ?? null,
    message: failure.message,
    rule: lintRule(failure.code, moment),
    moment,
  };
}

function refuse(code: string, message: string, action: string): PlanLintResult {
  return { ok: false, failure: { code, message, action } };
}
