import { type MarkdownHeading, scanMarkdown } from "../markdown.js";

export const PHASE_STATES = ["pendiente", "en ejecución", "bloqueada", "validada"] as const;

/** Machine state of a plan phase, declared as `> Estado:` inside its `### Fn` block. */
export type PhaseState = (typeof PHASE_STATES)[number];

export interface PhaseItem {
  n: number;
  name: string;
  state: PhaseState;
  /** first `> Bloqueo:` line of the block, whatever the state; `null` when absent */
  blocker: string | null;
}

export interface ParsedPhases {
  total: number;
  validated: number;
  blocked: number;
  items: PhaseItem[];
}

const PHASE_NAME_RE = /^F(\d+)\s*(?:[—–-]\s*)?(.*)$/;
const STATE_RE = /^>\s*Estado\s*:\s*(.+)$/i;
const BLOCKER_RE = /^>\s*Bloqueo\s*:\s*(.+)$/i;
const TASKS_SECTION = "tasks";

interface Scan {
  items: PhaseItem[];
  /** phase block being read, or `null` between blocks */
  current: PhaseItem | null;
  /** the block in force already declared its state — later lines are prose */
  stated: boolean;
  /** the scan is inside the `## Tasks` section */
  inTasks: boolean;
  /** some block declared a `> Estado:` line — the phase contract is in force */
  anyStated: boolean;
}

/**
 * Phase progress of a plan-doc: the `### Fn` blocks of its `## Tasks` section
 * plus the first `> Estado:` line inside each one. A block ends at the next
 * heading of level ≤3; the section ends at the next level-2 heading.
 *
 * `## Tasks` is the ONLY source of phases: an `### Fn` quoted in `## Solution`,
 * one left before or after the section, a fenced example and the plan-level
 * `> Estado: done — …` line under the title all read as what they are — not
 * phases. A plan with no `## Tasks` reports zero phases and keeps measuring
 * progress by checkboxes.
 *
 * A plan whose blocks declare no `> Estado:` line at all predates the phase
 * contract: it also reports zero phases — its finished work must not read as
 * "implemented, not validated". A missing line among stated blocks reads
 * `pendiente`, and nothing is back-filled.
 *
 * The state is an exact value of the vocabulary once case, accents and inner
 * spacing are folded. An absent, annotated (`validada — SQL pendiente de
 * aplicar`) or unknown value degrades to `pendiente`: a phase is never counted
 * as validated by deference. The reason for a stop lives in its own
 * `> Bloqueo:` line, read here as opaque text so a blocked phase can say what
 * it waits on without that reason ever qualifying the machine state.
 */
export function parsePhases(text: string): ParsedPhases {
  const scan: Scan = { items: [], current: null, stated: false, inTasks: false, anyStated: false };
  const { lines, fenced, headings } = scanMarkdown(text);
  const headingByLine = new Map(headings.map((h) => [h.line, h]));

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const heading = headingByLine.get(i);
    if (heading) {
      applyHeading(scan, heading);
      continue;
    }
    if (scan.inTasks) applyBlockLine(scan, (lines[i] ?? "").trim());
  }

  if (!scan.anyStated) return { total: 0, validated: 0, blocked: 0, items: [] };
  return {
    total: scan.items.length,
    validated: scan.items.filter((p) => p.state === "validada").length,
    blocked: scan.items.filter((p) => p.state === "bloqueada").length,
    items: scan.items,
  };
}

/**
 * Section and block boundaries. A level-2 heading enters or leaves `## Tasks`;
 * a level-3 one opens a phase or closes the previous block; a deeper one is a
 * subsection of the phase in force and leaves it open.
 */
function applyHeading(scan: Scan, heading: MarkdownHeading): void {
  if (heading.level > 3) return;
  scan.current = null;
  if (heading.level <= 2) {
    scan.inTasks = heading.level === 2 && isTasksHeading(heading.title);
    return;
  }
  if (!scan.inTasks) return;
  const phase = readPhaseHeading(heading.title);
  if (!phase) return;
  scan.items.push(phase);
  scan.current = phase;
  scan.stated = false;
}

/** Tolerates the template annotations on the heading: `## Tasks (core)`, `## Tasks:`. */
function isTasksHeading(name: string): boolean {
  const bare = name.replace(/\s*\([^)]*\)\s*:?\s*$/, "").replace(/:\s*$/, "");
  return fold(bare) === TASKS_SECTION;
}

function readPhaseHeading(name: string): PhaseItem | null {
  const match = PHASE_NAME_RE.exec(name);
  if (!match?.[1]) return null;
  return { n: Number(match[1]), name: (match[2] ?? "").trim(), state: "pendiente", blocker: null };
}

/**
 * The two machine lines of a phase block: its state (first one wins, the rest
 * is prose) and its blocker reason (likewise). A block with no `> Bloqueo:`
 * keeps `blocker: null` — legacy plans stopped before the line existed, and a
 * missing reason is never invented.
 */
function applyBlockLine(scan: Scan, line: string): void {
  const current = scan.current;
  if (!current) return;
  // `**` tolerated: authors bold the label (`> **Estado:** validada`).
  const bare = line.replace(/\*/g, "");
  if (!scan.stated) {
    const state = STATE_RE.exec(bare);
    if (state?.[1]) {
      current.state = normalizeState(state[1]);
      scan.stated = true;
      scan.anyStated = true;
      return;
    }
  }
  if (current.blocker !== null) return;
  const blocker = BLOCKER_RE.exec(bare)?.[1]?.trim();
  if (blocker) current.blocker = blocker;
}

/** Case- and accent-insensitive: `en ejecucion` is the same mark as `en ejecución`. */
function fold(value: string): string {
  return value.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ");
}

const STATES_BY_FOLDED = new Map<string, PhaseState>(
  PHASE_STATES.map((state): [string, PhaseState] => [fold(state), state]),
);

/**
 * The value IS the state — nothing else may ride on the machine line. An
 * annotated `validada — SQL pendiente de aplicar` declares a pending delivery,
 * not a demonstrated result: it degrades to `pendiente` like any other
 * unrecognized value, and the phase belongs in `bloqueada`.
 */
function normalizeState(raw: string): PhaseState {
  return STATES_BY_FOLDED.get(fold(raw)) ?? "pendiente";
}
