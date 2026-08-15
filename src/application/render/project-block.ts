import { localMinuteIso } from "../dates.js";
import type {
  DefaultBranches,
  ParsedProjectBlock,
  PreservedLine,
  PreservedSlot,
  ProjectBlockMarkers,
  ProjectFuente,
  ProjectStack,
} from "../parsers/project-block.js";
import {
  BLOCK_PLACEHOLDER_FUENTES,
  BLOCK_PLACEHOLDER_PROYECTO,
  BLOCK_PLACEHOLDER_STACK,
  LEGACY_QTC_MARKERS,
} from "../parsers/project-block.js";

export interface RenderProjectBlockInput {
  proyecto: string;
  fuentes: ProjectFuente[];
  stack: ProjectStack;
  lastActivity?: string;
  defaultBranches?: DefaultBranches;
  workingBranches?: Record<string, string>;
  qaBranches?: Record<string, string>;
  /** Foreign lines carried over from the block being rewritten, put back in place. */
  preservedLines?: PreservedLine[];
  /** Path used in the "Histórico:" line. Default `.workflow/HISTORY.md`. */
  historicoPath?: string;
  /** Markers used to wrap the block. Default = legacy QTC markers (kept for back-compat parsing). */
  markers?: ProjectBlockMarkers;
}

export function renderProjectBlock(input: RenderProjectBlockInput): string {
  const markers = input.markers ?? LEGACY_QTC_MARKERS;
  const historicoPath = input.historicoPath ?? ".workflow/HISTORY.md";
  const last = input.lastActivity ?? localMinuteIso();
  const kept = input.preservedLines;
  const proyectoSection =
    input.proyecto.trim().length > 0 ? input.proyecto.trim() : BLOCK_PLACEHOLDER_PROYECTO;

  const statusLines: string[] = [];
  // Each slot re-emits the foreign lines that followed the entry it names, so a
  // hand-written note lands back exactly where its author put it.
  statusLines.push(...slotLines(kept, "status:start"));
  // Defaults go FIRST: an older CLI's parser ignores an unknown `- ` line only
  // while no branch section is open — after one, it would swallow them. This
  // parser no longer needs the ordering, but blocks are read by both.
  const defaults = formatDefaultBranches(input.defaultBranches);
  if (defaults !== null) statusLines.push(defaults);
  statusLines.push(...slotLines(kept, "status:defaults"));
  const wb = formatWorkingBranches(input.workingBranches);
  if (wb !== null) statusLines.push(wb);
  statusLines.push(...slotLines(kept, "status:working"));
  const qa = formatQaBranches(input.qaBranches);
  if (qa !== null) statusLines.push(qa);
  statusLines.push(...slotLines(kept, "status:qa"));
  statusLines.push(`- Última actividad: ${last}`);
  statusLines.push(...slotLines(kept, "status:activity"));
  statusLines.push(`- Histórico: \`${historicoPath}\``);
  statusLines.push(...slotLines(kept, "status:historico"));

  return [
    markers.start,
    "## Proyecto",
    "",
    proyectoSection,
    "",
    "## Fuentes",
    "",
    [formatFuentesTable(input.fuentes), ...slotLines(kept, "fuentes")].join("\n"),
    "",
    "## Stack",
    "",
    [formatStackList(input.stack), ...slotLines(kept, "stack")].join("\n"),
    "",
    "## Status",
    "",
    statusLines.join("\n"),
    // Sections the block does not own, heading and body, after everything it
    // does. Their place relative to generated sections cannot be honoured by a
    // rewrite, but losing them can be avoided — and that is the whole point.
    ...trailingSection(kept),
    markers.end,
  ].join("\n");
}

/** The foreign sections, with the blank line that separates them from `## Status`. */
function trailingSection(preserved: PreservedLine[] | undefined): string[] {
  const lines = slotLines(preserved, "trailing");
  return lines.length === 0 ? [] : ["", lines.join("\n")];
}

function slotLines(preserved: PreservedLine[] | undefined, slot: PreservedSlot): string[] {
  if (preserved === undefined) return [];
  return preserved.filter((line) => line.slot === slot).map((line) => line.text);
}

export function blockFromParsed(
  parsed: ParsedProjectBlock,
  overrides: Partial<RenderProjectBlockInput> = {},
): string {
  const input: RenderProjectBlockInput = {
    proyecto: overrides.proyecto ?? parsed.proyecto,
    fuentes: overrides.fuentes ?? parsed.fuentes,
    stack: overrides.stack ?? parsed.stack,
    defaultBranches: overrides.defaultBranches ?? parsed.default_branches,
    workingBranches: overrides.workingBranches ?? parsed.working_branches,
    qaBranches: overrides.qaBranches ?? parsed.qa_branches,
  };
  const preserved = overrides.preservedLines ?? parsed.preserved_lines;
  if (preserved !== undefined) input.preservedLines = preserved;
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
    return BLOCK_PLACEHOLDER_FUENTES;
  }
  const lines = ["| Alias | Path | Rama principal |", "|---|---|---|"];
  for (const f of fuentes) {
    const alias = f.alias;
    const path = f.path;
    // Undeclared base branch → empty cell (round-trips back to null; the
    // workspace default `principal` is what resolves it, not a literal here).
    const main = f.main_branch ?? "";
    lines.push(`| ${alias} | ${path} | ${main} |`);
  }
  return lines.join("\n");
}

function formatStackList(stack: ProjectStack): string {
  // An empty shape means "nothing detected" — never "no stack section": the
  // upsert flow always hands a shape, so the placeholder is the only fallback.
  const lines: string[] = [];
  if (stack.language) lines.push(`- Lenguaje: ${stack.language}`);
  if (stack.framework) lines.push(`- Framework: ${stack.framework}`);
  if (stack.db) lines.push(`- BD: ${stack.db}`);
  if (stack.build) lines.push(`- Build: ${stack.build}`);
  if (lines.length === 0) {
    return BLOCK_PLACEHOLDER_STACK;
  }
  return lines.join("\n");
}

const DEFAULT_BRANCH_ROLES = ["principal", "desarrollo", "qa"] as const;

function formatDefaultBranches(defaults: DefaultBranches | undefined): string | null {
  if (!defaults) return null;
  const lines: string[] = [];
  for (const role of DEFAULT_BRANCH_ROLES) {
    const branch = defaults[role];
    if (branch) lines.push(`  - ${role}: ${branch}`);
  }
  if (lines.length === 0) return null;
  return ["- Ramas por defecto:", ...lines].join("\n");
}

function formatWorkingBranches(branches: Record<string, string> | undefined): string | null {
  if (!branches || Object.keys(branches).length === 0) return null;
  const lines = ["- Ramas de trabajo actuales:"];
  for (const [alias, branch] of Object.entries(branches)) {
    lines.push(`  - ${alias}: ${branch}`);
  }
  return lines.join("\n");
}

function formatQaBranches(branches: Record<string, string> | undefined): string | null {
  if (!branches || Object.keys(branches).length === 0) return null;
  const lines = ["- Ramas QA actuales:"];
  for (const [alias, branch] of Object.entries(branches)) {
    lines.push(`  - ${alias}: ${branch}`);
  }
  return lines.join("\n");
}
