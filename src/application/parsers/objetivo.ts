import { firstNonEmptyLine, parseMdSectionBilingual, parseMdValueBilingual } from "../markdown.js";

export interface ParsedObjetivo {
  titulo: string | null;
  tipo: string | null;
  modalidad: string | null;
  brief: string | null;
  criterios_aceptacion: string[];
  fuentes_mencionadas: string[];
  origen: string | null;
}

const KNOWN_FUENTE_PATTERNS: readonly RegExp[] = [
  /`([a-z][a-z0-9-]+)`/g,
  /\b(?:fuente|repo|source)[:\s]+([a-z][a-z0-9-]+)/gi,
];

export function parseObjetivo(text: string): ParsedObjetivo {
  return {
    titulo: extractTitle(text),
    tipo: parseMdValueBilingual(text, "Tipo") ?? sectionFirstLine(text, "Tipo"),
    modalidad: parseMdValueBilingual(text, "Modalidad") ?? sectionFirstLine(text, "Modalidad"),
    brief: extractBrief(text),
    criterios_aceptacion: extractCriteria(text),
    fuentes_mencionadas: extractFuentes(text),
    origen: extractOrigen(text),
  };
}

function extractTitle(text: string): string | null {
  const m = text.match(/^#\s+(.+)/m);
  return m?.[1]?.trim() ?? null;
}

function sectionFirstLine(text: string, name: string): string | null {
  const section = parseMdSectionBilingual(text, name);
  if (section === undefined) return null;
  return firstNonEmptyLine(section) ?? null;
}

function extractBrief(text: string): string | null {
  for (const name of ["Requerimiento", "Brief", "Pregunta", "Descripción"]) {
    const section = parseMdSectionBilingual(text, name);
    if (section !== undefined) {
      return section.trim();
    }
  }
  return null;
}

function extractCriteria(text: string): string[] {
  const section = parseMdSectionBilingual(text, "Criterios de aceptación");
  if (section === undefined) return [];
  const items: string[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.+)/);
    if (m?.[1]) {
      items.push(m[1].trim());
    }
  }
  return items;
}

function extractFuentes(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of KNOWN_FUENTE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
      const captured = match[1];
      if (captured) {
        found.add(captured.toLowerCase());
      }
      match = re.exec(text);
    }
  }
  return [...found].sort();
}

function extractOrigen(text: string): string | null {
  const section = parseMdSectionBilingual(text, "Origen");
  if (section === undefined) return null;
  return firstNonEmptyLine(section) ?? null;
}
