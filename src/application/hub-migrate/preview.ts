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
import { aliasLocations } from "./aliases.js";
import type { HubMigrationApplied } from "./apply.js";
import { type HubMigrationPlan, type MigrationConflict, pendingChanges } from "./plan.js";

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
  /** `—` = the legacy session never declared a date. */
  date: string;
}

export interface PreviewBlockFile {
  /** `retire`: CLAUDE.md goes away; `strip`: it keeps the person's content without the block. */
  claude: "retire" | "strip";
  /** Whether AGENTS.md is rewritten with the surviving block. */
  agents_changes: boolean;
  source: string;
  adds_import: boolean;
}

export interface HubMigrationPreview {
  hub: string;
  markers: PreviewMarker[];
  /** `file:line` of every source declaration that goes from `workspace` to `hub`. */
  aliases: string[];
  /** Open runs whose scope goes from `workspace` to `hub`. */
  runs: string[];
  sentinels: PreviewSentinel[];
  rows: PreviewRow[];
  block_file: PreviewBlockFile | null;
  /** Lines only one mirror declares, when the pair diverges and waits for `--keep`. */
  block_divergence: { only_claude: string[]; only_agents: string[] } | null;
  conflicts: MigrationConflict[];
  legacy: string[];
  next_correlative: string;
  /** How many writes the migration holds. Zero = the hub is already current. */
  pending: number;
}

export function migrationPreview(plan: HubMigrationPlan): HubMigrationPreview {
  return {
    hub: plan.hub,
    markers: plan.markers.map((hub) => ({
      file: relpath(hub.path, plan.hub),
      from: hub.from,
      to: hub.to,
      drops_duplicate: hub.drops_duplicate,
    })),
    aliases: aliasLocations(plan.hub, plan.aliases),
    runs: plan.runs.map((run) => run.session),
    sentinels: plan.sentinels.map((seed) => ({ folder: seed.folder, date: seed.date })),
    rows: plan.rows.map((seed) => ({
      folder: seed.folder,
      state: seed.state,
      date: seed.date,
    })),
    block_file:
      plan.block_file === null
        ? null
        : {
            claude: plan.block_file.legacy.action,
            agents_changes: plan.block_file.agents !== null,
            source: plan.block_file.source,
            adds_import: plan.block_file.adds_import,
          },
    block_divergence:
      plan.block_divergence === null
        ? null
        : {
            only_claude: plan.block_divergence.only_claude,
            only_agents: plan.block_divergence.only_agents,
          },
    conflicts: plan.conflicts.map((conflict) => ({
      ...conflict,
      subject: relpath(conflict.subject, plan.hub),
    })),
    legacy: plan.legacy,
    next_correlative: plan.next_correlative,
    pending: pendingChanges(plan),
  };
}

export function renderMigrationPreview(preview: HubMigrationPreview): string {
  const lines = [
    `Hub: ${preview.hub}`,
    `Serie legacy: ${countOf(preview.legacy.length, "carpeta", "carpetas")} · próximo correlativo: ${preview.next_correlative}`,
    ...section(
      "Marcadores del bloque del hub:",
      preview.markers.map((marker) => {
        const duplicate = marker.drops_duplicate
          ? " (y elimina el bloque vacío que el CLI había agregado aparte)"
          : "";
        return `${marker.file} — ${marker.from} → ${marker.to}${duplicate}`;
      }),
    ),
    ...section("Alias reservado workspace → hub en los planes abiertos:", preview.aliases),
    ...section("Alias reservado workspace → hub en las corridas abiertas:", preview.runs),
    ...section(
      "Centinelas de cierre a sembrar, con la fecha del histórico:",
      preview.sentinels.map(
        (sentinel) => `${sentinel.folder} — cerrada el ${sentinel.date || "(fila sin fecha)"}`,
      ),
    ),
    ...section(
      "Filas a reservar en el histórico, para que el número no se reasigne:",
      preview.rows.map((row) => `${row.folder} — ${row.state}, ${dateNote(row.date)}`),
    ),
    ...section(
      "CLAUDE.md heredado: el bloque del hub queda solo en AGENTS.md:",
      preview.block_file === null ? [] : blockFileLines(preview.block_file),
    ),
  ];
  if (preview.pending === 0) {
    lines.push("", "Nada que migrar: el hub ya opera con el modelo actual.");
  }
  lines.push(...conflictLines(preview.conflicts));
  if (preview.pending > 0) {
    lines.push("", "Para aplicarlo:", "  aw hub-migrate --apply");
  }
  return lines.join("\n");
}

function blockFileLines(block: PreviewBlockFile): string[] {
  const claude =
    block.claude === "retire"
      ? "CLAUDE.md — se borra: solo tenía el bloque"
      : `CLAUDE.md — conserva tu contenido sin el bloque${block.adds_import ? " y suma @AGENTS.md al inicio" : ""}`;
  const agents = block.agents_changes
    ? `AGENTS.md — recibe el bloque de ${block.source}, con el formato actual`
    : "AGENTS.md — ya tiene ese bloque: no cambia";
  return [claude, agents];
}

/** A titled, indented list, or nothing when the list is empty. */
function section(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : ["", title, ...items.map((item) => `  ${item}`)];
}

export function renderMigrationApplied(applied: HubMigrationApplied): string {
  const lines = [`Hub migrado: ${applied.hub}`];
  if (applied.markers_renamed.length > 0) {
    const files = applied.markers_renamed.map((path) => relpath(path, applied.hub));
    lines.push(`Marcadores renombrados: ${files.join(", ")}`);
  }
  if (applied.duplicates_dropped.length > 0) {
    const files = applied.duplicates_dropped.map((path) => relpath(path, applied.hub));
    lines.push(`Bloques duplicados eliminados: ${files.join(", ")}`);
  }
  if (applied.aliases_rewritten.length > 0) {
    const files = applied.aliases_rewritten.map((path) => relpath(path, applied.hub));
    lines.push(`Alias hub en planes abiertos: ${files.join(", ")}`);
  }
  if (applied.runs_rewritten.length > 0) {
    lines.push(`Alias hub en corridas abiertas: ${applied.runs_rewritten.join(", ")}`);
  }
  if (applied.sentinels_seeded.length > 0) {
    lines.push(`Centinelas sembrados: ${applied.sentinels_seeded.join(", ")}`);
  }
  if (applied.rows_seeded.length > 0) {
    lines.push(`Filas reservadas: ${applied.rows_seeded.join(", ")}`);
  }
  if (applied.block_file !== null) {
    const claude = applied.block_file.claude === "retired" ? "borrado" : "sin el bloque";
    const imported = applied.block_file.adds_import ? ", con @AGENTS.md al inicio" : "";
    lines.push(
      `CLAUDE.md heredado: ${claude}${imported}; bloque en AGENTS.md (${applied.block_file.agents === "written" ? "reescrito" : "sin cambios"})`,
    );
  }
  if (applied.rows_without_date.length > 0) {
    lines.push(`Sin fecha declarada — su fila conserva —: ${applied.rows_without_date.join(", ")}`);
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

function dateNote(date: string): string {
  return date === "—" ? "sin fecha declarada: la fila conserva —" : date;
}

function countOf(total: number, singular: string, plural: string): string {
  return `${total} ${total === 1 ? singular : plural}`;
}
