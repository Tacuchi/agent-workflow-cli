export interface MarkdownHeading {
  /** `#` count — 1..6 */
  level: number;
  /** heading text, trimmed, without the leading `#`s */
  title: string;
  /** 0-based index into {@link MarkdownScan.lines} */
  line: number;
}

export interface MarkdownScan {
  /** every line of the document, unmodified — index = line number */
  lines: string[];
  /** `fenced[i]` = `lines[i]` sits inside a fenced code block (its markers included) */
  fenced: boolean[];
  /** ATX headings found OUTSIDE fenced code blocks, in document order */
  headings: MarkdownHeading[];
}

const HEADING_LINE_RE = /^(#{1,6})\s+(\S.*)$/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})/;

/**
 * Single-pass semantic scan of a Markdown document: which lines are quoted
 * inside a fenced code block, and which headings are real structure.
 *
 * One implementation governs what is semantically visible, because the project
 * writes its own contracts as Markdown examples: a `## Refinement decisions`,
 * a `### F9` or a `> Estado: validada` shown inside a fence is documentation
 * ABOUT the contract, never an instance of it. A parser that misses the
 * distinction promotes specs nobody refined and counts phases nobody planned.
 *
 * Fences follow CommonMark's closing rule (see {@link closesFence}) — the
 * alternating-marker shortcut leaked a nested example back into visibility.
 * Beyond that, this is deliberately NOT a CommonMark implementation: indented
 * code blocks, HTML blocks and setext headings are out of the contracts'
 * vocabulary and stay unhandled.
 */
export function scanMarkdown(text: string): MarkdownScan {
  const lines = text.split("\n");
  const fenced: boolean[] = new Array(lines.length).fill(false);
  const headings: MarkdownHeading[] = [];

  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    const marker = FENCE_OPEN_RE.exec(line)?.[1] ?? null;
    if (fence === null) {
      if (marker) {
        fence = marker;
        fenced[i] = true;
        continue;
      }
      const match = HEADING_LINE_RE.exec(line);
      if (match?.[1] && match[2]) {
        headings.push({ level: match[1].length, title: match[2].trim(), line: i });
      }
      continue;
    }
    fenced[i] = true;
    if (marker && closesFence(fence, marker, line)) fence = null;
  }

  return { lines, fenced, headings };
}

/** CommonMark closing fence: same character, at least as long, the bare marker alone. */
function closesFence(open: string, marker: string, line: string): boolean {
  return marker[0] === open[0] && marker.length >= open.length && line === marker;
}

export function parseMdValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*[-*]?\\s*\\*{0,2}${escaped}\\*{0,2}\\s*[:=]\\s*(.+)$`, "im");
  const match = text.match(re);
  if (!match || !match[1]) {
    return undefined;
  }
  const value = match[1].trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Body of the section opened by `heading`, up to the next heading of the same
 * or a higher level. Section boundaries come from {@link scanMarkdown}, so a
 * heading quoted inside a fence neither opens nor closes a section; the body
 * returned is the raw slice, fenced examples included.
 */
export function parseMdSection(
  text: string,
  heading: string,
  normalizeName: (s: string) => string = (s) => s.trim().toLowerCase(),
): string | undefined {
  const target = normalizeName(heading);
  const { lines, headings } = scanMarkdown(text);

  let captureFrom: number | null = null;
  let captureLevel = 0;
  for (const h of headings) {
    if (captureFrom === null) {
      if (normalizeName(h.title) === target) {
        captureFrom = h.line + 1;
        captureLevel = h.level;
      }
    } else if (h.level <= captureLevel) {
      return joinTrim(lines.slice(captureFrom, h.line));
    }
  }

  if (captureFrom !== null) {
    return joinTrim(lines.slice(captureFrom));
  }
  return undefined;
}

export function firstNonEmptyLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 0) {
      return line;
    }
  }
  return undefined;
}

function joinTrim(lines: string[]): string {
  return lines.join("\n").trim();
}

/**
 * Bilingual / accent-tolerant keyword groups. Each inner array enumerates every
 * accepted form of the same logical keyword (used as `key` in {@link parseMdValue}
 * or `heading` in {@link parseMdSection}). The first entry of each group is the
 * canonical form the runtime emits today (Spanish until R3 Sprint 1; English
 * variants are accepted now so legacy/migrated artifacts both parse).
 */
const KEYWORD_GROUPS: ReadonlyArray<readonly string[]> = [
  // The two headings the DISCARDED list reads. They were the only ones in this
  // table's whole vocabulary with no Spanish form, and the cost was silent: a
  // `## Diferido` written by a loop whose user-facing language is Spanish simply
  // did not exist for `aw status`, so deferred work disappeared instead of being
  // reported.
  ["Diferido", "Diferidos", "Deferred"],
  ["Excluido", "Excluidos", "Excluded"],
  ["Descripción", "Descripcion", "Description"],
  ["Requerimiento", "Requirement"],
  ["Pregunta", "Question"],
  ["Brief"],
  ["Fase actual", "Current phase"],
  ["Lo último que hice", "Lo ultimo que hice", "Last action"],
  ["Próximo paso", "Proximo paso", "Next step"],
  ["Decisiones recientes", "Recent decisions"],
  ["Archivos tocados", "Files touched"],
  [
    "Archivos tocados (post-último-commit)",
    "Archivos tocados (post-ultimo-commit)",
    "Files touched (post-last-commit)",
  ],
  ["Contexto crítico para retomar", "Contexto critico para retomar", "Critical context to resume"],
  ["Fecha de inicio", "Start date"],
  ["Rama", "Branch"],
  ["State"],
  ["Contexto", "Context"],
  [
    "Criterios de aceptación",
    "Criterios de aceptacion",
    "Acceptance criteria",
    "Aceptación",
    "Aceptacion",
  ],
  ["Criterios de éxito", "Criterios de exito", "Success criteria"],
  ["Temas", "Topics"],
  ["Origen", "Origin"],
  ["Avance", "Progress"],
  ["Actualizado", "Updated"],
  ["Ramas", "Branches"],
  ["Artefactos presentes", "Artifacts present"],
  ["Skills usadas", "Skills used"],
  ["Pregunta original", "Original question"],
  ["Fuentes consultadas", "Sources consulted"],
  ["Hallazgo crudo", "Raw finding"],
  ["Notas / hipótesis tentativas", "Notas / hipotesis tentativas", "Notes / tentative hypotheses"],
  ["Resumen del plan", "Plan summary"],
  ["Tareas", "Tasks"],
  ["Riesgos / dependencias externas", "Risks / external dependencies"],
  ["Patrones identificados", "Patterns identified"],
  ["Falsos positivos descartados", "False positives discarded"],
  ["Decisión de modelo", "Decision de modelo", "Model decision"],
  ["Lo que NO se sabe (gaps)", "What is NOT known (gaps)"],
  ["Resumen", "Summary"],
  ["Conclusiones", "Conclusions"],
  ["Recomendaciones", "Recommendations"],
  ["Trazabilidad", "Traceability"],
  ["Abierto", "Open"],
  ["Abierto (gaps)", "Open (gaps)"],
  ["Componentes", "Components"],
  ["Flujos / interacciones", "Flows / interactions"],
  ["Decisiones UX", "UX decisions"],
  ["Tokens / design-system aplicados", "Tokens / design-system applied"],
  ["Criterios de validación", "Criterios de validacion", "Validation criteria"],
  ["Out of scope"],
  ["Usuarios", "Users"],
  ["Design system aplicable", "Applicable design system"],
  ["Referencias externas", "External references"],
  ["Hallazgos clave", "Key findings"],
  ["Statement"],
  ["Restricciones clave", "Key constraints"],
  ["Métricas de éxito", "Metricas de exito", "Success metrics"],
  ["Variante", "Variant"],
  ["Recomendación inicial", "Recomendacion inicial", "Initial recommendation"],
];

function normalizeKeyword(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

const ALIAS_INDEX = new Map<string, readonly string[]>();
for (const group of KEYWORD_GROUPS) {
  for (const variant of group) {
    ALIAS_INDEX.set(normalizeKeyword(variant), group);
  }
}

/**
 * Resolve a heading-keyword to the full list of accepted aliases. If the
 * keyword is not registered in {@link KEYWORD_GROUPS}, returns a one-item array
 * with the original key so callers degrade to the non-bilingual behaviour.
 */
export function bilingualAliases(key: string): readonly string[] {
  return ALIAS_INDEX.get(normalizeKeyword(key)) ?? [key];
}

/**
 * Like {@link parseMdValue} but tries every alias of `key` registered in
 * {@link KEYWORD_GROUPS}. Returns the first match. Use for fields whose name
 * the runtime is migrating ES → EN, or fields where unaccented variants are
 * common (e.g. `"Proximo paso"`).
 */
export function parseMdValueBilingual(text: string, key: string): string | undefined {
  for (const candidate of bilingualAliases(key)) {
    const value = parseMdValue(text, candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Like {@link parseMdSection} but tries every alias of `heading` registered in
 * {@link KEYWORD_GROUPS}. Returns the first match.
 *
 * `normalizeName` passes straight through, and that pass-through is the point:
 * bilingual matching and a caller's own heading normalization used to live in
 * different functions, so a reader needing BOTH — aliases *and* tolerance for a
 * legacy `## Deferred (text):` suffix — could only have one. The one that read
 * the discarded list had the suffix half, so adding a Spanish alias to the table
 * would have changed nothing.
 */
export function parseMdSectionBilingual(
  text: string,
  heading: string,
  normalizeName?: (s: string) => string,
): string | undefined {
  for (const candidate of bilingualAliases(heading)) {
    const value = parseMdSection(text, candidate, normalizeName);
    if (value !== undefined) return value;
  }
  return undefined;
}
