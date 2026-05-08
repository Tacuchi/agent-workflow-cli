import type { SessionState } from "./state-reader.js";

const PHASE_INDEX: Record<string, string> = {
  planning: "1/4",
  planificacion: "1/4",
  requerimiento: "1/4",
  plan: "1/4",
  execution: "2/4",
  ejecucion: "2/4",
  implementacion: "2/4",
  validation: "3/4",
  validacion: "3/4",
  closure: "4/4",
  cierre: "4/4",
};

export function formatCheckpointMd(state: SessionState): string {
  const lines: string[] = [];
  appendHeader(lines, state);
  appendDecisions(lines, state);
  appendFilesTouched(lines, state);
  appendContext(lines);
  appendRefs(lines, state);
  lines.push("", `<!-- escrito por qtc-core.checkpoint en ${state.timestamp} -->`, "");
  return lines.join("\n");
}

function appendHeader(lines: string[], state: SessionState): void {
  const phase = state.phase ?? "?";
  const phaseIdx = PHASE_INDEX[phase.toLowerCase()] ?? "?/4";
  const progress = state.progress_pct;
  const progressLine =
    progress !== null
      ? `${progress}% (${state.tasks.closed} de ${state.tasks.total} tareas completas)`
      : "_avance no determinado (TASKS.md ausente o vacío)_";
  lines.push(
    `# Checkpoint — ${state.folder}`,
    "",
    `- Actualizado: ${state.timestamp}`,
    `- Fase actual: ${phase} (${phaseIdx})`,
    `- Avance: ${progressLine}`,
    "",
    "## Lo último que hice",
    "",
    "_[AI: 1-3 oraciones del último avance concreto. Revisa últimos diffs y la última entrada de DECISIONES.md.]_",
    "",
    "## Próximo paso",
    "",
    "_[AI: 1-2 oraciones de qué hace falta hacer. Revisa primer item abierto en TASKS.md.]_",
    "",
  );
}

function appendDecisions(lines: string[], state: SessionState): void {
  lines.push("## Decisiones recientes", "");
  if (state.last_decision) {
    lines.push(`- ${state.last_decision.id}: ${state.last_decision.excerpt}`);
  } else {
    lines.push("_Sin decisiones registradas._");
  }
}

function appendFilesTouched(lines: string[], state: SessionState): void {
  lines.push("", "## Archivos tocados (post-último-commit)", "");
  const files = state.files_touched;
  if (files.length === 0) {
    lines.push("_Sin cambios sin commitear detectados en el cwd._");
    return;
  }
  for (const f of files.slice(0, 20)) {
    lines.push(`- ${f.path} (+${f.added} -${f.removed}) — _[AI: propósito en 1 línea]_`);
  }
  if (files.length > 20) {
    lines.push(`- _… y ${files.length - 20} más_`);
  }
}

function appendContext(lines: string[]): void {
  lines.push("", "## Contexto crítico para retomar", "");
  lines.push(
    "_[AI: 2-3 párrafos con la info mínima para continuar sin re-explorar. Qué descubriste, qué decisiones quedaron tomadas, qué hay que tener presente.]_",
  );
}

function appendRefs(lines: string[], state: SessionState): void {
  lines.push("", "## Refs", "");
  if (state.origen) lines.push(`- Origen: ${state.origen}`);
  if (state.branches.length > 0) lines.push(`- Ramas: ${state.branches.join(", ")}`);
  const present = collectArtefacts(state.artefacts);
  if (present.length > 0) {
    lines.push(`- Artefactos presentes: ${present.join(", ")}`);
  }
  lines.push("- Skills usadas: _[AI: enumera las skills invocadas durante la sesión]_");
}

function collectArtefacts(artefacts: Record<string, boolean | number>): string[] {
  const present: string[] = [];
  for (const [k, v] of Object.entries(artefacts)) {
    if (k === "scripts_count") continue;
    if (v === true) present.push(k);
  }
  const scriptsCount = artefacts.scripts_count;
  if (typeof scriptsCount === "number" && scriptsCount > 0) {
    present.push(`scripts(${scriptsCount})`);
  }
  return present;
}
