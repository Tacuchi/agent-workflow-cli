import type { AssuranceStatus } from "../../domain/flow/route.js";
import { scanMarkdown } from "../markdown.js";

export const PLAN_DECLARED_STATES = ["open", "done"] as const;

/** Machine value of the plan-level `> Estado:` line, under the document title. */
export type PlanDeclaredState = (typeof PLAN_DECLARED_STATES)[number];

export interface ParsedPlanStatus {
  /**
   * `absent` (no line at all) · `open`/`done` (an exact machine value) ·
   * `unknown` (a line nobody can read). The four are not interchangeable: a
   * plan that declares nothing is open, a plan that declares gibberish is a
   * contradiction, and only an exact value closes anything.
   */
  declared: PlanDeclaredState | "unknown" | "absent";
  /** closure annotation — the `> Cierre:` line, or the tail of the legacy form */
  closure: string | null;
  /** the declaration used the legacy `done — YYYY-MM-DD · sesion NNN` shape */
  legacy: boolean;
  /** Explicit evidence quality of a closed plan; absent plans predate this contract. */
  assurance: AssuranceStatus | null;
}

const STATE_RE = /^>\s*Estado\s*:\s*(.+)$/i;
const CLOSURE_RE = /^>\s*Cierre\s*:\s*(.+)$/i;
const ASSURANCE_RE = /^>\s*Assurance\s*:\s*(.+)$/i;
/** `done — 2026-07-27 · sesion 123` → value `done`, tail the rest. */
const ANNOTATED_RE = /^(.*?)\s+[—–-]\s+(.+)$/;

/**
 * The plan-level status line: the first `> Estado:` of the document PREAMBLE —
 * everything before the first level-2 heading, i.e. the blockquote under the
 * `# Plan PPP — <slug>` title.
 *
 * Position is what tells the two marks apart: this one governs the whole plan,
 * while the `> Estado:` lines inside the `### Fn` blocks of `## Tasks` govern
 * one phase each ({@link import("./phases.js").parsePhases}). Reading them with
 * one rule would let a validated first phase close the plan.
 *
 * The machine value stands alone (`open` | `done`); the date and session live
 * on the `> Cierre:` line. The legacy `done — YYYY-MM-DD · sesion NNN` shape is
 * still read — those plans exist — and reports `legacy: true` so the loop that
 * next edits the document migrates it instead of copying the old form forward.
 * Anything else reads `unknown`: an unreadable declaration is a contradiction
 * to surface, never a silent `open`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one ordered preamble scan keeps status, closure and assurance in one authority.
export function parsePlanStatus(text: string): ParsedPlanStatus {
  const { lines, fenced, headings } = scanMarkdown(text);
  // The preamble is the blockquote under the `# Plan PPP — <slug>` title: skip
  // the title itself, stop at the first section heading that follows it.
  const [title, ...rest] = headings;
  const boundary = title?.level === 1 ? rest[0] : title;
  const end = boundary ? boundary.line : lines.length;

  let declared: ParsedPlanStatus["declared"] = "absent";
  let closure: string | null = null;
  let legacy = false;
  let assurance: AssuranceStatus | null = null;

  for (let i = 0; i < end; i++) {
    if (fenced[i]) continue;
    // `**` tolerated: authors bold the label (`> **Estado:** done`).
    const line = (lines[i] ?? "").trim().replace(/\*/g, "");
    if (declared === "absent") {
      const raw = STATE_RE.exec(line)?.[1];
      if (raw) {
        const read = readDeclaration(raw);
        declared = read.declared;
        legacy = read.legacy;
        if (read.closure) closure = read.closure;
        continue;
      }
    }
    if (closure === null) {
      const cierre = CLOSURE_RE.exec(line)?.[1]?.trim();
      if (cierre) closure = cierre;
    }
    if (assurance === null) {
      const value = ASSURANCE_RE.exec(line)?.[1]?.trim();
      if (
        value === "verified" ||
        value === "partially_verified" ||
        value === "unverified_accepted"
      ) {
        assurance = value;
      }
    }
  }

  return { declared, closure, legacy, assurance };
}

function readDeclaration(raw: string): {
  declared: ParsedPlanStatus["declared"];
  closure: string | null;
  legacy: boolean;
} {
  const exact = normalizeDeclared(raw);
  if (exact) return { declared: exact, closure: null, legacy: false };

  const annotated = ANNOTATED_RE.exec(raw.trim());
  const head = annotated?.[1] ? normalizeDeclared(annotated[1]) : null;
  if (head && annotated?.[2]) {
    return { declared: head, closure: annotated[2].trim(), legacy: true };
  }
  return { declared: "unknown", closure: null, legacy: false };
}

function normalizeDeclared(raw: string): PlanDeclaredState | null {
  const folded = raw.trim().toLowerCase();
  return (PLAN_DECLARED_STATES as readonly string[]).includes(folded)
    ? (folded as PlanDeclaredState)
    : null;
}
