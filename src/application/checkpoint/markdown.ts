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
  lines.push("", `<!-- written by qtc-core.checkpoint at ${state.timestamp} -->`, "");
  return lines.join("\n");
}

function appendHeader(lines: string[], state: SessionState): void {
  const phase = state.phase ?? "?";
  const phaseIdx = PHASE_INDEX[phase.toLowerCase()] ?? "?/4";
  const progress = state.progress_pct;
  const progressLine =
    progress !== null
      ? `${progress}% (${state.tasks.closed} of ${state.tasks.total} tasks complete)`
      : "_progress unknown (TASKS.md missing or empty)_";
  lines.push(
    `# Checkpoint — ${state.folder}`,
    "",
    `- Updated: ${state.timestamp}`,
    `- Current phase: ${phase} (${phaseIdx})`,
    `- Progress: ${progressLine}`,
    "",
    "## Last action",
    "",
    "_[AI: 1-3 sentences on the last concrete progress. Review recent diffs and the latest entry in DECISIONS.md.]_",
    "",
    "## Next step",
    "",
    "_[AI: 1-2 sentences on what remains. Review the first open item in TASKS.md.]_",
    "",
  );
}

function appendDecisions(lines: string[], state: SessionState): void {
  lines.push("## Recent decisions", "");
  if (state.last_decision) {
    lines.push(`- ${state.last_decision.id}: ${state.last_decision.excerpt}`);
  } else {
    lines.push("_No decisions recorded._");
  }
}

function appendFilesTouched(lines: string[], state: SessionState): void {
  lines.push("", "## Files touched (post-last-commit)", "");
  const files = state.files_touched;
  if (files.length === 0) {
    lines.push("_No uncommitted changes detected in cwd._");
    return;
  }
  for (const f of files.slice(0, 20)) {
    lines.push(`- ${f.path} (+${f.added} -${f.removed}) — _[AI: purpose in 1 line]_`);
  }
  if (files.length > 20) {
    lines.push(`- _… and ${files.length - 20} more_`);
  }
}

function appendContext(lines: string[]): void {
  lines.push("", "## Critical context to resume", "");
  lines.push(
    "_[AI: 2-3 paragraphs with the minimum info needed to continue without re-exploring. What was discovered, what decisions are settled, what to keep in mind.]_",
  );
}

function appendRefs(lines: string[], state: SessionState): void {
  lines.push("", "## Refs", "");
  if (state.origen) lines.push(`- Origin: ${state.origen}`);
  if (state.branches.length > 0) lines.push(`- Branches: ${state.branches.join(", ")}`);
  const present = collectArtefacts(state.artefacts);
  if (present.length > 0) {
    lines.push(`- Artifacts present: ${present.join(", ")}`);
  }
  lines.push("- Skills used: _[AI: list the skills invoked during the session]_");
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
