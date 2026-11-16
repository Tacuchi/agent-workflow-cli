import type { AssuranceStatus } from "../../domain/flow/route.js";
import { scanMarkdown } from "../markdown.js";

/** The single plan state field (spec 066, ID01): one exact value, no suffixes. */
export const PLAN_STATES = ["draft", "ready", "in-progress", "done", "abandoned"] as const;

export type PlanStateValue = (typeof PLAN_STATES)[number];

/**
 * Values a plan of the session model declared. They are still READ — the hubs
 * that hold them exist until `aw hub-migrate` normalizes them — but only to
 * report the plan as unmigrated, never as a state of the new contract.
 */
export const LEGACY_PLAN_STATES = ["open"] as const;

export type LegacyPlanState = (typeof LEGACY_PLAN_STATES)[number];

/** Machine value of the plan-level `> Estado:` line, under the document title. */
export type PlanDeclaredState = PlanStateValue | LegacyPlanState;

const READABLE_STATES: readonly string[] = [...PLAN_STATES, ...LEGACY_PLAN_STATES];

/** Why a declaration belongs to a hub that still has to be migrated. */
export type PlanUnmigratedReason = "legacy-value" | "legacy-suffix";

export interface PlanNextStep {
  /** The task id the line opens with (`T3.2`), or `null` when it names none. */
  task: string | null;
  /** The whole value after `Próximo paso:`. */
  text: string;
  /** One-based line of the declaration. */
  line: number;
}

export interface ParsedPlanStatus {
  /**
   * `absent` (no line at all) · a state value (exact) · `unknown` (a line
   * nobody can read). The legacy `open` is still returned as itself so the
   * readers of the session model keep working; {@link unmigrated} is what
   * says it is not a value of the new contract.
   */
  declared: PlanDeclaredState | "unknown" | "absent";
  /** closure annotation — the `> Cierre:` line, or the tail of the legacy form */
  closure: string | null;
  /** the declaration used the legacy `done — YYYY-MM-DD · sesion NNN` shape */
  legacy: boolean;
  /** Explicit evidence quality of a closed plan; absent plans predate this contract. */
  assurance: AssuranceStatus | null;
  /**
   * `null` when the declaration is absent, unreadable or a value of the new
   * contract; otherwise why only `aw hub-migrate` may read it.
   */
  unmigrated: PlanUnmigratedReason | null;
  /** One-based line of the `> Estado:` declaration, `null` when absent. */
  line: number | null;
  /** The `> Próximo paso:` line of the preamble, when there is one. */
  next_step: PlanNextStep | null;
}

const STATE_RE = /^>\s*Estado\s*:\s*(.+)$/i;
const CLOSURE_RE = /^>\s*Cierre\s*:\s*(.+)$/i;
const ASSURANCE_RE = /^>\s*Assurance\s*:\s*(.+)$/i;
const NEXT_STEP_RE = /^>\s*Pr[oó]ximo paso\s*:\s*(.+)$/i;
const NEXT_STEP_TASK_RE = /^(T\d+(?:\.\d+)*)\b/;
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
 * The machine value stands alone (`draft` | `ready` | `in-progress` | `done` |
 * `abandoned`); the date lives on the optional `> Cierre:` line and the
 * re-entry point on `> Próximo paso:`. The session model's `open` and its
 * suffixed `done — YYYY-MM-DD · sesion NNN` are still read and reported as
 * `unmigrated`, so every surface but the migration can refuse them by name.
 * Anything else reads `unknown`: an unreadable declaration is a contradiction
 * to surface, never a silent state.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one ordered preamble scan keeps status, closure, assurance and next step in one authority.
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
  let unmigrated: PlanUnmigratedReason | null = null;
  let line: number | null = null;
  let nextStep: PlanNextStep | null = null;

  for (let i = 0; i < end; i++) {
    if (fenced[i]) continue;
    // `**` tolerated: authors bold the label (`> **Estado:** done`).
    const current = (lines[i] ?? "").trim().replace(/\*/g, "");
    if (declared === "absent") {
      const raw = STATE_RE.exec(current)?.[1];
      if (raw) {
        const read = readDeclaration(raw);
        declared = read.declared;
        legacy = read.legacy;
        unmigrated = read.unmigrated;
        line = i + 1;
        if (read.closure) closure = read.closure;
        continue;
      }
    }
    if (nextStep === null) {
      const value = NEXT_STEP_RE.exec(current)?.[1]?.trim();
      if (value) {
        nextStep = { task: NEXT_STEP_TASK_RE.exec(value)?.[1] ?? null, text: value, line: i + 1 };
        continue;
      }
    }
    if (closure === null) {
      const cierre = CLOSURE_RE.exec(current)?.[1]?.trim();
      if (cierre) closure = cierre;
    }
    if (assurance === null) {
      const value = ASSURANCE_RE.exec(current)?.[1]?.trim();
      if (
        value === "verified" ||
        value === "partially_verified" ||
        value === "unverified_accepted"
      ) {
        assurance = value;
      }
    }
  }

  return { declared, closure, legacy, assurance, unmigrated, line, next_step: nextStep };
}

/** `true` when the value is one of the five states of the new contract. */
export function isPlanStateValue(value: string): value is PlanStateValue {
  return (PLAN_STATES as readonly string[]).includes(value);
}

function readDeclaration(raw: string): {
  declared: ParsedPlanStatus["declared"];
  closure: string | null;
  legacy: boolean;
  unmigrated: PlanUnmigratedReason | null;
} {
  const exact = normalizeDeclared(raw);
  if (exact) {
    return {
      declared: exact,
      closure: null,
      legacy: false,
      unmigrated: isPlanStateValue(exact) ? null : "legacy-value",
    };
  }

  const annotated = ANNOTATED_RE.exec(raw.trim());
  const head = annotated?.[1] ? normalizeDeclared(annotated[1]) : null;
  if (head && annotated?.[2]) {
    return {
      declared: head,
      closure: annotated[2].trim(),
      legacy: true,
      unmigrated: "legacy-suffix",
    };
  }
  return { declared: "unknown", closure: null, legacy: false, unmigrated: null };
}

function normalizeDeclared(raw: string): PlanDeclaredState | null {
  const folded = raw.trim().toLowerCase();
  return READABLE_STATES.includes(folded) ? (folded as PlanDeclaredState) : null;
}
