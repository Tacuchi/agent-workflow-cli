import { parseMdSectionBilingual, scanMarkdown } from "../markdown.js";

/**
 * Which kind of evidence tied a plan to its spec. Ordered by how explicit the
 * declaration is — see {@link parseSpecRelation}.
 */
export type SpecEvidence = "derived-from" | "origin-path" | "spec-reference";

export type ParsedSpecRelation =
  | { status: "declared"; number: string; evidence: SpecEvidence }
  | { status: "ambiguous"; numbers: string[]; evidence: SpecEvidence }
  | { status: "absent" };

// Spec documents are `docs/specs/NNN-spec-<slug>.md`; the trailing character
// class stops at the punctuation that surrounds a path in prose (backticks,
// parens, quotes) so a Markdown link or an inline-code path still matches.
const SPEC_PATH_RE = /docs\/specs\/(\d{3})-spec[^\s`)"']*\.md/g;

// `Spec 011` / `spec 011` — a bare number is NOT evidence: `sesión 047` and
// `baseline 044` would match it, and the whole point is to never guess.
const SPEC_REFERENCE_RE = /\bspec\s+(\d{3})\b/gi;

const DERIVED_FROM_RE = /derived from/i;

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
 *
 * Two different specs at the same level is `ambiguous`, not a coin flip:
 * a human wrote something contradictory and only a human should settle it.
 */
export function parseSpecRelation(text: string): ParsedSpecRelation {
  const origin = parseMdSectionBilingual(text, "Origin") ?? "";
  const levels: ReadonlyArray<{ evidence: SpecEvidence; numbers: string[] }> = [
    { evidence: "derived-from", numbers: derivedFromNumbers(text) },
    { evidence: "origin-path", numbers: matchNumbers(origin, SPEC_PATH_RE) },
    { evidence: "spec-reference", numbers: matchNumbers(origin, SPEC_REFERENCE_RE) },
  ];

  for (const { evidence, numbers } of levels) {
    const [first] = numbers;
    if (first === undefined) continue;
    if (numbers.length === 1) return { status: "declared", number: first, evidence };
    return { status: "ambiguous", numbers, evidence };
  }
  return { status: "absent" };
}

/**
 * Spec paths on the `Derived from` lines of the header blockquote — the block
 * between the title and the first `##` section. Bounded there so a plan that
 * quotes the marker inside its own prose does not re-declare its origin.
 */
function derivedFromNumbers(text: string): string[] {
  const { lines, fenced, headings } = scanMarkdown(text);
  const firstSection = headings.find((h) => h.level >= 2);
  const end = firstSection?.line ?? lines.length;

  const found: string[] = [];
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (line === undefined || fenced[i] === true) continue;
    if (!DERIVED_FROM_RE.test(line)) continue;
    found.push(...matchNumbers(line, SPEC_PATH_RE));
  }
  return dedupe(found);
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
  return [...new Set(numbers)].sort();
}
