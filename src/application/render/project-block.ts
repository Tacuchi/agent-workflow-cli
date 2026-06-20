import type {
  ParsedProjectBlock,
  ProjectBlockMarkers,
  ProjectFuente,
  ProjectStack,
} from "../parsers/project-block.js";
import { LEGACY_QTC_MARKERS } from "../parsers/project-block.js";

export interface RenderProjectBlockInput {
  proyecto: string;
  fuentes: ProjectFuente[];
  stack: ProjectStack;
  lastActivity?: string;
  workingBranches?: Record<string, string>;
  /** Path used in the "Histórico:" line. Default `.workflow/HISTORY.md`. */
  historicoPath?: string;
  /** Markers used to wrap the block. Default = legacy QTC markers (kept for back-compat parsing). */
  markers?: ProjectBlockMarkers;
}

export function renderProjectBlock(input: RenderProjectBlockInput): string {
  const markers = input.markers ?? LEGACY_QTC_MARKERS;
  const historicoPath = input.historicoPath ?? ".workflow/HISTORY.md";
  const last = input.lastActivity ?? formatNowMinute();
  const proyectoSection =
    input.proyecto.trim().length > 0
      ? input.proyecto.trim()
      : "_Describe el proyecto aquí: qué es y por qué existe._";

  const statusLines: string[] = [];
  const wb = formatWorkingBranches(input.workingBranches);
  if (wb !== null) statusLines.push(wb);
  statusLines.push(`- Última actividad: ${last}`);
  statusLines.push(`- Histórico: \`${historicoPath}\``);

  return [
    markers.start,
    "## Proyecto",
    "",
    proyectoSection,
    "",
    "## Fuentes",
    "",
    formatFuentesTable(input.fuentes),
    "",
    "## Stack",
    "",
    formatStackList(input.stack),
    "",
    "## Status",
    "",
    statusLines.join("\n"),
    markers.end,
  ].join("\n");
}

export function blockFromParsed(
  parsed: ParsedProjectBlock,
  overrides: Partial<RenderProjectBlockInput> = {},
): string {
  const input: RenderProjectBlockInput = {
    proyecto: overrides.proyecto ?? parsed.proyecto,
    fuentes: overrides.fuentes ?? parsed.fuentes,
    stack: overrides.stack ?? parsed.stack,
    workingBranches: overrides.workingBranches ?? parsed.working_branches,
  };
  if (overrides.lastActivity !== undefined) {
    input.lastActivity = overrides.lastActivity;
  } else if (parsed.last_activity !== null) {
    input.lastActivity = parsed.last_activity;
  }
  if (overrides.markers !== undefined) input.markers = overrides.markers;
  if (overrides.historicoPath !== undefined) input.historicoPath = overrides.historicoPath;
  return renderProjectBlock(input);
}

function formatFuentesTable(fuentes: ProjectFuente[]): string {
  if (fuentes.length === 0) {
    return "_Sin fuentes declaradas. Edita manualmente o usa `project-md-upsert --init`._";
  }
  const lines = ["| Alias | Path | Rama principal |", "|---|---|---|"];
  for (const f of fuentes) {
    const alias = f.alias;
    const path = f.path;
    const main = f.main_branch || "certificacion";
    lines.push(`| ${alias} | ${path} | ${main} |`);
  }
  return lines.join("\n");
}

function formatStackList(stack: ProjectStack): string {
  // Mirror Python: si stack es null/undefined → "Edita manualmente si aplica."
  // Si stack es dict con keys (incluso todos undefined) → "_Stack sin detectar._"
  // En el flujo cmd_project_md_upsert, stack siempre llega con shape (no null), así
  // que la primera rama es inalcanzable; nuestro detectStackDict simula el mismo
  // comportamiento devolviendo el shape vacío `{}` SOLO cuando no hay archivos a
  // detectar — en ese caso preservamos el mensaje corto que Python emite ahí.
  const lines: string[] = [];
  if (stack.language) lines.push(`- Lenguaje: ${stack.language}`);
  if (stack.framework) lines.push(`- Framework: ${stack.framework}`);
  if (stack.db) lines.push(`- BD: ${stack.db}`);
  if (stack.build) lines.push(`- Build: ${stack.build}`);
  if (lines.length === 0) {
    return "_Stack sin detectar._";
  }
  return lines.join("\n");
}

function formatWorkingBranches(branches: Record<string, string> | undefined): string | null {
  if (!branches || Object.keys(branches).length === 0) return null;
  const lines = ["- Ramas de trabajo actuales:"];
  for (const [alias, branch] of Object.entries(branches)) {
    lines.push(`  - ${alias}: ${branch}`);
  }
  return lines.join("\n");
}

function formatNowMinute(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
