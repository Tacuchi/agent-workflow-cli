import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { guardUnchanged, textDigest } from "../doc-flow/doc-digest.js";
import { withPlanState } from "../doc-flow/doc-flow-service.js";
import { scanMarkdown } from "../markdown.js";
import { BATCH_EVIDENCE_HEADING, BATCH_EVIDENCE_MAX_LINES } from "../parsers/batch-evidence.js";
import { parseExecutionBatches } from "../parsers/execution-batches.js";
import { parsePhases } from "../parsers/phases.js";
import { parsePlanStatus } from "../parsers/plan-status.js";
import { HUB_MIGRATE_COMMAND } from "../plan-status-contract.js";

/** One validation the batch ran: only its real output credits it (AC-04). */
export interface BatchValidation {
  command: string;
  passed: boolean;
  /** The command's real output, or its summary line; never a claim about it. */
  output: string;
}

export interface BatchEvidenceInput {
  validated: string;
  failed?: string;
  pending?: string;
  external?: string;
}

export interface PlanRunFailure {
  code: string;
  message: string;
  action: string;
}

export type PlanRunResult<T> = { ok: true; value: T } | { ok: false; failure: PlanRunFailure };

export interface BatchClosed {
  plan: string;
  batch: string;
  phases: number[];
  state: "in-progress";
  next_step: string;
  digest: string;
}

/**
 * Closes one batch in the plan itself (spec 066, ID01-ID02, D03-D06): credited
 * only by its validations' output, it flips the batch's boxes, marks its phases
 * `validada`, leaves the plan `in-progress` with its rewritten `> Próximo paso:`
 * and writes at most five evidence lines with the commit hash of each source.
 * The plan must still be the one this instance read.
 */
export async function closeBatchInPlan(
  fs: FileSystemPort,
  root: string,
  input: {
    plan: string;
    read_digest: string;
    batch: string;
    validations: readonly BatchValidation[];
    evidence: BatchEvidenceInput;
    /** Commit hash per source alias, as the commit returned it. */
    commits: Readonly<Record<string, string>>;
  },
): Promise<PlanRunResult<BatchClosed>> {
  const absolute = join(root, input.plan);
  const changed = await guardUnchanged(fs, absolute, input.plan, input.read_digest);
  if (changed !== null) return { ok: false, failure: changed };
  const credited = creditOf(input.validations);
  if (credited !== null) return { ok: false, failure: credited };
  const text = await fs.readText(absolute);
  const status = parsePlanStatus(text);
  if (status.unmigrated !== null) {
    return refuse(
      "HUB_MIGRATION_REQUIRED",
      "el plan usa el estado del modelo de sesiones",
      `migrá el hub con '${HUB_MIGRATE_COMMAND}'`,
    );
  }
  if (status.declared !== "ready" && status.declared !== "in-progress") {
    return refuse(
      "PLAN_RUN_STATE_INVALID",
      `el plan está ${status.declared}: sólo se ejecuta un plan ready o in-progress`,
      "refinalo hasta ready con /w:plan-refine",
    );
  }
  const batches = parseExecutionBatches(text);
  const row = batches.rows.find((entry) => entry.id === input.batch);
  if (row === undefined) {
    return refuse(
      "PLAN_RUN_BATCH_UNKNOWN",
      `el plan no declara el lote ${input.batch}`,
      "usá un lote de '## Execution batches'",
    );
  }
  const phases = parsePhases(text).items.filter((phase) => row.phases.includes(phase.n));
  if (phases.some((phase) => phase.state === "validada")) {
    return refuse(
      "PLAN_RUN_BATCH_CLOSED",
      `el lote ${input.batch} ya está validado`,
      "seguí con el próximo lote pendiente",
    );
  }
  const group = evidenceGroup(input.batch, input.commits, input.evidence);
  if (group.length > BATCH_EVIDENCE_MAX_LINES) {
    return refuse(
      "PLAN_BATCH_EVIDENCE_TOO_LONG",
      "la evidencia del lote pasa de cinco líneas",
      "resumí cada línea sin pegar logs",
    );
  }
  const marked = markPhases(text, new Set(row.phases));
  const next = nextStepOf(marked);
  let written = withPlanState(marked, "in-progress");
  written = withNextStep(written, next);
  written = withEvidence(written, group);
  await fs.writeText(absolute, written);
  return {
    ok: true,
    value: {
      plan: input.plan,
      batch: input.batch,
      phases: row.phases,
      state: "in-progress",
      next_step: next,
      digest: textDigest(written),
    },
  };
}

/**
 * Closes the plan once every phase is `validada` and the final validation's
 * output is green: `> Estado: done`, the next step removed, `> Cierre:` dated.
 */
export async function finishPlan(
  fs: FileSystemPort,
  root: string,
  input: {
    plan: string;
    read_digest: string;
    validations: readonly BatchValidation[];
    date: string;
  },
): Promise<PlanRunResult<{ plan: string; state: "done"; digest: string }>> {
  const absolute = join(root, input.plan);
  const changed = await guardUnchanged(fs, absolute, input.plan, input.read_digest);
  if (changed !== null) return { ok: false, failure: changed };
  const credited = creditOf(input.validations);
  if (credited !== null) return { ok: false, failure: credited };
  const text = await fs.readText(absolute);
  if (parsePlanStatus(text).declared !== "in-progress") {
    return refuse(
      "PLAN_RUN_STATE_INVALID",
      "sólo un plan in-progress se cierra",
      "ejecutá sus lotes primero",
    );
  }
  const pending = parsePhases(text).items.filter((phase) => phase.state !== "validada");
  if (pending.length > 0) {
    return refuse(
      "PLAN_RUN_PHASES_PENDING",
      `quedan fases sin validar: ${pending.map((phase) => `F${phase.n}`).join(", ")}`,
      "cerrá sus lotes antes de la validación final",
    );
  }
  const written = withClosure(withNextStep(withPlanState(text, "done"), null), input.date);
  await fs.writeText(absolute, written);
  return { ok: true, value: { plan: input.plan, state: "done", digest: textDigest(written) } };
}

function creditOf(validations: readonly BatchValidation[]): PlanRunFailure | null {
  if (validations.length === 0) {
    return {
      code: "PLAN_RUN_VALIDATION_MISSING",
      message: "no llegó la salida de ninguna validación",
      action: "corré las validaciones del lote y mandá su salida real",
    };
  }
  const silent = validations.find((entry) => entry.output.trim() === "");
  if (silent !== undefined) {
    return {
      code: "PLAN_RUN_VALIDATION_MISSING",
      message: `'${silent.command}' no trae su salida`,
      action: "mandá la salida real del comando, no una afirmación",
    };
  }
  const failed = validations.find((entry) => !entry.passed);
  if (failed !== undefined) {
    return {
      code: "PLAN_RUN_VALIDATION_FAILED",
      message: `'${failed.command}' falló: el lote no se acredita`,
      action: "arreglá la causa y volvé a correr la validación",
    };
  }
  return null;
}

function evidenceGroup(
  batch: string,
  commits: Readonly<Record<string, string>>,
  evidence: BatchEvidenceInput,
): string[] {
  const hashes = Object.entries(commits).map(([alias, hash]) => `${alias} ${hash.slice(0, 12)}`);
  const lines = [`- ${batch} · ${hashes.length > 0 ? hashes.join(" · ") : "sin commit"}`];
  const entries: [string, string | undefined][] = [
    ["Validado", evidence.validated],
    ["Fallido", evidence.failed],
    ["Pendiente", evidence.pending],
    ["Externo sin comprobar", evidence.external],
  ];
  for (const [label, value] of entries) {
    const text = value?.replace(/\s+/g, " ").trim();
    if (text) lines.push(`  - ${label}: ${text}`);
  }
  return lines;
}

/** Flips every box of the given phases and marks them `validada`. */
function markPhases(text: string, phases: ReadonlySet<number>): string {
  const { lines, fenced, headings } = scanMarkdown(text);
  const owner = phaseOfLines(lines.length, headings);
  return lines
    .map((line, index) => {
      const phase = owner[index];
      if (fenced[index] || phase === null || phase === undefined || !phases.has(phase)) return line;
      if (/^>\s*Estado\s*:/.test(line)) return "> Estado: validada";
      return line.replace(/^(\s*[-*]\s*)\[ \]/, "$1[x]");
    })
    .join("\n");
}

/** The `### Fn` phase each line belongs to; heading lines themselves belong to none. */
function phaseOfLines(
  count: number,
  headings: readonly { line: number; level: number; title: string }[],
): (number | null)[] {
  const owner: (number | null)[] = new Array(count).fill(null);
  const ordered = [...headings].sort((a, b) => a.line - b.line);
  for (const [index, heading] of ordered.entries()) {
    const match = heading.level === 3 ? /^F(\d+)\b/.exec(heading.title) : null;
    if (!match?.[1]) continue;
    const end = ordered.slice(index + 1).find((next) => next.level <= 3)?.line ?? count;
    for (let line = heading.line + 1; line < end; line += 1) owner[line] = Number(match[1]);
  }
  return owner;
}

/** The first open task left, as `Tn.m — <text>`, or the final validation. */
function nextStepOf(text: string): string {
  const { lines, fenced, headings } = scanMarkdown(text);
  const tasks = headings.find(
    (heading) => heading.level === 2 && /^tasks$/i.test(heading.title.trim()),
  );
  const end =
    headings.find(
      (heading) => heading.level === 2 && tasks !== undefined && heading.line > tasks.line,
    )?.line ?? lines.length;
  for (let index = (tasks?.line ?? 0) + 1; index < end; index += 1) {
    if (fenced[index]) continue;
    const match = /^\s*[-*]\s*\[ \]\s+(.+)$/.exec(lines[index] ?? "");
    if (match?.[1]) return match[1].replace(/\s*_\([^)]*\)_\s*$/, "").trim();
  }
  return "validación final y cierre del plan";
}

function withNextStep(text: string, next: string | null): string {
  const { lines } = scanMarkdown(text);
  const out = lines.filter((line) => !/^>\s*Pr[oó]ximo paso\s*:/.test(line));
  if (next === null) return out.join("\n");
  const at = out.findIndex((line) => /^>\s*Estado\s*:/.test(line));
  out.splice(at + 1, 0, `> Próximo paso: ${next}`);
  return out.join("\n");
}

function withClosure(text: string, date: string): string {
  const { lines } = scanMarkdown(text);
  const out = lines.filter((line) => !/^>\s*Cierre\s*:/.test(line));
  const at = out.findIndex((line) => /^>\s*Estado\s*:/.test(line));
  out.splice(at + 1, 0, `> Cierre: ${date}`);
  return out.join("\n");
}

/** Appends the batch's group to `## Evidencia de lotes`, creating the section at the end. */
function withEvidence(text: string, group: readonly string[]): string {
  const { lines, headings } = scanMarkdown(text);
  const heading = headings.find(
    (entry) => entry.level === 2 && entry.title.trim() === BATCH_EVIDENCE_HEADING,
  );
  const out = [...lines];
  if (heading === undefined) {
    while (out.length > 0 && (out.at(-1) ?? "").trim() === "") out.pop();
    return [...out, "", `## ${BATCH_EVIDENCE_HEADING}`, "", ...group, ""].join("\n");
  }
  const next = headings.find((entry) => entry.level <= 2 && entry.line > heading.line);
  let at = next?.line ?? out.length;
  while (at > heading.line + 1 && (out[at - 1] ?? "").trim() === "") at -= 1;
  out.splice(at, 0, ...group);
  return out.join("\n");
}

function refuse<T>(code: string, message: string, action: string): PlanRunResult<T> {
  return { ok: false, failure: { code, message, action } };
}
