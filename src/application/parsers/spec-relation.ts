import { CORRELATIVE_SOURCE, compareCorrelatives } from "../../domain/correlative.js";
import { DEFAULT_CORE_DOCS_CANON } from "../../domain/docs-canon.js";
import { type PlanBaselineSeal, parsePlanBaseline, specCriteria } from "../../domain/lineage.js";
import { type MarkdownHeading, parseMdSectionBilingual, scanMarkdown } from "../markdown.js";
import {
  ACCEPTANCE_CRITERIA_KEY,
  type FunctionalSection,
  functionalSections,
} from "./spec-functional.js";

/**
 * Which kind of evidence tied a plan to its spec. Ordered by how explicit the
 * declaration is — see {@link parseSpecRelation}.
 */
export type SpecEvidence = "derived-from" | "origin-path" | "spec-reference";

export type ParsedSpecRelation =
  | { status: "declared"; number: string; evidence: SpecEvidence }
  | { status: "ambiguous"; numbers: string[]; evidence: SpecEvidence }
  | { status: "standalone" }
  | { status: "absent" };

// `Spec 011` / `spec 011` — a bare number is NOT evidence: `sesión 047` and
// `baseline 044` would match it, and the whole point is to never guess.
const SPEC_REFERENCE_RE = new RegExp(`\\bspec\\s+(${CORRELATIVE_SOURCE})\\b`, "gi");

const DERIVED_FROM_RE = /derived from/i;

/**
 * `> Standalone: <prosa>` — the marker a plan born in the host conversation
 * carries instead of a `Derived from`.
 *
 * Same shape as the seal's own label, deliberately: fixed English label, one
 * blockquote line, free prose after the colon. The `>` is part of the grammar —
 * a sentence about the marker is not the marker — and the value is checked for
 * content by the caller, because `\s*(.+?)\s*$` still matches a line whose
 * whole value is whitespace.
 */
const STANDALONE_LABEL = /^\s*>\s*Standalone:\s*(.+?)\s*$/i;

/**
 * The spec a plan declares as its source, by NUMBER — resolving the number
 * against the real spec inventory belongs to the caller.
 *
 * Evidence is read in a fixed order and the FIRST level that says anything is
 * final; levels never merge. Slug similarity, file dates and document age are
 * deliberately absent: they are what made the old association guess wrong.
 *
 * 1. `Derived from docs/specs/NNN-…` in the header blockquote — what
 *    `plan-new` writes today.
 * 2. An explicit spec path inside `## Origin` — what plans written before that
 *    header carried.
 * 3. An unambiguous `Spec NNN` reference inside `## Origin` — the weakest
 *    accepted form, scoped to that section so a mention in `## Dependencies`
 *    ("la spec 009 consumirá…") is never mistaken for provenance.
 * 4. `> Standalone: <prosa>` in the header blockquote — the plan declaring that
 *    it has NO spec because it was born in the conversation. `standalone` is a
 *    diagnosis, not a defect: the board routes it and the deviation gate lets it
 *    register decisions, neither of which `absent` may do.
 *
 * The order is what makes level 4 safe to add. It is read LAST, so a plan that
 * carries both the marker and real spec evidence resolves to its spec and the
 * marker stays inert — the marker can never demote a declared lineage, and
 * nothing has to be said about a document that contradicts itself.
 *
 * Two different specs at the same level is `ambiguous`, not a coin flip:
 * a human wrote something contradictory and only a human should settle it.
 */
export function parseSpecRelation(
  text: string,
  specDir: string = DEFAULT_CORE_DOCS_CANON.spec,
): ParsedSpecRelation {
  const specPath = specPathPattern(specDir);
  const origin = parseMdSectionBilingual(text, "Origin") ?? "";
  const levels: ReadonlyArray<{ evidence: SpecEvidence; numbers: string[] }> = [
    { evidence: "derived-from", numbers: derivedFromNumbers(text, specPath) },
    { evidence: "origin-path", numbers: matchNumbers(origin, specPath) },
    { evidence: "spec-reference", numbers: matchNumbers(origin, SPEC_REFERENCE_RE) },
  ];

  for (const { evidence, numbers } of levels) {
    const [first] = numbers;
    if (first === undefined) continue;
    if (numbers.length === 1) return { status: "declared", number: first, evidence };
    return { status: "ambiguous", numbers, evidence };
  }
  return declaresStandalone(text) ? { status: "standalone" } : { status: "absent" };
}

/**
 * The baseline a plan sealed: WHICH bytes of its spec it was derived from.
 *
 * Read from the same header blockquote and with the same bound as `Derived
 * from`, and kept a separate call because the two answer different questions —
 * one names the spec, the other pins its version. A plan may legitimately have
 * the first and not the second: every plan written before the seal existed
 * does, and that reads `absent`, never a failure.
 */
export function parsePlanBaselineSeal(
  text: string,
  specDir: string = DEFAULT_CORE_DOCS_CANON.spec,
): PlanBaselineSeal {
  const { lines, fenced, headings } = scanMarkdown(text);
  const firstSection = headings.find((h) => h.level >= 2);
  const end = firstSection?.line ?? lines.length;
  return parsePlanBaseline(lines, fenced, end, specDir);
}

/**
 * The literal spec path on the plan's `Derived from` line.
 *
 * `parseSpecRelation` answers by NUMBER on purpose — resolving it against the
 * real inventory is the caller's job, and a path in a document is a hint that
 * can be stale. Sealing a baseline is the one caller that needs the written
 * path itself: it is what the seal records as its hint, and reading the bytes
 * it points at is how the digest is computed. `null` when the plan declares no
 * `Derived from` path, or declares more than one.
 */
export function parseDerivedFromPath(
  text: string,
  specDir: string = DEFAULT_CORE_DOCS_CANON.spec,
): string | null {
  const { lines, fenced, headings } = scanMarkdown(text);
  const firstSection = headings.find((h) => h.level >= 2);
  const end = firstSection?.line ?? lines.length;
  const specPath = specPathPattern(specDir);
  const found: string[] = [];
  for (let i = 0; i < end; i += 1) {
    const line = lines[i];
    if (line === undefined || fenced[i] === true) continue;
    if (!DERIVED_FROM_RE.test(line)) continue;
    for (const match of line.matchAll(new RegExp(specPath.source, specPath.flags))) {
      found.push(match[0]);
    }
  }
  const unique = [...new Set(found)];
  return unique.length === 1 ? (unique[0] as string) : null;
}

/**
 * The acceptance criteria a spec states, in document order and without
 * duplicates — addressable with the ONE grammar (`S033/AC-01`).
 *
 * Two harvests of the same closed grammar, united:
 *
 * 1. every literal `S{NNN}/AC-nn` the document mentions, anywhere — what the
 *    design subsystem already read, unchanged;
 * 2. when `specNumber` is given, the LABELS inside `## Acceptance criteria` —
 *    every appearance of it, located by the same function the SEAL uses:
 *    `- [ ] AC-01: …` states criterion `S{NNN}/AC-01` of that spec.
 *
 * The second half is why a decision note can exist at all. Real specs rotulate
 * their criteria the way doctrine's own template does — with the bare label —
 * so harvesting only form 1 returned `[]` for them, every note addressing a
 * criterion blocked as `CONTRACT_ASSERTION_ABSENT` ("the spec does not state
 * it", about a spec that states it), and the deviation gate's composable exit
 * was closed for every spec in existence.
 *
 * Both forms produce the SAME id, and the dedupe is what lets a spec label a
 * criterion and mention it in `## Scenarios` without stating it twice.
 *
 * `specNumber` must be the three-digit correlative the grammar admits: `S` plus
 * three digits is the whole vocabulary, so a four-digit correlative cannot form
 * a valid id and derives nothing rather than emitting one nobody can address.
 * Without `specNumber` the answer is byte-identical to harvest 1 alone.
 */
export function parseSpecCriteria(text: string, specNumber?: string): string[] {
  const { lines, fenced, headings } = scanMarkdown(text);
  if (specNumber === undefined || !/^\d{3}$/.test(specNumber)) {
    return specCriteria(lines, fenced);
  }
  const checklists = criteriaSections(headings, lines.length);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const [index, line] of lines.entries()) {
    if (line === undefined || fenced[index] === true) continue;
    // The mention harvest, asked one line at a time: the union comes out in
    // document order and the grammar still lives in exactly one place.
    for (const id of specCriteria([line], [false])) add(id);
    if (!checklists.some((section) => index >= section.start && index < section.end)) continue;
    const label = LABELLED_AC.exec(line)?.[1];
    if (label !== undefined) add(`S${specNumber}/${label}`);
  }
  return out;
}

/**
 * A checklist item whose label IS its criterion: `- [ ] AC-01:`, `- [x] **AC-02**:`,
 * `- [ ] AC-CAP-03.`
 *
 * Anchored at the item marker, so the older `- [ ] **S013/AC-CAP-01:**` does not
 * match here — it is already harvest 1, and matching both would be one criterion
 * counted twice under two spellings.
 *
 * The three Markdown bullet markers, the same ones the payload's tick
 * normalization accepts: what the SEAL digests as contract is every line of the
 * section whatever its marker, so recognizing only `-` here would make
 * `* [ ] AC-04: …` contract and unaddressable at once — a note amending it dies
 * in `CONTRACT_ASSERTION_ABSENT` about a criterion its own spec states.
 *
 * The label ends at a TOKEN BOUNDARY rather than at a closed set of delimiters,
 * for that same reason one level down. The doctrine recommends EARS
 * (`- [ ] AC-01 WHEN … THEN …`) and this project writes `- [ ] AC-01 — outcome`:
 * demanding `:` or `.` right after the label would seal both as contract and
 * leave them unaddressable. The lookahead still refuses `AC-01abc` and
 * `AC-01-2`, which are not ids this grammar can form.
 */
const LABELLED_AC = /^\s*[-*+]\s*\[[ xX]\]\s*\*{0,2}(AC-(?:[A-Z]+-)?\d+)\*{0,2}(?![0-9A-Za-z-])/;

/**
 * Every `## Acceptance criteria` section of the spec, in document order.
 *
 * Bounded because a bare label only means a criterion THERE: `- [ ] AC-01: …`
 * inside `## Open questions` is a question about a criterion, and a checklist in
 * `## Validations` is work to do.
 *
 * ALL of them, and located by {@link functionalSections} — the very function the
 * SEAL uses to decide which text is contract. Two answers to "where are the
 * criteria" is how one half of the lineage seals a criterion the other half
 * cannot address: a spec whose checklist is split in two blocks would have its
 * second block digested as contract while a note amending anything in it is
 * refused as absent from the spec, and the plan never closes.
 */
function criteriaSections(
  headings: readonly MarkdownHeading[],
  total: number,
): FunctionalSection[] {
  return functionalSections(headings, total).filter(
    (section) => section.key === ACCEPTANCE_CRITERIA_KEY,
  );
}

/**
 * Spec paths on the `Derived from` lines of the header blockquote — the block
 * between the title and the first `##` section. Bounded there so a plan that
 * quotes the marker inside its own prose does not re-declare its origin.
 */
function derivedFromNumbers(text: string, specPath: RegExp): string[] {
  const { lines, fenced, headings } = scanMarkdown(text);
  const firstSection = headings.find((h) => h.level >= 2);
  const end = firstSection?.line ?? lines.length;

  const found: string[] = [];
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (line === undefined || fenced[i] === true) continue;
    if (!DERIVED_FROM_RE.test(line)) continue;
    found.push(...matchNumbers(line, specPath));
  }
  return dedupe(found);
}

/**
 * Whether the plan DECLARES itself standalone in its header blockquote.
 *
 * Bounded exactly where `Derived from` and `> Baseline:` are bounded — between
 * the title and the first `##`, fences excluded — because that is the one place
 * a plan speaks about its own provenance. Anywhere else the same words are prose
 * ABOUT the marker: a plan explaining in `## Origin` that "los planes standalone
 * llevan `> Standalone: …`" is documenting the grammar, not adopting it.
 *
 * A marker with no value (`> Standalone:`) declares nothing, so it is not one.
 * The point of the value is that the next reader learns WHERE the plan came from
 * without a spec to open, and an empty label answers that with silence.
 */
function declaresStandalone(text: string): boolean {
  const { lines, fenced, headings } = scanMarkdown(text);
  const firstSection = headings.find((h) => h.level >= 2);
  const end = firstSection?.line ?? lines.length;
  for (let i = 0; i < end; i += 1) {
    const line = lines[i];
    if (line === undefined || fenced[i] === true) continue;
    if ((STANDALONE_LABEL.exec(line)?.[1] ?? "").trim().length > 0) return true;
  }
  return false;
}

/** Match a spec path under the workspace's declared documentary canon. */
function specPathPattern(specDir: string): RegExp {
  const escaped = specDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}/(${CORRELATIVE_SOURCE})-spec[^\\s\`)"']*\\.md`, "g");
}

function matchNumbers(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  // Fresh instance per call: the module-level literals carry /g, whose lastIndex
  // would otherwise leak between documents.
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const number = match[1];
    if (number !== undefined) found.push(number);
  }
  return dedupe(found);
}

function dedupe(numbers: string[]): string[] {
  return [...new Set(numbers)].sort(compareCorrelatives);
}
