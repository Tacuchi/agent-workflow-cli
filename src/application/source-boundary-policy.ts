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
  phases: PlanPhaseSources[];
}

const TASKS_HEADING = "tasks";
const PHASE_HEADING = /^F(\d+)\s*(?:[—–-]\s*)?(.*)$/;
const SURFACE_LINE = /^>\s*(?:L[ií]mite de ejecuci[oó]n|Execution surface)\s*:\s*(.+)$/i;
const SOURCES_LINE = /^>\s*Fuentes\s*:\s*(.*)$/i;
const TASK_LINE = /^\s*[-*]\s*\[[ xX]\]\s+(.+)$/;
const TASK_SOURCES = /_\(\s*fuentes\s*:\s*([^)]*)\)_/i;

type SemanticClauseKind = "task" | "phase-validation" | "phase-exit" | "plan-validation";

interface SemanticClause {
  kind: SemanticClauseKind;
  line: number;
  text: string;
}

// These are structural labels that define a closing clause, not a vocabulary of
// forbidden deployment words. The policy then reasons from a *positive* local
// proof grammar and from locators, whose syntax carries their surface.
const HANDOFF_HEADING = /^(?:handoff operativo|operational handoff)$/i;
const VALIDATIONS_HEADING = /^(?:validaciones|validations)$/i;
const PHASE_VALIDATION_LINE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:validaci[oó]n(?: de fase)?|phase validation)(?:\*\*)?\s*:/i;
const PHASE_EXIT_LINE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:condici[oó]n de salida|exit condition|cierre|closure)(?:\*\*)?\s*:/i;
// A URI or host:port is an execution surface by grammar, independently of its
// name. This intentionally catches a new host/connection without having to add
// it to a blacklist.
const REMOTE_LOCATOR =
  /(?:\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s<>()]+|\b[A-Za-z0-9][A-Za-z0-9.-]*:\d{2,5}(?:\/[^\s<>()]*)?)/;
// `remote-read` is the discriminant of RemoteContextSnapshot, not a prose term.
// Seeing that typed context in a closure clause is invalid by construction.
const REMOTE_CONTEXT_DISCRIMINANT = /\bkind\s*:\s*["'`]?remote-read\b/i;
// A close is allowed only when it names one of the local proof forms Workline
// can reproduce. This is an allowlist of evidence *semantics*, not a list of
// remote products/hosts to forbid. Relative checkout artifacts are evidence too.
const LOCAL_PROOF =
  /\b(?:checkout|checkoutproof|fixture|ephemeral|test(?:s)?|prueba(?:s)?|inspecci[oó]n|inspection|lint|typecheck|build|golden(?:s)?|diff)\b|\bnpm\s+(?:run\s+)?(?:test|lint|typecheck|build|pack)\b|(?:^|[\s`(])(?:\.?\/?(?:src|tests|fixtures|docs|scripts)\/)/i;

/**
 * Reads the structural source declarations from a plan without interpreting its
 * business prose. The source policy therefore has one seam for every caller:
 * parsers, promotion gates and plan-exec all see the same phase/task graph.
 */
export function parsePlanSourceBoundary(text: string): ParsedPlanSourceBoundary {
  const phases: PlanPhaseSources[] = [];
  let surface: ExecutionSurface | null = null;
  let inTasks = false;
  let current: PlanPhaseSources | null = null;
  let currentTask: PlanTaskSources | null = null;
  const markdown = scanMarkdown(text);

  for (const [index, raw] of markdown.lines.entries()) {
    if (markdown.fenced[index]) continue;
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
      continue;
    }

    if (current === null) continue;
    const sourceMatch = SOURCES_LINE.exec(raw.trim());
    if (sourceMatch !== null && current.sources === null) {
      current.sources = readAliases(sourceMatch[1] ?? "");
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
      continue;
    }
    // Markdown keeps a wrapped list item's continuation indented. Let the
    // declaration sit on that continuation, but never scan arbitrary prose in
    // the phase: an annotation in a validation paragraph cannot retroactively
    // make the preceding task executable.
    if (
      currentTask !== null &&
      currentTask.sources === null &&
      /^\s{2,}\S/.test(raw) &&
      raw.trim().length > 0
    ) {
      const declared = TASK_SOURCES.exec(raw);
      if (declared !== null) currentTask.sources = readAliases(declared[1] ?? "");
    } else if (raw.trim().length === 0) {
      currentTask = null;
    }
  }

  return { execution_surface: surface, phases };
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
      message: "el plan debe declarar '> Límite de ejecución: checkout' antes de poder ejecutarse",
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
      !LOCAL_PROOF.test(clause.text)
    ) {
      failures.push({
        code: "PLAN_SOURCE_LOCAL_PROOF_MISSING",
        line: clause.line,
        message: `${semanticClauseLabel(clause)} no nombra una prueba local de checkout`,
      });
    }
  }
  return failures;
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

  const add = (kind: SemanticClauseKind, line: number, value: string): SemanticClause => {
    const clause = { kind, line, text: value.trim() };
    clauses.push(clause);
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
        inHandoff = HANDOFF_HEADING.test(folded);
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
    // A wrapped task/validation stays one semantic clause.  We only append
    // Markdown's indented continuation, never arbitrary phase prose.
    if (active !== null && /^\s{2,}\S/.test(raw)) {
      active.text = `${active.text} ${trimmed}`;
    } else if (trimmed.length === 0) {
      active = null;
    }
  }
  return clauses;
}

function remoteSurfaceOf(text: string): string | null {
  const locator = REMOTE_LOCATOR.exec(text)?.[0];
  if (locator !== undefined) return locator;
  return REMOTE_CONTEXT_DISCRIMINANT.test(text) ? "RemoteContextSnapshot" : null;
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
      message: `la prueba declara la fuente '${proof.source}', que no pertenece al checkout adquirido`,
    };
  }
  if (current.digest !== proof.checkout_digest) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_STALE",
      message: `el checkout de '${proof.source}' cambió desde que se capturó la prueba`,
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
  return value.trim().toLowerCase() === CHECKOUT_EXECUTION_SURFACE
    ? CHECKOUT_EXECUTION_SURFACE
    : null;
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
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
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
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
      message: "una prueba command debe declarar una invocación command",
    };
  }
  if (
    proof.invocation.program.trim().length === 0 ||
    !Array.isArray(proof.invocation.args) ||
    !proof.invocation.args.every((arg) => typeof arg === "string")
  ) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
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
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
      message: "una prueba inspection debe declarar una invocación inspection",
    };
  }
  if (
    typeof proof.invocation.artifact !== "string" ||
    proof.invocation.artifact.trim().length === 0
  ) {
    return {
      code: "WORKLINE_CHECKOUT_PROOF_INVALID",
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
