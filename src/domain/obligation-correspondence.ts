/**
 * WHETHER A LEGACY OBLIGATION IS ACTUALLY A HANDOFF THE PLAN ALREADY DECLARED.
 *
 * A note published before obligations carried a class says only what the work
 * is. Read as compensation — the safe half — it blocks a closure forever when
 * the work was never this lineage's to do. And the plan very often says so
 * already: it enumerates that same step under its operative handoff or its open
 * questions, because whoever wrote the note was copying it from there.
 *
 * So the reading is an IDENTITY test over something the plan enumerates, never a
 * judgement about words. No token list, no vocabulary, no similarity score: a
 * detector of words would silently reclassify compensation as handoff the day
 * somebody phrased it differently, and the failure would be a plan closing over
 * work nobody did. Containment in either direction is what makes the test
 * survive the two edits that actually happen — the note quoting a longer plan
 * item, and the plan item quoting a shorter note — and the minimum length is
 * what stops a common fragment from matching everything.
 */

/** Below this, a containment is a coincidence rather than a citation. */
const MIN_CORRESPONDENCE_CHARS = 24;

/**
 * The sections of a plan whose items are handoffs by construction.
 *
 * `## Handoff` in any of its spellings (`## Handoff operativo` included) and the
 * open questions: the first is work explicitly handed to somebody else, the
 * second is work explicitly NOT taken on. Nothing else counts — a step named in
 * the tasks is precisely the work the lineage owes.
 */
const HANDOFF_SECTION_RE = /^##\s+(handoff\b.*|open questions|preguntas abiertas)\s*$/i;
const SECTION_RE = /^##\s+/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX_RE = /^\[[ xX]\]\s*/;

/** Collapse every run of whitespace so a rewrap is not a different sentence. */
function normalizeForCorrespondence(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * The enumerated items of the plan's handoff and open-question sections.
 *
 * Enumerated and not "every line": prose under those headings is context, and
 * matching against it would make a paragraph that merely mentions the work read
 * as a declaration that somebody else owns it.
 */
export function planHandoffItems(planText: string): string[] {
  const items: string[] = [];
  let inside = false;
  let fenced = false;
  for (const line of planText.split(/\r?\n/u)) {
    // A fenced block is quoted text, not structure. Plans quote their own
    // template, so a fence holding `## Handoff operativo` would otherwise open a
    // section that does not exist and let its example lines pass as handoffs.
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (SECTION_RE.test(line)) {
      inside = HANDOFF_SECTION_RE.test(line);
      continue;
    }
    if (!inside) continue;
    const item = ITEM_RE.exec(line)?.[1];
    if (item === undefined) continue;
    const normalized = normalizeForCorrespondence(item.replace(CHECKBOX_RE, ""));
    if (normalized.length > 0) items.push(normalized);
  }
  return items;
}

/**
 * The plan item this obligation cites, or `null` when it cites none.
 *
 * Returning the item rather than a boolean is deliberate: a reading that
 * reclassifies work has to be able to say WHICH line of the plan it read, or
 * nobody can check it.
 */
export function correspondingPlanItem(text: string, items: readonly string[]): string | null {
  const needle = normalizeForCorrespondence(text);
  if (needle.length === 0) return null;
  for (const item of items) {
    const shorter = needle.length <= item.length ? needle : item;
    const longer = needle.length <= item.length ? item : needle;
    if (shorter.length < MIN_CORRESPONDENCE_CHARS) continue;
    if (longer.includes(shorter)) return item;
  }
  return null;
}
