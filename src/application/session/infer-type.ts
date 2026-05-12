/**
 * Heurística para inferir `## Type` de una sesión flow=dev desde el brief/objetivo.
 *
 * Canon: `qtc-workflow-plugin/skills/dev-workflow/SKILL.md` §"Convención `## Type`" + DD-8
 * de session050. Defensa en profundidad — Capa 2 (Mit-C): el CLI decide tipo cuando el
 * usuario no pasa `--type` explícito.
 *
 * Tipos canónicos (EN, no requieren traducción): feature | refactor | bugfix | chore.
 */

export type DevType = "feature" | "refactor" | "bugfix" | "chore";
export type InferConfidence = "high" | "medium" | "fallback";

export interface InferTypeResult {
  type: DevType;
  confidence: InferConfidence;
  matchedKeywords: string[];
}

/**
 * Tabla de keywords con confianza. Si match → ese tipo con esa confianza.
 * Orden importa: el primer match gana (refactor antes que feature porque "rebuild" puede
 * sonar ambiguo, pero contextualmente es refactor).
 */
const KEYWORDS: Array<{ type: DevType; confidence: InferConfidence; words: string[] }> = [
  {
    type: "refactor",
    confidence: "high",
    words: [
      "refactor",
      "rebuild",
      "migrar",
      "migración",
      "mover a nuevo",
      "reescribir",
      "legacy",
      "strangler",
    ],
  },
  {
    type: "chore",
    confidence: "high",
    words: [
      "bump",
      "actualizar dependencia",
      "actualizar dependencias",
      "limpiar imports",
      "limpieza de imports",
      "formato",
      "format",
      "rename",
      "tipos",
      "typing",
    ],
  },
  {
    type: "bugfix",
    confidence: "medium",
    words: ["fix de", "fix:", " fix ", "arreglar", "corregir", "error en", "bug en", "bugfix"],
  },
  {
    type: "feature",
    confidence: "high",
    words: [
      "agregar",
      "añadir",
      "nueva pantalla",
      "crear endpoint",
      "nuevo módulo",
      "nuevo modulo",
      "feature de",
      "introducir",
      "implementar",
    ],
  },
];

/**
 * Infiere el tipo desde un brief. Retorna `{type, confidence, matchedKeywords}`.
 * Fallback: `feature` con confianza `fallback` cuando ningún keyword matchea.
 */
export function inferType(brief: string): InferTypeResult {
  const normalized = ` ${brief.toLowerCase()} `;
  for (const entry of KEYWORDS) {
    const matched = entry.words.filter((w) => normalized.includes(w.toLowerCase()));
    if (matched.length > 0) {
      return {
        type: entry.type,
        confidence: entry.confidence,
        matchedKeywords: matched,
      };
    }
  }
  return { type: "feature", confidence: "fallback", matchedKeywords: [] };
}

/**
 * Mensaje canónico para el log cuando la inferencia cae a fallback.
 * Texto literal documentado en session050 DESIGN.md §"Open questions" (resuelta en Phase 2).
 */
export function fallbackLogMessage(type: DevType): string {
  return `[session-create] Type inferido como '${type}' por baja confianza heurística (brief no matchea keywords). Pasá --type <feature|refactor|bugfix|chore> para override.`;
}

/**
 * Valida que un valor pasado por flag `--type` sea uno de los tipos canónicos.
 * No acepta legacy ES — los valores siempre fueron EN.
 */
export function isValidDevType(value: string): value is DevType {
  return value === "feature" || value === "refactor" || value === "bugfix" || value === "chore";
}

export const VALID_DEV_TYPES: readonly DevType[] = ["feature", "refactor", "bugfix", "chore"];

/**
 * Parser bilingüe `## Type` ↔ `## Tipo` para leer OBJECTIVE.md existentes.
 * Acepta ambas formas (EN canon, ES legacy) y normaliza a EN.
 * Retorna null si no encuentra ninguna sección o el valor no es válido.
 *
 * Convivencia bilingüe alineada con OBJETIVO.md ↔ OBJECTIVE.md, DECISIONES.md ↔ DECISIONS.md.
 */
export function parseTypeFromObjetivo(content: string): DevType | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line === "## Type" || line === "## Tipo") {
      const next = lines[i + 1]?.trim() ?? "";
      if (isValidDevType(next)) {
        return next;
      }
      return null;
    }
  }
  return null;
}
