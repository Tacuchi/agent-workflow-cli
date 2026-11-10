import { scanMarkdown } from "../markdown.js";

/** Heading of the bounded per-batch evidence section (spec 066, ID02). */
export const BATCH_EVIDENCE_HEADING = "Evidencia de lotes";

/** The four sub-bullet labels a batch group may carry, in canonical order. */
export const BATCH_EVIDENCE_LABELS = [
  "Validado",
  "Fallido",
  "Pendiente",
  "Externo sin comprobar",
] as const;

export type BatchEvidenceLabel = (typeof BATCH_EVIDENCE_LABELS)[number];

/** A group may hold its head row plus at most this many lines in total. */
export const BATCH_EVIDENCE_MAX_LINES = 5;

export interface BatchEvidenceGroup {
  /** `B1`, `B2`, … */
  batch: string;
  /** What follows `B1 ·` on the head row: the commit hash of each source. */
  commits: string;
  /** One-based line of the head row. */
  line: number;
  entries: { label: BatchEvidenceLabel; text: string; line: number }[];
  /** Head row plus sub-bullets, the number the cap of five is measured on. */
  lines: number;
}

export interface BatchEvidenceProblem {
  code: "PLAN_BATCH_EVIDENCE_TOO_LONG" | "PLAN_BATCH_EVIDENCE_INVALID";
  line: number;
  message: string;
}

export interface ParsedBatchEvidence {
  present: boolean;
  groups: BatchEvidenceGroup[];
  problems: BatchEvidenceProblem[];
}

const HEAD_RE = /^-\s+(B\d+)\s*·\s*(.+)$/;
const ENTRY_RE = /^\s+-\s+([^:]+):\s*(.+)$/;

/**
 * The `## Evidencia de lotes` section: one group per closed batch, a head row
 * `- B1 · <hash por fuente>` and up to four labelled sub-bullets. It lives
 * apart from `## Execution batches` so the partition parser never sees it.
 *
 * Problems are reported, never repaired: more than five lines in a group, a
 * label outside the closed vocabulary, a repeated label or a line that is
 * neither a head row nor a sub-bullet.
 */
export function parseBatchEvidence(text: string): ParsedBatchEvidence {
  const { lines, headings, fenced } = scanMarkdown(text);
  const heading = headings.find(
    (entry) => entry.level === 2 && entry.title.trim().toLowerCase() === "evidencia de lotes",
  );
  if (heading === undefined) return { present: false, groups: [], problems: [] };
  const next = headings.find((entry) => entry.level <= 2 && entry.line > heading.line);
  const end = next?.line ?? lines.length;

  const groups: BatchEvidenceGroup[] = [];
  const problems: BatchEvidenceProblem[] = [];
  for (let index = heading.line + 1; index < end; index += 1) {
    const raw = lines[index] ?? "";
    if (!raw.trim() || fenced[index]) continue;
    readEvidenceLine(raw.trimEnd(), index + 1, groups, problems);
  }
  for (const group of groups) {
    if (group.lines > BATCH_EVIDENCE_MAX_LINES) {
      problems.push({
        code: "PLAN_BATCH_EVIDENCE_TOO_LONG",
        line: group.line,
        message: `el lote ${group.batch} deja ${group.lines} líneas de evidencia; el tope es ${BATCH_EVIDENCE_MAX_LINES}`,
      });
    }
  }
  problems.sort((a, b) => a.line - b.line);
  return { present: true, groups, problems };
}

/** Folds one non-empty line of the section into its group, or reports why it cannot. */
function readEvidenceLine(
  raw: string,
  line: number,
  groups: BatchEvidenceGroup[],
  problems: BatchEvidenceProblem[],
): void {
  const head = HEAD_RE.exec(raw);
  if (head?.[1] && head[2] && !/^\s/.test(raw)) {
    groups.push({ batch: head[1], commits: head[2].trim(), line, entries: [], lines: 1 });
    return;
  }
  const group = groups.at(-1);
  if (group !== undefined) group.lines += 1;
  const entry = ENTRY_RE.exec(raw);
  if (!entry?.[1] || !entry[2] || group === undefined) {
    problems.push({
      code: "PLAN_BATCH_EVIDENCE_INVALID",
      line,
      message: "la línea no es la fila '- Bn · <hash>' de un lote ni una de sus sub-viñetas",
    });
    return;
  }
  const name = entry[1].trim();
  const label = BATCH_EVIDENCE_LABELS.find((known) => known.toLowerCase() === name.toLowerCase());
  if (label === undefined) {
    problems.push({
      code: "PLAN_BATCH_EVIDENCE_INVALID",
      line,
      message: `'${name}' no es una etiqueta de evidencia: usá ${BATCH_EVIDENCE_LABELS.join(", ")}`,
    });
    return;
  }
  if (group.entries.some((known) => known.label === label)) {
    problems.push({
      code: "PLAN_BATCH_EVIDENCE_INVALID",
      line,
      message: `el lote ${group.batch} repite la etiqueta '${label}'`,
    });
  }
  group.entries.push({ label, text: entry[2].trim(), line });
}
