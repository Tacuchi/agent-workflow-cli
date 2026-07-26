export const PHASE_STATES = ["pendiente", "en ejecución", "bloqueada", "validada"] as const;

/** Machine state of a plan phase, declared as `> Estado:` inside its `### Fn` block. */
export type PhaseState = (typeof PHASE_STATES)[number];

export interface PhaseItem {
  n: number;
  name: string;
  state: PhaseState;
}

export interface ParsedPhases {
  total: number;
  validated: number;
  items: PhaseItem[];
}

const PHASE_HEADING_RE = /^###\s+F(\d+)\s*(?:[—–-]\s*)?(.*)$/;
const HEADING_RE = /^#{1,3}\s+\S/;
const STATE_RE = /^>\s*Estado\s*:\s*(.+)$/i;
const FENCE_RE = /^(?:```|~~~)/;

/**
 * Phase progress of a plan-doc: every `### Fn` block plus the first `> Estado:`
 * line inside it. A block ends at the next heading of level ≤3.
 *
 * Only marks inside a block count: the plan-level `> Estado: done — …` line
 * under the title lives in no block, and fenced examples are skipped, so
 * neither can inflate the count. An absent or unrecognized value degrades to
 * `pendiente` — a phase is never counted as validated by accident; an
 * annotated one (`validada — SQL pendiente de aplicar`) keeps its state.
 */
export function parsePhases(text: string): ParsedPhases {
  const items: PhaseItem[] = [];
  let current: PhaseItem | null = null;
  let stated = false;
  let fenced = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const heading = PHASE_HEADING_RE.exec(line);
    if (heading?.[1]) {
      current = { n: Number(heading[1]), name: (heading[2] ?? "").trim(), state: "pendiente" };
      stated = false;
      items.push(current);
      continue;
    }
    if (HEADING_RE.test(line)) {
      current = null;
      continue;
    }
    if (!current || stated) continue;

    // `**` tolerated: authors bold the label (`> **Estado:** validada`).
    const state = STATE_RE.exec(line.replace(/\*/g, ""));
    if (!state?.[1]) continue;
    current.state = normalizeState(state[1]);
    stated = true;
  }

  return {
    total: items.length,
    validated: items.filter((p) => p.state === "validada").length,
    items,
  };
}

/** Case- and accent-insensitive: `en ejecucion` is the same mark as `en ejecución`. */
function fold(value: string): string {
  return value.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ");
}

/** Longest folded form first, so no state can be shadowed by a shorter prefix. */
const STATES_BY_LENGTH = PHASE_STATES.map((state) => ({ state, folded: fold(state) })).sort(
  (a, b) => b.folded.length - a.folded.length,
);

const ANNOTATION_RE = /^ [—–·-](\s|$)/;

/**
 * The state is the PREFIX of the value: an annotation introduced by a separator
 * (`validada — SQL pendiente de aplicar`) qualifies the state, it does not
 * replace it — the plan-level line already reads that way. Extra text glued
 * without a separator is noise, not an annotation, and degrades to `pendiente`.
 */
function normalizeState(raw: string): PhaseState {
  const value = fold(raw);
  for (const { state, folded } of STATES_BY_LENGTH) {
    if (!value.startsWith(folded)) continue;
    const rest = value.slice(folded.length);
    if (rest === "" || ANNOTATION_RE.test(rest)) return state;
  }
  return "pendiente";
}
