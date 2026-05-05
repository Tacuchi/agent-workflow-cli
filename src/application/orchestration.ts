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
  "rfc",
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

const DEV_KEYWORDS = new Set([
  "implementar",
  "implementá",
  "implementa",
  "código",
  "codigo",
  "programar",
  "endpoint",
  "service",
  "controller",
  "repository",
  "migración",
  "migracion",
  "migration",
  "sql",
  "schema",
  "refactor",
  "refactorizar",
  "bugfix",
  "fix",
  "feature",
  "hotfix",
]);

export function normalize(text: string | undefined): string {
  if (!text) return "";
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function tokens(text: string | undefined): Set<string> {
  const normalized = normalize(text);
  const found = new Set<string>();
  const re = /[a-záéíóúñ0-9_-]+/g;
  let m: RegExpExecArray | null = re.exec(normalized);
  while (m !== null) {
    found.add(m[0]);
    m = re.exec(normalized);
  }
  return found;
}

export function extractPathsOrRepos(text: string | undefined): Set<string> {
  if (!text) return new Set();
  const found = new Set<string>();
  // backticks: `algo`
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  // multi-dash names: at least 2 hyphens
  for (const m of text.toLowerCase().matchAll(/\b([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){2,})\b/g)) {
    if (m[1]) found.add(m[1]);
  }
  // paths with `/`
  for (const m of text.matchAll(/\b([\w.-]+\/[\w./-]+)\b/g)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  return found;
}

export interface TopicChangeSignal {
  type: "sources_mismatch" | "work_type_shift";
  weight: number;
  detail: string;
}

export interface TopicChangeResult {
  changed: boolean;
  reason: string;
  signals: TopicChangeSignal[];
  domain_scores?: {
    objetivo: Record<string, number>;
    request: Record<string, number>;
  };
}

export function detectTopicChange(
  objetivoText: string | undefined,
  currentRequest: string | undefined,
): TopicChangeResult {
  if (!objetivoText || !currentRequest) {
    return {
      changed: false,
      reason: "input vacío; no se puede comparar",
      signals: [],
    };
  }

  const signals: TopicChangeSignal[] = [];

  const objPaths = extractPathsOrRepos(objetivoText);
  const reqPaths = extractPathsOrRepos(currentRequest);
  const newPaths = new Set([...reqPaths].filter((p) => !objPaths.has(p)));
  if (newPaths.size >= 2) {
    const sample = [...newPaths].sort().slice(0, 5);
    signals.push({
      type: "sources_mismatch",
      weight: 2,
      detail: `request menciona ${newPaths.size} repos/paths no presentes en OBJETIVO: ${formatPyList(sample)}`,
    });
  }

  const objTokens = tokens(objetivoText);
  const reqTokens = tokens(currentRequest);
  const objScore = scoreDomains(objTokens);
  const reqScore = scoreDomains(reqTokens);
  const objDom = dominantDomain(objScore);
  const reqDom = dominantDomain(reqScore);

  if (objDom && reqDom && objDom !== reqDom) {
    if ((reqScore[reqDom] ?? 0) >= 2 && (objScore[reqDom] ?? 0) === 0) {
      signals.push({
        type: "work_type_shift",
        weight: 2,
        detail: `OBJETIVO es dominantemente '${objDom}' (score ${objScore[objDom] ?? 0}); request es '${reqDom}' (score ${reqScore[reqDom] ?? 0}, no presente en OBJETIVO)`,
      });
    }
  }

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const changed = totalWeight >= 2;
  const reason =
    signals.length > 0
      ? (signals[0]?.detail ?? "no se detectaron señales significativas de cambio de tema")
      : "no se detectaron señales significativas de cambio de tema";

  return {
    changed,
    reason,
    signals,
    domain_scores: { objetivo: objScore, request: reqScore },
  };
}

function scoreDomains(toks: Set<string>): Record<string, number> {
  return {
    design: countIntersection(toks, DESIGN_KEYWORDS),
    analyze: countIntersection(toks, ANALYZE_KEYWORDS),
    dev: countIntersection(toks, DEV_KEYWORDS),
  };
}

function countIntersection(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function dominantDomain(score: Record<string, number>): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const [k, v] of Object.entries(score)) {
    if (v > bestScore) {
      best = k;
      bestScore = v;
    }
  }
  return bestScore > 0 ? best : null;
}

function formatPyList(items: string[]): string {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}

export interface SpecialtySuggestion {
  skill: string;
  reason: string;
}

export interface ChooseSpecialtyResult {
  suggestions: SpecialtySuggestion[];
  rationale: string;
  invoke_explicitly: boolean;
}

interface DomainSignals {
  hasDesign: boolean;
  hasAnalyze: boolean;
  hasDev: boolean;
}

const PLANNING_PHASES = new Set(["planning", "planificacion", "requerimiento", "plan"]);
const EXECUTION_PHASES = new Set(["execution", "ejecucion", "implementacion"]);
const VALIDATION_PHASES = new Set(["validation", "validacion"]);
const CLOSURE_PHASES = new Set(["closure", "cierre"]);

export function chooseSpecialty(
  phase: string | undefined,
  objetivoText: string | undefined,
): ChooseSpecialtyResult {
  const phaseNorm = (phase ?? "").toLowerCase();
  const toks = tokens(objetivoText);
  const signals: DomainSignals = {
    hasDesign: countIntersection(toks, DESIGN_KEYWORDS) > 0,
    hasAnalyze: countIntersection(toks, ANALYZE_KEYWORDS) > 0,
    hasDev: countIntersection(toks, DEV_KEYWORDS) > 0,
  };

  const { suggestions, rationale } = collectByPhase(phaseNorm, signals);

  const rationaleStr =
    rationale.length > 0
      ? rationale.join("; ")
      : `phase '${phaseNorm || "(none)"}' sin reglas de heurística`;

  return {
    suggestions,
    rationale: rationaleStr,
    invoke_explicitly: true,
  };
}

interface PhaseResult {
  suggestions: SpecialtySuggestion[];
  rationale: string[];
}

function collectByPhase(phase: string, signals: DomainSignals): PhaseResult {
  if (PLANNING_PHASES.has(phase)) return collectPlanning(signals);
  if (EXECUTION_PHASES.has(phase)) return collectExecution(signals);
  if (VALIDATION_PHASES.has(phase)) return collectValidation(signals);
  if (CLOSURE_PHASES.has(phase)) {
    return {
      suggestions: [],
      rationale: ["closure: sin sugerencias auto — graduate + compact son disparados por session"],
    };
  }
  return { suggestions: [], rationale: [] };
}

function collectPlanning(signals: DomainSignals): PhaseResult {
  const suggestions: SpecialtySuggestion[] = [
    {
      skill: "analyze-synthesize",
      reason: "Estructurar el OBJETIVO en TASKS.md accionables (rol planning).",
    },
  ];
  const rationale = ["planning: descomponer el objetivo en plan"];
  if (signals.hasDesign) {
    suggestions.push({
      skill: "design-brief",
      reason: "OBJETIVO menciona UI/UX — capturar Tipo (proyecto|sistema) y brief.",
    });
    rationale.push("señales de diseño detectadas");
  }
  return { suggestions, rationale };
}

function collectExecution(signals: DomainSignals): PhaseResult {
  const suggestions: SpecialtySuggestion[] = [];
  const rationale: string[] = [];
  if (signals.hasAnalyze) {
    suggestions.push({
      skill: "analyze-investigate",
      reason: "OBJETIVO menciona investigación/análisis — recolectar evidencia antes de decidir.",
    });
    rationale.push("señales de análisis detectadas");
  }
  if (signals.hasDesign) {
    suggestions.push(
      {
        skill: "design-deliver",
        reason: "OBJETIVO menciona spec/diseño — producir ENTREGA.md como spec final.",
      },
      {
        skill: "frontend-design",
        reason: "Patrones UX agnósticos al stack (single-slot, máster-slave, validación inline).",
      },
    );
    rationale.push("señales de diseño detectadas");
  }
  if (signals.hasDev || suggestions.length === 0) {
    suggestions.push(
      {
        skill: "implement",
        reason: signals.hasDev
          ? "OBJETIVO menciona implementar/refactor/fix — orquestar diffs."
          : "Default execution — orquestar diffs incrementales sobre TASKS.md.",
      },
      {
        skill: "coding-standards",
        reason: "Aplicar convenciones del stack al código nuevo o modificado.",
      },
    );
    rationale.push(
      signals.hasDev ? "señales de implementación detectadas" : "default execution = dev",
    );
  }
  return { suggestions, rationale };
}

function collectValidation(signals: DomainSignals): PhaseResult {
  if (signals.hasDev || !(signals.hasAnalyze || signals.hasDesign)) {
    return {
      suggestions: [
        {
          skill: "testing-strategy",
          reason: "Decidir nivel de validación (unit/integración/e2e/manual) y ejecutar.",
        },
        {
          skill: "coding-standards",
          reason: "Review final de calidad sobre el código modificado.",
        },
      ],
      rationale: ["validation con código → tests + review"],
    };
  }
  return {
    suggestions: [],
    rationale: [
      "validation analyze/design puro: sin sugerencias auto — validación manual o spec-only",
    ],
  };
}
