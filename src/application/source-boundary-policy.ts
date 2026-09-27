import { resolve } from "node:path";
import { isPlanHandoffHeading } from "../domain/plan-handoff.js";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type {
  CheckoutProof,
  ExecutionSurface,
  RemoteContextSnapshot,
} from "../domain/source-boundary.js";
import { scanMarkdown } from "./markdown.js";
import { semanticDigest } from "./semantic-operation/protocol.js";

export {
  SOURCE_BOUNDED_EVIDENCE,
  type CheckoutProof,
  type ExecutionSurface,
  type RemoteContextSnapshot,
} from "../domain/source-boundary.js";

export const CHECKOUT_EXECUTION_SURFACE: ExecutionSurface = "checkout";

export type SourceBoundaryCode =
  | "PLAN_SOURCE_BOUNDARY_MISSING"
  | "PLAN_SOURCE_UNKNOWN"
  | "PLAN_TASK_SOURCE_OUTSIDE_PHASE"
  | "PLAN_SOURCE_EXTERNAL_CLOSURE"
  | "PLAN_SOURCE_LOCAL_PROOF_MISSING"
  | "WORKLINE_CHECKOUT_PROOF_MISSING"
  | "WORKLINE_CHECKOUT_PROOF_INVALID"
  | "WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID"
  | "WORKLINE_CHECKOUT_PROOF_ROOT_MISMATCH"
  | "WORKLINE_CHECKOUT_PROOF_STALE";

export interface SourceBoundaryFailure {
  code: SourceBoundaryCode;
  message: string;
  /** One-based Markdown line where the failure was observed, when applicable. */
  line?: number;
}

export interface PlanTaskSources {
  /** The task's ordinal inside its phase, not across the whole document. */
  n: number;
  line: number;
  sources: string[] | null;
}

export interface PlanPhaseSources {
  n: number;
  line: number;
  sources: string[] | null;
  tasks: PlanTaskSources[];
}

export interface ParsedPlanSourceBoundary {
  execution_surface: ExecutionSurface | null;
  /** The value written after the label, present only when it was not accepted. */
  declared_surface?: string;
  phases: PlanPhaseSources[];
}

export interface FinalValidationOverride {
  alias: string;
  build?: string;
  test?: string;
  line: number;
}

/** Only the dedicated validation clauses override the source pipeline. */
export function finalValidationOverrides(text: string): FinalValidationOverride[] {
  const markdown = scanMarkdown(text);
  const overrides: FinalValidationOverride[] = [];
  const headings = new Map(markdown.headings.map((item) => [item.line, item]));
  let inValidations = false;
  for (const [index, raw] of markdown.lines.entries()) {
    if (markdown.fenced[index]) continue;
    const heading = headings.get(index);
    if (heading?.level === 2) inValidations = VALIDATIONS_HEADING.test(foldHeading(heading.title));
    if (!inValidations) continue;
    const clause = /^\s*[-*]\s+Validaci[oó]n final\s*·\s*(`[^`]+`)\s*·\s*(.*)$/i.exec(raw);
    if (clause === null) continue;
    const alias = clause[1]?.slice(1, -1) ?? "";
    const rest = clause[2] ?? "";
    if (!/^(?:build|tests) `[^`]+`(?:\s*·\s*(?:build|tests) `[^`]+`)?$/i.test(rest.trim()))
      continue;
    const build = /(?:^|\s*·\s*)build\s+`([^`]+)`/i.exec(rest)?.[1];
    const test = /(?:^|\s*·\s*)tests\s+`([^`]+)`/i.exec(rest)?.[1];
    if (rest.match(/\bbuild\s+`/gi)?.length === 2 || rest.match(/\btests\s+`/gi)?.length === 2)
      continue;
    overrides.push({
      alias,
      ...(build ? { build } : {}),
      ...(test ? { test } : {}),
      line: index + 1,
    });
  }
  return overrides;
}

const TASKS_HEADING = "tasks";
const PHASE_HEADING = /^F(\d+)\s*(?:[—–-]\s*)?(.*)$/;
const SURFACE_LINE = /^>\s*(?:L[ií]mite de ejecuci[oó]n|Execution surface)\s*:\s*(.+)$/i;
const SOURCES_LINE = /^>\s*Fuentes\s*:\s*(.*)$/i;
const TASK_LINE = /^\s*[-*]\s*\[[ xX]\]\s+(.+?)\r?$/;
const TASK_SOURCES = /_\(\s*fuentes\s*:\s*([^)]*)\)_/i;
// A clarification in parentheses never widens what the CLI enforces.
const CHECKOUT_SURFACE = /^checkout(?:\s*\([^()]*[^()\s][^()]*\))?$/i;
const OPENS_BLOCK = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||\*\*)/;

/**
 * The one continuation rule of a clause, shared by the gate's clauses and by a
 * task's source declaration. Markdown's indented continuation folds, as before.
 * A column-0 line folds too, while no other block opened since the clause
 * started: a list item, a heading, a blockquote, a table row or a bold label.
 * A blank line ends the clause.
 */
class ClauseContinuation {
  private prose = false;

  start(): void {
    this.prose = true;
  }

  /** A block the reader consumed on its own, such as a fence or a blockquote. */
  interrupt(): void {
    this.prose = false;
  }

  /** `null` when the clause ended; otherwise whether the line belongs to it. */
  read(raw: string): boolean | null {
    if (raw.trim().length === 0) {
      this.prose = false;
      return null;
    }
    if (/^\s{2,}\S/.test(raw)) return true;
    if (OPENS_BLOCK.test(raw.trimStart())) this.prose = false;
    return this.prose;
  }
}

type SemanticClauseKind = "task" | "phase-validation" | "phase-exit" | "plan-validation";

interface SemanticClause {
  kind: SemanticClauseKind;
  line: number;
  text: string;
}

// These are structural labels that define a closing clause, not a vocabulary of
// forbidden deployment words. The policy then reasons from a *positive* local
// proof grammar and from locators, whose syntax carries their surface.
const VALIDATIONS_HEADING = /^(?:validaciones|validations)$/i;
const PHASE_VALIDATION_LINE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:validaci[oó]n(?: de fase)?|phase validation)(?:\*\*)?\s*:/i;
const PHASE_EXIT_LINE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:condici[oó]n de salida|exit condition|cierre|closure)(?:\*\*)?\s*:/i;
// A URI or host:port is an execution surface by grammar, independently of its
// name. This intentionally catches a new host/connection without having to add
// it to a blacklist. It judges what a CheckoutProof runs, so it stays strict:
// the clause reading below relaxes only the early warning, never this gate.
const REMOTE_LOCATOR =
  /(?:\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s<>()]+|\b[A-Za-z0-9][A-Za-z0-9.-]*:\d{2,5}(?:\/[^\s<>()]*)?)/;
// The same two shapes, split so a closing clause can tell a file citation, a
// time or an image tag from a host. The URI tail stops where REMOTE_LOCATOR's
// does, so `<https://…>` is judged by its authority and not by the autolink.
const SCHEME_LOCATOR = /\b([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/([^\s<>()]*)/g;
// The name is the whole token, so `job_runner.py:40` or `+page.ts:9` is judged
// by its full name and not by the tail after the underscore or the plus. A dot
// before it does not hide it: `…db:5432` is still a host.
const HOST_PORT_LOCATOR = /(?<![\w+-])([\w+-][\w.+-]*):(\d{2,5})(\/[^\s<>()]*)?/g;
const PLACEHOLDER_SCHEME = /^(?:esquema|scheme|protocolo|protocol)$/i;
// A template is a closed pair in the authority, `host[:puerto]` or `{{host}}`.
// An IPv6 literal such as `[::1]` holds only hex digits, colons and dots.
const TEMPLATE_AUTHORITY = /\[[^\]]*[^\]0-9A-Fa-f:.][^\]]*\]|\{[^}]*\}/;
const LOOPBACK_OR_IPV4 = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})$/i;
// `remote-read` is the discriminant of RemoteContextSnapshot, not a prose term.
// Seeing that typed context in a closure clause is invalid by construction.
const REMOTE_CONTEXT_DISCRIMINANT = /\bkind\s*:\s*["'`]?remote-read\b/i;
// COMPATIBILITY PATH, NOT THE CRITERION.
//
// This is the term allowlist that judged closure evidence before the referent
// rule below existed. It is kept so that no plan already written changes
// verdict: the criterion is the UNION of the two, which is strictly more
// permissive than either, so there is no migration and no grace period.
//
// Its path branch is exactly why the rule had to change: it accepted a relative
// path only under `src/`, `tests/`, `fixtures/`, `docs/` or `scripts/` — the
// directories of THIS repo — so a plan validating over `migraciones/` or `db/`
// was rejected for naming its own, while describing a perfectly local check.
const LOCAL_PROOF_TERMS_COMPAT =
  /\b(?:checkout|checkoutproof|fixture|ephemeral|test(?:s)?|prueba(?:s)?|inspecci[oó]n|inspection|lint|typecheck|build|golden(?:s)?|diff)\b|\bnpm\s+(?:run\s+)?(?:test|lint|typecheck|build|pack)\b|(?:^|[\s`(])(?:\.?\/?(?:src|tests|fixtures|docs|scripts)\/)/i;

// THE CRITERION: a closing clause is local when it names a REFERENT the checkout
// can produce — never when it happens to use a word from a list. Two structural
// forms, both about the shape of the reference and neither about vocabulary:
//
//   · an invocation written as inline code — `npm run test`, `psql -f db/seed.sql`;
//   · a relative path of ANY shape — `migraciones/001_init.sql`, `db/seeds/`.
//
// A remote locator never reaches this side: `remoteSurfaceOf` rejects the clause
// first, which is what lets the positive rule stay ignorant of surfaces. The
// policy is pure and touches no disk, so it judges whether the clause POINTS at
// the checkout, never whether the file is there — that is the checkout proof's
// job at execution time.
const INLINE_CODE_SPAN = /`([^`\n]+)`/g;
// A path is RELATIVE by grammar: it starts at a delimiter, never after another
// separator, so `/etc/passwd` and `~/scripts/x.sh` — local to a machine but
// outside the checkout — are not referents while `migraciones/001.sql` is.
const RELATIVE_PATH = /(?:^|[\s`("'[<])((?:\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\/[\w.@+-]*)/g;
const FILE_NAME = /\.[A-Za-z0-9]{1,8}$/;
const PROGRAM_NAME = /^(?:\.{1,2}\/)?[A-Za-z_][\w.+-]*$/;
// A bare file is a referent too, cited or not (`pom.xml`, `SCRIPTS.sql`). It
// starts at a delimiter — never after a separator, which would make it the tail
// of a path the rule above already judges. Its extension is lowercase and starts
// with a letter, so neither a version such as 25.6.1 nor RR.HH. or EE.UU. is a
// file, and its stem has two characters, so p.ej. is not one either.
const BARE_FILE =
  /(?:^|[\s`("'[<])[\w@+-]{2,}(?:\.[\w@+-]+)*\.[a-z][a-z0-9]{0,7}(?=$|[\s`)"'\]>,;:.!?])/;
// How a clause names what produces it, in the words of the forms above.
const HOW_TO_CITE = [
  "citá el comando con sus argumentos entre comillas invertidas (`./mvnw test`)",
  "o nombrá el archivo (pom.xml), la ruta (tests/unit/x.test.ts) o el test",
  "(UsuarioServiceTest) que la produce",
].join(" ");
// A relative executable is a referent only when cited: `./mvnw`.
const RELATIVE_EXECUTABLE = /^\.{1,2}\/[\w.+-]+$/;
// A test named as the runner reports it. The first hump needs a lowercase letter
// so EXIT or AUDIT are not tests, and `Test` alone is not a name.
const TEST_NAME = /\b[A-Z][a-z0-9][A-Za-z0-9]*?(?:Test|Tests|IT|Spec)\b|\btest_[A-Za-z0-9_]+\b/;

/**
 * Reads the structural source declarations from a plan without interpreting its
 * business prose. The source policy therefore has one seam for every caller:
 * parsers, promotion gates and plan-exec all see the same phase/task graph.
 */
export function parsePlanSourceBoundary(text: string): ParsedPlanSourceBoundary {
  const phases: PlanPhaseSources[] = [];
  let surface: ExecutionSurface | null = null;
  let declaredSurface: string | null = null;
  let inTasks = false;
  let current: PlanPhaseSources | null = null;
  let currentTask: PlanTaskSources | null = null;
  const continuation = new ClauseContinuation();
  const markdown = scanMarkdown(text);

  for (const [index, raw] of markdown.lines.entries()) {
    if (markdown.fenced[index]) {
      continuation.interrupt();
      continue;
    }
    const line = index + 1;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(raw);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      const level = heading[1].length;
      if (level <= 2) {
        inTasks = level === 2 && foldHeading(heading[2]) === TASKS_HEADING;
        current = null;
        currentTask = null;
        continue;
      }
      if (level === 3) {
        current = inTasks ? phaseFromHeading(heading[2], line) : null;
        if (current !== null) phases.push(current);
        currentTask = null;
        continue;
      }
    }

    const surfaceMatch = SURFACE_LINE.exec(raw.trim());
    if (surfaceMatch?.[1] !== undefined && surface === null) {
      surface = readExecutionSurface(surfaceMatch[1]);
      declaredSurface = surface === null ? surfaceMatch[1].trim() : null;
      continuation.interrupt();
      continue;
    }

    if (current === null) continue;
    const sourceMatch = SOURCES_LINE.exec(raw.trim());
    if (sourceMatch !== null && current.sources === null) {
      current.sources = readAliases(sourceMatch[1] ?? "");
      continuation.interrupt();
      continue;
    }
    const taskMatch = TASK_LINE.exec(raw);
    if (taskMatch?.[1] !== undefined) {
      const task = taskMatch[1];
      const declared = TASK_SOURCES.exec(task);
      currentTask = {
        n: current.tasks.length + 1,
        line,
        sources: declared === null ? null : readAliases(declared[1] ?? ""),
      };
      current.tasks.push(currentTask);
      continuation.start();
      continue;
    }
    if (currentTask !== null) currentTask = continueTask(currentTask, continuation, raw);
  }

  return {
    execution_surface: surface,
    ...(declaredSurface !== null ? { declared_surface: declaredSurface } : {}),
    phases,
  };
}

/**
 * The declaration may sit on the task's continuation, never on arbitrary prose
 * in the phase: an annotation in a validation paragraph cannot retroactively
 * make the preceding task executable. `null` once the task ended.
 */
function continueTask(
  task: PlanTaskSources,
  continuation: ClauseContinuation,
  raw: string,
): PlanTaskSources | null {
  const folds = continuation.read(raw);
  if (folds === null) return null;
  if (folds && task.sources === null) {
    const declared = TASK_SOURCES.exec(raw);
    if (declared !== null) task.sources = readAliases(declared[1] ?? "");
  }
  return task;
}

/**
 * Validates the plan's source contract against the aliases its WORKSPACE block
 * declares. `workspace` is the sole reserved alias; every other spelling must
 * resolve through that block. Errors are structural, not keyword-based: a
 * narrative cannot make an undeclared or remote source locally executable.
 */
export function validatePlanSourceBoundary(
  text: string,
  declaredSources: readonly string[],
): SourceBoundaryFailure[] {
  const parsed = parsePlanSourceBoundary(text);
  const failures: SourceBoundaryFailure[] = [];
  if (parsed.execution_surface !== CHECKOUT_EXECUTION_SURFACE) {
    failures.push({
      code: "PLAN_SOURCE_BOUNDARY_MISSING",
      message: surfaceMessage(parsed.declared_surface),
    });
  }
  if (parsed.phases.length === 0) {
    failures.push({
      code: "PLAN_SOURCE_BOUNDARY_MISSING",
      message: "el plan no declara ninguna fase con fuentes explícitas",
    });
    return failures;
  }

  const known = new Set(["workspace", ...declaredSources]);
  for (const phase of parsed.phases) {
    if (phase.sources === null || phase.sources.length === 0) {
      failures.push({
        code: "PLAN_SOURCE_BOUNDARY_MISSING",
        message: `F${phase.n} no declara '> Fuentes:'`,
        line: phase.line,
      });
    } else {
      failures.push(...unknownSources(phase.sources, known, phase.line, `F${phase.n}`));
    }
    const phaseSources = new Set(phase.sources ?? []);
    for (const task of phase.tasks) {
      if (task.sources === null || task.sources.length === 0) {
        failures.push({
          code: "PLAN_SOURCE_BOUNDARY_MISSING",
          message: `T${phase.n}.${task.n} no declara '_(fuentes: …)_'`,
          line: task.line,
        });
        continue;
      }
      failures.push(...unknownSources(task.sources, known, task.line, `T${phase.n}.${task.n}`));
      const outside = task.sources.filter((source) => !phaseSources.has(source));
      if (outside.length > 0) {
        failures.push({
          code: "PLAN_TASK_SOURCE_OUTSIDE_PHASE",
          message: `T${phase.n}.${task.n} declara ${outside.join(", ")} fuera de las fuentes de F${phase.n}`,
          line: task.line,
        });
      }
    }
  }
  const scoped = new Set(sourceAliasesOfPlan(text));
  const overrides = finalValidationOverrides(text);
  const seen = new Set<string>();
  for (const override of overrides) {
    if (
      !scoped.has(override.alias) ||
      override.alias === "workspace" ||
      seen.has(override.alias) ||
      (!override.build && !override.test)
    ) {
      failures.push({
        code: "PLAN_SOURCE_UNKNOWN",
        message: `la validación final de línea ${override.line} debe nombrar una fuente de código del plan una sola vez y declarar build o tests: '${override.alias}'`,
        line: override.line,
      });
    }
    seen.add(override.alias);
  }
  const recognized = new Set(overrides.map((item) => item.line));
  const markdown = scanMarkdown(text);
  const headings = new Map(markdown.headings.map((item) => [item.line, item]));
  let inValidations = false;
  for (const [index, line] of markdown.lines.entries()) {
    if (markdown.fenced[index]) continue;
    const heading = headings.get(index);
    if (heading?.level === 2) inValidations = VALIDATIONS_HEADING.test(foldHeading(heading.title));
    if (
      inValidations &&
      /^\s*[-*]\s+Validaci[oó]n final\s*·/i.test(line) &&
      !recognized.has(index + 1)
    ) {
      failures.push({
        code: "PLAN_SOURCE_UNKNOWN",
        message: `la validación final de línea ${index + 1} requiere alias y comandos entre comillas invertidas`,
        line: index + 1,
      });
    }
  }
  failures.push(...validateSourceBoundedSemantics(text));
  return failures;
}

/**
 * Read the prose positions that can turn a plan into an external dependency.
 *
 * This is intentionally not a denylist such as `prod|staging|host`: a renamed
 * host must not become executable merely because the word was not known.  A
 * closing clause is instead a small semantic object: it needs a positive local
 * proof form, and it may not contain a syntactically remote locator or the
 * typed RemoteContextSnapshot discriminant.  Handoffs are deliberately outside
 * this grammar because they are deliveries, never closure conditions.
 */
export function validateSourceBoundedSemantics(text: string): SourceBoundaryFailure[] {
  const failures: SourceBoundaryFailure[] = [];
  for (const clause of sourceBoundedClauses(text)) {
    const remote = remoteSurfaceOf(clause.text);
    if (remote !== null) {
      failures.push({
        code: "PLAN_SOURCE_EXTERNAL_CLOSURE",
        line: clause.line,
        message: `${semanticClauseLabel(clause)} depende de la superficie externa '${remote}'`,
      });
      continue;
    }
    if (
      (clause.kind === "phase-validation" || clause.kind === "plan-validation") &&
      !namesCheckoutReferent(clause.text) &&
      !LOCAL_PROOF_TERMS_COMPAT.test(clause.text)
    ) {
      failures.push({
        code: "PLAN_SOURCE_LOCAL_PROOF_MISSING",
        line: clause.line,
        message: `${semanticClauseLabel(clause)} no nombra ninguna comprobación observable en el checkout: ${HOW_TO_CITE}`,
      });
    }
  }
  return failures;
}

/**
 * The closing clauses of a document, by kind and text — the gate's own reading.
 *
 * Exported so a guard that must refuse a change to the closure path uses the
 * SAME extraction the gate judges with, instead of a second parser that could
 * disagree about what a closing clause even is. Line numbers are deliberately
 * dropped: they move with any edit above them, and an editorial fix three
 * sections up is not a change to a clause.
 */
export function closingClausesOf(text: string): { kind: SemanticClauseKind; text: string }[] {
  return sourceBoundedClauses(text)
    .filter((clause) => clause.kind !== "task")
    .map((clause) => ({ kind: clause.kind, text: clause.text }));
}

function sourceBoundedClauses(text: string): SemanticClause[] {
  const clauses: SemanticClause[] = [];
  const markdown = scanMarkdown(text);
  const headings = new Map(markdown.headings.map((heading) => [heading.line, heading]));
  let inTasks = false;
  let inHandoff = false;
  let inValidations = false;
  let inPhase = false;
  let active: SemanticClause | null = null;
  const continuation = new ClauseContinuation();

  const add = (kind: SemanticClauseKind, line: number, value: string): SemanticClause => {
    const clause = { kind, line, text: value.trim() };
    clauses.push(clause);
    continuation.start();
    return clause;
  };

  for (let index = 0; index < markdown.lines.length; index += 1) {
    if (markdown.fenced[index]) {
      active = null;
      continue;
    }
    const raw = markdown.lines[index] ?? "";
    const trimmed = raw.trim();
    const heading = headings.get(index);
    if (heading !== undefined) {
      const folded = foldHeading(heading.title);
      if (heading.level <= 2) {
        inHandoff = isPlanHandoffHeading(folded);
        inValidations = VALIDATIONS_HEADING.test(folded);
        inTasks = folded === TASKS_HEADING;
        inPhase = false;
      } else if (heading.level === 3) {
        inPhase = inTasks && phaseFromHeading(heading.title, index + 1) !== null;
      }
      active = null;
      continue;
    }
    if (inHandoff) continue;

    const task = TASK_LINE.exec(raw);
    if (inTasks && inPhase && task?.[1] !== undefined) {
      active = add("task", index + 1, task[1].replace(TASK_SOURCES, ""));
      continue;
    }
    if (inPhase && PHASE_VALIDATION_LINE.test(raw)) {
      active = add("phase-validation", index + 1, raw);
      continue;
    }
    if (inPhase && PHASE_EXIT_LINE.test(raw)) {
      active = add("phase-exit", index + 1, raw);
      continue;
    }
    if (inValidations && trimmed.length > 0 && /^[-*]\s+/.test(trimmed)) {
      active = add("plan-validation", index + 1, trimmed.replace(/^[-*]\s+/, ""));
      continue;
    }
    // A wrapped task/validation stays one semantic clause.
    if (active === null) continue;
    const folds = continuation.read(raw);
    if (folds === null) active = null;
    else if (folds) active.text = `${active.text} ${trimmed}`;
  }
  return clauses;
}

/**
 * Does the clause name something the checkout can produce?
 *
 * Two forms. A relative path is a referent when its last segment is a file name
 * or it ends in a separator — which is what keeps `N/A` and `60/40` from reading
 * as evidence while `migraciones/001.sql` and `db/seeds/` do. An inline-code
 * span whose first of two or more tokens has the shape of a program is an
 * invocation, so `make verificar-catalogo` accredits without naming any path.
 */
function namesCheckoutReferent(text: string): boolean {
  if (namesRelativePath(text) || BARE_FILE.test(text) || TEST_NAME.test(text)) return true;
  for (const match of text.matchAll(INLINE_CODE_SPAN)) {
    const tokens = (match[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length >= 2 && PROGRAM_NAME.test(tokens[0] ?? "")) return true;
    if (tokens.length === 1 && RELATIVE_EXECUTABLE.test(tokens[0] ?? "")) return true;
  }
  return false;
}

/**
 * One path predicate for the whole rule, inside code spans and in prose alike.
 *
 * Backticks are not part of a path's grammar, so scanning the clause once
 * covers `` `migraciones/003.sql` `` and the same path written bare — and keeps
 * a code span from accrediting `N/A` merely for carrying a slash.
 */
function namesRelativePath(text: string): boolean {
  for (const match of text.matchAll(RELATIVE_PATH)) {
    const path = match[1] ?? "";
    if (path.endsWith("/")) return true;
    if (FILE_NAME.test(path.slice(path.lastIndexOf("/") + 1))) return true;
  }
  return false;
}

/**
 * The remote surface a closing clause names, read more finely than a proof's args.
 *
 * A clause is an early warning: what actually runs is judged by `remoteLocatorIn`,
 * which stays strict. So here `pom.xml:277`, `10:30`, `node:20` and a generic
 * `esquema://host[:puerto]` read as what they are, and only an ambiguous shape
 * keeps the remote reading.
 */
function remoteSurfaceOf(text: string): string | null {
  let rest = text;
  for (const match of text.matchAll(SCHEME_LOCATOR)) {
    rest = rest.replace(match[0], " ");
    const locator = schemeLocator(match[1] ?? "", match[2] ?? "");
    if (locator !== null) return locator;
  }
  for (const match of rest.matchAll(HOST_PORT_LOCATOR)) {
    const at = match.index ?? 0;
    // After one `/` the name is a path segment; after `//` it is a host.
    const inPath = rest[at - 1] === "/" && rest[at - 2] !== "/";
    if (hostPortIsRemote(match[1] ?? "", match[2] ?? "", inPath, match[3])) return match[0];
  }
  return REMOTE_CONTEXT_DISCRIMINANT.test(text) ? "RemoteContextSnapshot" : null;
}

/** A URI is remote unless its scheme or its authority is a template placeholder. */
function schemeLocator(scheme: string, tail: string): string | null {
  const authority = tail.split("/")[0] ?? "";
  if (PLACEHOLDER_SCHEME.test(scheme) || TEMPLATE_AUTHORITY.test(authority)) return null;
  return tail.length === 0 ? null : `${scheme}://${tail}`;
}

/**
 * `X:N` without a scheme, in a clause. Loopback and IPv4 are hosts; digits alone
 * are a time or a ratio; after a `/` it is a path with a line; one label is an
 * image tag below three digits; two dots or a trailing path are a host; one dot
 * before a letter is a file with its line.
 */
function hostPortIsRemote(
  name: string,
  port: string,
  inPath: boolean,
  path: string | undefined,
): boolean {
  if (LOOPBACK_OR_IPV4.test(name)) return true;
  if (/^\d+$/.test(name) || inPath) return false;
  const dots = name.split(".").length - 1;
  if (dots === 0) return port.length >= 3;
  if (dots >= 2 || path !== undefined) return true;
  return !/\.[A-Za-z]/.test(name);
}

function semanticClauseLabel(clause: SemanticClause): string {
  switch (clause.kind) {
    case "task":
      return `la tarea de línea ${clause.line}`;
    case "phase-validation":
      return `la validación de fase de línea ${clause.line}`;
    case "phase-exit":
      return `la condición de salida de línea ${clause.line}`;
    case "plan-validation":
      return `la validación de plan de línea ${clause.line}`;
  }
}

/** The exact source aliases a valid plan scopes, in first-declared order. */
export function sourceAliasesOfPlan(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const phase of parsePlanSourceBoundary(text).phases) {
    for (const source of phase.sources ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      out.push(source);
    }
  }
  return out;
}

/** A stable digest of the checkout state a proof was obtained from. */
export function checkoutDigest(input: {
  source: string;
  head: string | null;
  dirty: boolean;
  changed_files: readonly string[];
  /** Content-sensitive fingerprint of tracked and untracked working-tree state. */
  worktree_fingerprint: string;
}): string {
  return semanticDigest({
    source: input.source,
    head: input.head,
    dirty: input.dirty,
    changed_files: [...input.changed_files].sort(),
    worktree_fingerprint: input.worktree_fingerprint,
  });
}

export interface CheckoutState {
  source: string;
  digest: string;
  /**
   * `false` when two consecutive computations of the digest disagreed. Absent
   * when it was measured once, which is all a pure caller can do.
   */
  reproducible?: boolean;
  /**
   * Absolute local root the digest was computed over, when the caller observed it.
   *
   * Optional on purpose: a pure caller holding only alias and digest keeps working,
   * and its rejection names the alias alone exactly as it did before. The execution
   * route always resolves a root, so the message it produces is the complete one.
   */
  root?: string;
}

/** The sources a proof may name, so a rejected one says what it should have been. */
function eligibleSources(states: readonly CheckoutState[]): string {
  const names = states.map((state) => state.source);
  return names.length > 0 ? names.join(", ") : "ninguna";
}

/**
 * A digest that does not survive its own recomputation is not evidence that the
 * checkout moved, and saying so sends the reader to look for a change that may
 * not exist.
 *
 * Both branches name the DIRECTORY they measured, not just the alias. On a nested
 * hub the alias alone was actively misleading: it asserted the tree had moved when
 * the tree was intact and only the measured directory differed, so the reader went
 * hunting for a change that was not there. Each branch also carries its own
 * corrective action, because "recapture" and "stabilize" are not the same advice
 * and one of them is useless for the other cause.
 */
function staleMessage(current: CheckoutState): string {
  const at = current.root === undefined ? "" : ` (${current.root})`;
  if (current.reproducible !== false) {
    return [
      `el checkout de '${current.source}'${at} cambió desde que se capturó la prueba:`,
      "recapturala contra esa misma raíz y no escribas en ella entre la captura y el submit",
    ].join(" ");
  }
  return [
    `el digest de '${current.source}'${at} no coincide y NO es estable entre dos cómputos`,
    "consecutivos: o el árbol cambia mientras se valida, o la huella no es reproducible;",
    "estabilizá esa raíz antes de reintentar, porque recapturar no alcanza si persiste",
  ].join(" ");
}

/**
 * Validates a proof against freshly observed checkout state.
 *
 * A caller supplies only checkouts it has already resolved and acquired. This
 * keeps path/worktree discovery outside the policy while keeping all proof shape,
 * source and freshness rules in one module.
 */
export function validateCheckoutProof(
  proof: CheckoutProof | undefined,
  states: readonly CheckoutState[] | null,
): SourceBoundaryFailure | null {
  if (proof === undefined) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_MISSING",
      message: "la evidencia source-bounded debe incluir su CheckoutProof local",
    };
  }
  const basic = proofFailure(proof);
  if (basic !== null) return basic;
  // A pure/parser caller can enforce the proof's shape before it has acquired a
  // checkout. The execution route always supplies the live states and therefore
  // also enforces ownership and freshness.
  if (states === null) return null;
  const current = states.find((state) => state.source === proof.source);
  if (current === undefined) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
      message:
        `la prueba declara la fuente '${proof.source}', que no pertenece al ` +
        `checkout adquirido (elegibles: ${eligibleSources(states)})`,
    };
  }
  if (
    proof.root !== undefined &&
    current.root !== undefined &&
    resolve(proof.root) !== resolve(current.root)
  ) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_ROOT_MISMATCH",
      message: `la prueba se midió sobre ${proof.root} y el checkout es ${current.root}`,
    };
  }
  if (current.digest !== proof.checkout_digest) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_STALE",
      message: staleMessage(current),
    };
  }
  return null;
}

/** Structural validation for an explicitly captured research-only remote read. */
export function validateRemoteContextSnapshot(value: unknown): RemoteContextSnapshot | null {
  if (!isRecord(value) || value.kind !== "remote-read" || value.readonly !== true) return null;
  if (
    typeof value.connection !== "string" ||
    typeof value.query_artifact !== "string" ||
    typeof value.captured_at !== "string" ||
    typeof value.result_digest !== "string"
  ) {
    return null;
  }
  if (
    value.connection.trim().length === 0 ||
    value.query_artifact.trim().length === 0 ||
    value.captured_at.trim().length === 0 ||
    value.result_digest.trim().length === 0
  ) {
    return null;
  }
  return {
    kind: "remote-read",
    connection: value.connection,
    readonly: true,
    query_artifact: value.query_artifact,
    captured_at: value.captured_at,
    result_digest: value.result_digest,
  };
}

function phaseFromHeading(title: string, line: number): PlanPhaseSources | null {
  const match = PHASE_HEADING.exec(title.trim());
  if (match?.[1] === undefined) return null;
  return { n: Number(match[1]), line, sources: null, tasks: [] };
}

function foldHeading(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*:?\s*$/, "")
    .replace(/:\s*$/, "")
    .trim()
    .toLowerCase();
}

function readExecutionSurface(value: string): ExecutionSurface | null {
  return CHECKOUT_SURFACE.test(value.trim()) ? CHECKOUT_EXECUTION_SURFACE : null;
}

/** Says what was read and what is extra, so the fix is not a guess. */
function surfaceMessage(declared: string | undefined): string {
  const expected =
    "el plan debe declarar '> Límite de ejecución: checkout' antes de poder ejecutarse";
  if (declared === undefined) return expected;
  if (!/^checkout\b/i.test(declared))
    return `${expected}; leyó '${declared}', que no es 'checkout'`;
  const extra = declared.slice("checkout".length).trim();
  return `${expected}; leyó '${declared}' y sobra '${extra}': sólo se admite una aclaración entre paréntesis`;
}

function readAliases(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function unknownSources(
  sources: readonly string[],
  known: ReadonlySet<string>,
  line: number,
  owner: string,
): SourceBoundaryFailure[] {
  const unknown = sources.filter((source) => !known.has(source));
  if (unknown.length === 0) return [];
  return [
    {
      code: "PLAN_SOURCE_UNKNOWN",
      message: `${owner} declara fuentes no presentes en AGENTS.md > Fuentes: ${unknown.join(", ")}`,
      line,
    },
  ];
}

function proofFailure(proof: CheckoutProof): SourceBoundaryFailure | null {
  if (proof.source.trim().length === 0 || proof.checkout_digest.trim().length === 0) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID",
      message: "la prueba debe declarar source y checkout_digest no vacíos",
    };
  }
  const cwd = proof.relative_cwd === "." ? { ok: true } : checkSafeRelativePath(proof.relative_cwd);
  if (!cwd.ok) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
      message: `relative_cwd '${proof.relative_cwd}' no es una ruta segura dentro del checkout`,
    };
  }
  return proof.kind === "command" ? commandProofFailure(proof) : inspectionProofFailure(proof);
}

function commandProofFailure(proof: CheckoutProof): SourceBoundaryFailure | null {
  if (!("program" in proof.invocation)) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID",
      message: "una prueba command debe declarar una invocación command",
    };
  }
  if (
    proof.invocation.program.trim().length === 0 ||
    !Array.isArray(proof.invocation.args) ||
    !proof.invocation.args.every((arg) => typeof arg === "string")
  ) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID",
      message: "una prueba command debe declarar program y args de texto",
    };
  }
  const remote = remoteLocatorIn([proof.invocation.program, ...proof.invocation.args]);
  if (remote === null) return null;
  return {
    code: "WORKLINE_CHECKOUT_PROOF_INVALID",
    message: `una prueba command no puede invocar la superficie externa '${remote}'`,
  };
}

function inspectionProofFailure(proof: CheckoutProof): SourceBoundaryFailure | null {
  if (!("artifact" in proof.invocation)) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID",
      message: "una prueba inspection debe declarar una invocación inspection",
    };
  }
  if (
    typeof proof.invocation.artifact !== "string" ||
    proof.invocation.artifact.trim().length === 0
  ) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID",
      message: "una prueba inspection debe declarar su artifact",
    };
  }
  const artifact = checkSafeRelativePath(proof.invocation.artifact);
  if (!artifact.ok) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
      message: `artifact '${proof.invocation.artifact}' no es una ruta segura dentro del checkout`,
    };
  }
  const remote = remoteLocatorIn([artifact.path]);
  if (remote !== null) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
      message: `una prueba inspection no puede señalar la superficie externa '${remote}'`,
    };
  }
  return null;
}

/** A command receipt remains local only when none of its fields locates a remote surface. */
function remoteLocatorIn(values: readonly string[]): string | null {
  for (const value of values) {
    const locator = REMOTE_LOCATOR.exec(value)?.[0];
    if (locator !== undefined) return locator;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
