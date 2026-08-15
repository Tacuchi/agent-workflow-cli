/**
 * The projection of the plan a caller gets to see — and the same one, in prose,
 * that a person reads before approving it.
 *
 * The rewritten bytes of each hub file stay OUT of it: the payload is what the
 * migration will do, not the file it will produce, and a JSON consumer that had
 * to diff two whole documents to learn "the markers get renamed" would be
 * reading an implementation detail as if it were the answer.
 */

import { relpath } from "../paths.js";
import type { WorkspaceMigrationApplied } from "./apply.js";
import { type MigrationConflict, type WorkspaceMigrationPlan, pendingChanges } from "./plan.js";

export interface PreviewMarker {
  file: string;
  from: string;
  to: string;
  drops_duplicate: boolean;
}

export interface PreviewSentinel {
  folder: string;
  /** The day the record says it closed. */
  date: string;
}

export interface PreviewRow {
  folder: string;
  state: string;
  /** `null` = the session declared no date; the row is born with today's. */
  date: string | null;
}

export interface WorkspaceMigrationPreview {
  workspace: string;
  markers: PreviewMarker[];
  sentinels: PreviewSentinel[];
  rows: PreviewRow[];
  conflicts: MigrationConflict[];
  legacy: string[];
  next_correlative: string;
  /** How many writes the migration holds. Zero = the workspace is already current. */
  pending: number;
}

export function migrationPreview(plan: WorkspaceMigrationPlan): WorkspaceMigrationPreview {
  return {
    workspace: plan.workspace,
    markers: plan.markers.map((hub) => ({
      file: relpath(hub.path, plan.workspace),
      from: hub.from,
      to: hub.to,
      drops_duplicate: hub.drops_duplicate,
    })),
    sentinels: plan.sentinels.map((seed) => ({ folder: seed.folder, date: seed.date })),
    rows: plan.rows.map((seed) => ({
      folder: seed.folder,
      state: seed.state,
      date: seed.date,
    })),
    conflicts: plan.conflicts.map((conflict) => ({
      ...conflict,
      subject: relpath(conflict.subject, plan.workspace),
    })),
    legacy: plan.legacy,
    next_correlative: plan.next_correlative,
    pending: pendingChanges(plan),
  };
}

export function renderMigrationPreview(preview: WorkspaceMigrationPreview): string {
  const lines = [
    `Workspace: ${preview.workspace}`,
    `Serie legacy: ${countOf(preview.legacy.length, "carpeta", "carpetas")} · próximo correlativo: ${preview.next_correlative}`,
  ];

  if (preview.markers.length > 0) {
    lines.push("", "Marcadores del bloque de proyecto:");
    for (const marker of preview.markers) {
      const duplicate = marker.drops_duplicate
        ? " (y elimina el bloque vacío que el CLI había agregado aparte)"
        : "";
      lines.push(`  ${marker.file} — ${marker.from} → ${marker.to}${duplicate}`);
    }
  }

  if (preview.sentinels.length > 0) {
    lines.push("", "Centinelas de cierre a sembrar, con la fecha del histórico:");
    for (const sentinel of preview.sentinels) {
      lines.push(`  ${sentinel.folder} — cerrada el ${sentinel.date || "(fila sin fecha)"}`);
    }
  }

  if (preview.rows.length > 0) {
    lines.push("", "Filas a reservar en el histórico, para que el número no se reasigne:");
    for (const row of preview.rows) {
      lines.push(`  ${row.folder} — ${row.state}, ${dateNote(row.date)}`);
    }
  }

  if (preview.pending === 0) {
    lines.push("", "Nada que migrar: el workspace ya opera con el modelo actual.");
  }
  lines.push(...conflictLines(preview.conflicts));
  if (preview.pending > 0) {
    lines.push("", "Para aplicarlo:", "  aw workspace-migrate --apply");
  }
  return lines.join("\n");
}

export function renderMigrationApplied(applied: WorkspaceMigrationApplied): string {
  const lines = [`Workspace migrado: ${applied.workspace}`];
  if (applied.markers_renamed.length > 0) {
    const files = applied.markers_renamed.map((path) => relpath(path, applied.workspace));
    lines.push(`Marcadores renombrados: ${files.join(", ")}`);
  }
  if (applied.duplicates_dropped.length > 0) {
    const files = applied.duplicates_dropped.map((path) => relpath(path, applied.workspace));
    lines.push(`Bloques duplicados eliminados: ${files.join(", ")}`);
  }
  if (applied.sentinels_seeded.length > 0) {
    lines.push(`Centinelas sembrados: ${applied.sentinels_seeded.join(", ")}`);
  }
  if (applied.rows_seeded.length > 0) {
    lines.push(`Filas reservadas: ${applied.rows_seeded.join(", ")}`);
  }
  if (applied.rows_dated_today.length > 0) {
    lines.push(
      `Sin fecha declarada — su fila nació con la de hoy: ${applied.rows_dated_today.join(", ")}`,
    );
  }
  if (lines.length === 1) lines.push("No había nada que migrar.");
  lines.push(`Próximo correlativo: ${applied.next_correlative}`);
  lines.push(...conflictLines(applied.conflicts));
  return lines.join("\n");
}

function conflictLines(conflicts: readonly MigrationConflict[]): string[] {
  if (conflicts.length === 0) return [];
  const lines = ["", "Sin tocar, porque el histórico y el disco no dicen lo mismo:"];
  for (const conflict of conflicts) {
    lines.push(`  ${conflict.subject} [${conflict.reason}] — ${conflict.detail}`);
  }
  return lines;
}

function dateNote(date: string | null): string {
  return date === null ? "sin fecha declarada: la fila nace con la de hoy" : date;
}

function countOf(total: number, singular: string, plural: string): string {
  return `${total} ${total === 1 ? singular : plural}`;
}
