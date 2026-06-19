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

export function parseMdSection(text: string, heading: string): string | undefined {
  const target = heading.trim().toLowerCase();
  const lines = text.split("\n");
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;

  let captureFrom: number | null = null;
  let captureLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(headingRe);
    if (!match || !match[1] || !match[2]) continue;
    const level = match[1].length;
    const name = match[2].trim().toLowerCase();
    if (captureFrom === null) {
      if (name === target) {
        captureFrom = i + 1;
        captureLevel = level;
      }
    } else if (level <= captureLevel) {
      return joinTrim(lines.slice(captureFrom, i));
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
 *
 * Precedent: `PHASE_INDEX` and `PLANNING_PHASES` already carry bilingual
 * `planning|planificacion|plan` aliases. R1 generalizes that pattern to all
 * heading-keywords the parsers consume.
 */
const KEYWORD_GROUPS: ReadonlyArray<readonly string[]> = [
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
 */
export function parseMdSectionBilingual(text: string, heading: string): string | undefined {
  for (const candidate of bilingualAliases(heading)) {
    const value = parseMdSection(text, candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}
