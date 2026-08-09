/**
 * What a session says it did, in the order it happened, with a source per fact.
 *
 * The memory of a run is spread across artifacts on purpose — `SESSION.md` holds
 * the objective and the done-condition, `CHECKPOINT.md` the progress, `DECISION.md`
 * the reasons, the run state what really executed — and each of them is the PRIMARY
 * place for what it owns. What was missing is not another store: it is the reading
 * that puts them in order for somebody who was not there.
 *
 * So this is a PROJECTION and never a second memory. Two rules make that true and
 * both are structural:
 *
 * - **Every fact carries its source.** {@link NarrativeSource} names the artifact
 *   and the heading it came from, so any line here can be walked back to the file
 *   that owns it. A fact this type could not attribute would be a narrative
 *   somebody maintains by hand, which is the drift it exists to remove.
 * - **Nothing is authored here.** Each field is read from its owner. The narrative
 *   can go stale against its sources, and the answer to that is to rebuild it —
 *   never to edit it, which is why the block it renders says so out loud.
 *
 * The four states are the distinction a reader actually needs: what was PLANNED,
 * what was APPLIED, what FAILED, and what is CLOSED. Collapsing planned and
 * applied is what makes a checklist unreadable — a ticked box and a proven result
 * are different claims.
 */

export const NARRATIVE_STATES = ["planificado", "aplicado", "fallido", "cerrado"] as const;

export type NarrativeState = (typeof NARRATIVE_STATES)[number];

/** The artifact a fact belongs to, and where inside it. */
export interface NarrativeSource {
  /** Filename of the owning artifact, as it exists in the session folder. */
  artifact: string;
  /** Heading or field inside it. `null` when the artifact has only one thing to say. */
  locator: string | null;
}

export interface NarrativeFact {
  state: NarrativeState;
  /** One line, as its source words it. Never a paraphrase this module invents. */
  text: string;
  /**
   * The technical half: ids, digests, effect classes, transition names.
   *
   * Kept APART rather than folded into `text`, because the two answer different
   * questions and only one of them helps somebody decide what to do next. A
   * normal reading shows the sentence; asking for detail shows this. Folding them
   * together is how a session log becomes unreadable while still being complete —
   * and dropping it altogether is how the evidence stops being checkable.
   */
  detail: string | null;
  source: NarrativeSource;
}

/** How far along the session itself is — derived, never declared. */
export const SESSION_PHASES = ["abierta", "reanudada", "cerrada"] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

export interface SessionNarrative {
  session: string;
  code: string | null;
  phase: SessionPhase;
  /** What the run set out to do. */
  objective: NarrativeFact | null;
  /** What materially happened, in order. Empty for a session that ran nothing yet. */
  sequence: NarrativeFact[];
  /** The done-condition, one fact per criterion, planned or applied. */
  tasks: NarrativeFact[];
  /** Decisions with their reason — the "why" no other field carries. */
  decisions: NarrativeFact[];
  /** What came out of the work. */
  results: NarrativeFact[];
  /** What can be checked, and where. */
  evidence: NarrativeFact[];
  /** What is still open. */
  pending: NarrativeFact[];
  /** The single next action. `null` only when there is genuinely none. */
  next: NarrativeFact | null;
  /** The artifacts themselves, so the technical detail is one hop away. */
  links: Array<{ label: string; path: string }>;
}

/**
 * The markers that delimit the CLI-managed block inside `SESSION.md`.
 *
 * Comment markers rather than a heading boundary, because the upsert has to be
 * exact: a block delimited by "the next `##`" would swallow whatever a person
 * wrote after it the first time the two got out of order. HTML comments also keep
 * the file readable as Markdown, which is the whole point of writing it there.
 */
export const NARRATIVE_BEGIN = "<!-- aw:recorrido -->";
export const NARRATIVE_END = "<!-- /aw:recorrido -->";

const MANAGED_NOTE =
  "> Bloque administrado por el CLI: proyecta las fuentes que enlaza y se reescribe solo. Editarlo a mano no cambia nada — corregí la fuente.";

/**
 * The block as it lands in `SESSION.md`.
 *
 * Every line that states a fact also states where it came from, in the same
 * breath. That is not decoration: a reader who disagrees with a line needs to know
 * which file to open, and a reader who trusts it needs to know the CLI did not
 * make it up.
 */
export interface NarrativeRenderOptions {
  /** Show ids, digests and transition names. Off by default, on under `--detail`. */
  detail?: boolean;
}

export function renderNarrativeBlock(
  narrative: SessionNarrative,
  options: NarrativeRenderOptions = {},
): string {
  const lines: string[] = [NARRATIVE_BEGIN, "## Recorrido", "", MANAGED_NOTE, ""];
  const detail = options.detail === true;
  lines.push(`- **Estado:** ${narrative.phase}`);
  if (narrative.objective !== null) {
    lines.push(`- **Objetivo:** ${line(narrative.objective, detail)}`);
  }
  if (narrative.next !== null) {
    lines.push(`- **Siguiente paso:** ${line(narrative.next, detail)}`);
  }
  section(lines, "Qué pasó", narrative.sequence, detail);
  section(lines, "Tareas", narrative.tasks, detail);
  section(lines, "Decisiones y por qué", narrative.decisions, detail);
  section(lines, "Resultados", narrative.results, detail);
  section(lines, "Evidencia", narrative.evidence, detail);
  section(lines, "Pendiente", narrative.pending, detail);
  if (narrative.links.length > 0) {
    lines.push("", "### Detalle");
    for (const link of narrative.links) lines.push(`- [${link.label}](${link.path})`);
  }
  lines.push("", NARRATIVE_END);
  return lines.join("\n");
}

/** A section, omitted entirely when it has nothing to say. */
function section(
  lines: string[],
  title: string,
  facts: readonly NarrativeFact[],
  detail: boolean,
): void {
  if (facts.length === 0) return;
  lines.push("", `### ${title}`);
  for (const fact of facts) lines.push(`- ${line(fact, detail)}`);
}

/**
 * One fact: its state, its sentence, and where it came from.
 *
 * The ARTIFACT always travels — knowing which file owns a line is what makes it
 * checkable, and a filename is not jargon. What waits for `detail` is the rest:
 * the heading inside it, the transition names, the digests. A reader deciding
 * what to do next is not helped by a sha, and a reader auditing the run cannot do
 * without one; the flag is the difference between the two, not a shorter version
 * of the same text.
 */
function line(fact: NarrativeFact, detail: boolean): string {
  if (!detail) return `${fact.text} _(${fact.state} · ${fact.source.artifact})_`;
  const where =
    fact.source.locator === null
      ? fact.source.artifact
      : `${fact.source.artifact} › ${fact.source.locator}`;
  const technical = fact.detail === null ? "" : ` · ${fact.detail}`;
  return `${fact.text} _(${fact.state} · ${where}${technical})_`;
}

/**
 * Put the block into a `SESSION.md`, replacing any block already there.
 *
 * Idempotent by construction: the markers bound exactly what this function wrote
 * last time, so re-rendering never nests, duplicates or eats a neighbouring
 * section. A document without the markers gets the block appended — never
 * inserted in the middle, where it would land ahead of sections a loop is still
 * filling.
 */
export function upsertNarrativeBlock(document: string, block: string): string {
  const begin = document.indexOf(NARRATIVE_BEGIN);
  const end = document.indexOf(NARRATIVE_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = document.slice(0, begin);
    const after = document.slice(end + NARRATIVE_END.length);
    return `${before}${block}${after}`;
  }
  const base = document.endsWith("\n") ? document : `${document}\n`;
  return `${base}\n${block}\n`;
}

/**
 * The document without its managed block — what a reader authored.
 *
 * Used where the block must not be read back as content: rebuilding a narrative
 * from a `SESSION.md` that already contains one would let the projection feed on
 * itself, and the circular reading is exactly the defect this whole contract
 * removes.
 */
export function stripNarrativeBlock(document: string): string {
  const begin = document.indexOf(NARRATIVE_BEGIN);
  const end = document.indexOf(NARRATIVE_END);
  if (begin === -1 || end === -1 || end < begin) return document;
  return `${document.slice(0, begin)}${document.slice(end + NARRATIVE_END.length)}`;
}
