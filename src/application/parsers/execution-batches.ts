import type { PlanExecBatchRange } from "../../domain/flow/run-state.js";
import { scanMarkdown } from "../markdown.js";
import { parsePhases } from "./phases.js";

export interface ParsedExecutionBatches {
  status: "absent" | "valid" | "invalid";
  /** Same trimmed section bytes amend has always protected, including malformed prose. */
  raw: string;
  rows: PlanExecBatchRange[];
  reason: string | null;
}

/** The declared partition, not a best-effort subset of recognizable rows. */
export function parseExecutionBatches(text: string): ParsedExecutionBatches {
  const { lines, headings, fenced } = scanMarkdown(text);
  const sections = headings.filter(
    (entry) => entry.level === 2 && /execution batches|lotes de ejecuci[oó]n/i.test(entry.title),
  );
  const heading = sections[0];
  if (heading === undefined) return { status: "absent", raw: "", rows: [], reason: null };
  const next = headings.find((entry) => entry.level <= 2 && entry.line > heading.line);
  const end = next?.line ?? lines.length;
  const raw = lines
    .slice(heading.line + 1, end)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  const invalid = (reason: string): ParsedExecutionBatches => ({
    status: "invalid",
    raw,
    rows: [],
    reason,
  });
  if (sections.length !== 1) return invalid("hay más de una sección Execution batches");
  const phases = parsePhases(text).items.map((phase) => phase.n);
  const rows: PlanExecBatchRange[] = [];
  for (let line = heading.line + 1; line < end; line += 1) {
    const value = lines[line]?.trim() ?? "";
    if (!value) continue;
    const row = fenced[line] ? null : parseRow(value, rows.length + 1, phases);
    if (row === null) return invalid(`fila de lote ilegible o fuera de orden: ${value}`);
    rows.push(row);
  }
  const declared = rows.flatMap((row) => row.phases);
  if (
    rows.length === 0 ||
    new Set(phases).size !== phases.length ||
    !phases.every((phase) => Number.isSafeInteger(phase) && phase > 0) ||
    declared.length !== phases.length ||
    declared.some((phase, index) => phase !== phases[index])
  ) {
    return invalid(
      "los lotes no forman una partición completa, sin repeticiones y en orden de las fases",
    );
  }
  return { status: "valid", raw, rows, reason: null };
}

function parseRow(value: string, ordinal: number, phases: number[]): PlanExecBatchRange | null {
  const match = /^-\s+(B\d+)\s*·\s*(continuous|isolated)\s*·\s*F(\d+)(?:\s*[-–—]\s*F(\d+))?$/.exec(
    value,
  );
  if (match === null) return null;
  const first = Number(match[3]);
  const last = Number(match[4] ?? match[3]);
  const start = phases.indexOf(first);
  const stop = phases.indexOf(last);
  const range = phases.slice(start, stop + 1);
  if (
    start < 0 ||
    stop < start ||
    range.length !== last - first + 1 ||
    range.some((phase, index) => phase !== first + index) ||
    match[1] !== `B${ordinal}` ||
    (match[2] === "isolated" && range.length !== 1)
  )
    return null;
  return { id: match[1], mode: match[2] as PlanExecBatchRange["mode"], phases: range };
}
