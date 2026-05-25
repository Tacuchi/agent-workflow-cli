import { extractPathsOrRepos, tokens } from "./orchestration.js";

const PROPUESTA_KEYWORDS = new Set(["propuesta", "post-mortem", "postmortem"]);

const TRIVIAL_VERBS = new Set([
  "typo",
  "rename",
  "renombrar",
  "comment",
  "comentario",
  "fix-typo",
  "comma",
  "format",
  "formatear",
  "indent",
  "indentación",
]);

const DESIGN_KEYWORDS = new Set([
  "ui",
  "ux",
  "interfaz",
  "diseño",
  "diseno",
  "mock",
  "mockup",
  "wireframe",
  "layout",
  "pantalla",
  "screen",
  "form",
  "formulario",
  "modal",
  "componente",
  "estilo",
  "css",
  "tema",
  "theme",
  "spec",
  "design-system",
]);

const ANALYZE_KEYWORDS = new Set([
  "propuesta",
  "post-mortem",
  "postmortem",
  "análisis",
  "analisis",
  "investigar",
  "investigación",
  "investigacion",
  "auditoría",
  "auditoria",
  "hipótesis",
  "hipotesis",
  "hallazgo",
  "evidencia",
  "métrica",
  "metrica",
  "performance",
  "latencia",
  "incidente",
]);

export interface AutoPlanResult {
  decision: "skip" | "lite" | "full";
  reason: string;
  signals: string[];
  metrics?: {
    criteria: number;
    sources: number;
    eta_hours: number;
    design?: boolean;
    analyze?: boolean;
    propuesta?: boolean;
  };
}

export interface AutoPlanOptions {
  flow?: string;
  modalidad?: string;
  declaredAliases?: readonly string[];
}

export function shouldSkipFullPlan(
  objetivoText: string | undefined,
  options?: AutoPlanOptions,
): AutoPlanResult {
  if (!objetivoText || objetivoText.trim().length === 0) {
    return {
      decision: "lite",
      reason: "OBJETIVO vacío o no provisto; default lite",
      signals: [],
    };
  }

  if (options?.flow === "analyze") {
    const modalidad = (options.modalidad ?? parseModality(objetivoText) ?? "").toLowerCase();
    if (modalidad === "incident") {
      return {
        decision: "lite",
        reason: "flow=analyze modalidad=incident → lite per doctrina (post-mortem requiere ordering)",
        signals: ["analyze-incident"],
      };
    }
    return {
      decision: "skip",
      reason: "flow=analyze → skip per doctrina (EVIDENCE/FINDINGS shape, sin plan tradicional)",
      signals: ["analyze-skip"],
    };
  }

  const criteria = countAcceptanceCriteria(objetivoText);
  const semanticMode = options?.declaredAliases !== undefined && options.declaredAliases.length > 0;
  const sources = semanticMode
    ? countDeclaredSourcesMentioned(objetivoText, options.declaredAliases ?? [])
    : countSourcesMentioned(objetivoText);
  const sourcesThreshold = semanticMode ? 3 : 10;
  const sourcesLabel = sourcesThreshold === 3 ? ">=3 fuentes mencionadas" : ">=10 fuentes mencionadas";
  const hasDesign = mentionsAny(objetivoText, DESIGN_KEYWORDS);
  const hasAnalyze = mentionsAny(objetivoText, ANALYZE_KEYWORDS);
  const hasPropuesta = mentionsAny(objetivoText, PROPUESTA_KEYWORDS);
  const eta = estimateEtaHours(
    objetivoText,
    options?.declaredAliases !== undefined ? { declaredAliases: options.declaredAliases } : {},
  );
  const trivial = looksTrivial(objetivoText);

  const signals: string[] = [];
  if (criteria >= 2) signals.push(`>=2 criterios de aceptación (${criteria})`);
  if (sources >= sourcesThreshold) signals.push(`${sourcesLabel} (${sources})`);
  if (hasDesign) signals.push("menciona diseño/UI/UX");
  if (hasPropuesta) signals.push("menciona propuesta/post-mortem");
  if (eta > 4) signals.push(`ETA estimada ${formatNumber(eta)}h (>4h)`);

  if (signals.length > 0) {
    return {
      decision: "full",
      reason: signals.join("; "),
      signals,
      metrics: {
        criteria,
        sources,
        eta_hours: eta,
        design: hasDesign,
        analyze: hasAnalyze,
        propuesta: hasPropuesta,
      },
    };
  }

  if (trivial) {
    return {
      decision: "skip",
      reason: "OBJETIVO corto + sin estructura + verbos triviales",
      signals: ["trivial"],
      metrics: { criteria, sources, eta_hours: eta },
    };
  }

  return {
    decision: "lite",
    reason: "tarea moderada sin disparadores fuertes; plan corto suficiente",
    signals: [],
    metrics: { criteria, sources, eta_hours: eta },
  };
}

export function countAcceptanceCriteria(text: string | undefined): number {
  if (!text) return 0;
  // Mirror Python: \Z anchor doesn't exist in JS; line-by-line section parser.
  const lines = text.split("\n");
  let captureFrom: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(
      /^##\s+(?:Criterios?\s+de\s+aceptaci[oó]n|Acceptance\s+Criteria|Success\s+criteria|Criterios?\s+de\s+[eé]xito)\s*$/i,
    );
    if (m) {
      captureFrom = i + 1;
      break;
    }
  }
  if (captureFrom === null) return 0;
  let count = 0;
  for (let i = captureFrom; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("##")) break;
    if (/^\s*[-*]\s+/.test(line)) count += 1;
  }
  return count;
}

/**
 * @deprecated Use {@link countDeclaredSourcesMentioned} when `AW-PROJECT.Fuentes` is
 * available — it counts only declared sources, not arbitrary code identifiers.
 * Kept as legacy fallback when no project context is available.
 */
export function countSourcesMentioned(text: string | undefined): number {
  return extractPathsOrRepos(text ?? "").size;
}

export function countDeclaredSourcesMentioned(
  text: string | undefined,
  aliases: readonly string[],
): number {
  if (!text || aliases.length === 0) return 0;
  const toks = tokens(text);
  let n = 0;
  for (const a of aliases) {
    if (toks.has(a.toLowerCase())) n += 1;
  }
  return n;
}

function mentionsAny(text: string, vocab: Set<string>): boolean {
  const toks = tokens(text);
  for (const t of toks) if (vocab.has(t)) return true;
  return false;
}

export function looksTrivial(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length > 200) return false;
  const toks = tokens(trimmed);
  for (const t of toks) {
    if (TRIVIAL_VERBS.has(t)) return true;
  }
  if (countSourcesMentioned(trimmed) <= 1 && countAcceptanceCriteria(trimmed) === 0) {
    if (trimmed.split(/\s+/).filter((w) => w.length > 0).length < 15) return true;
  }
  return false;
}

export function estimateEtaHours(
  text: string | undefined,
  options?: { declaredAliases?: readonly string[] },
): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const aliases = options?.declaredAliases;
  const sources =
    aliases !== undefined && aliases.length > 0
      ? countDeclaredSourcesMentioned(text, aliases)
      : countSourcesMentioned(text);
  const criteria = countAcceptanceCriteria(text);
  const base = words / 200;
  const cappedSources = Math.min(sources, 4);
  const srcFactor = 1 + 0.25 * Math.max(0, cappedSources - 1);
  const critFactor = 1 + 0.3 * criteria;
  return Math.round(base * srcFactor * critFactor * 10) / 10;
}

function formatNumber(n: number): string {
  // Python float repr: 4.0 → "4.0"; integers stay as "4". Round to 1 decimal anyway.
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

function parseModality(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^##\s+(?:Modality|Modalidad)\s*$/i.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next === undefined) continue;
        if (next.startsWith("##")) return null;
        const trimmed = next.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }
  return null;
}
