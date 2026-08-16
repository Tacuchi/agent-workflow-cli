import { CORRELATIVE_SOURCE, compareCorrelatives } from "../../domain/correlative.js";
import { DEFAULT_CORE_DOCS_CANON } from "../../domain/docs-canon.js";
import { type PlanBaselineSeal, parsePlanBaseline, specCriteria } from "../../domain/lineage.js";
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

// `Spec 011` / `spec 011` — a bare number is NOT evidence: `sesión 047` and
// `baseline 044` would match it, and the whole point is to never guess.
const SPEC_REFERENCE_RE = new RegExp(`\\bspec\\s+(${CORRELATIVE_SOURCE})\\b`, "gi");

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
  return { status: "absent" };
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

/** The acceptance criteria a spec states, in order and without duplicates. */
export function parseSpecCriteria(text: string): string[] {
  const { lines, fenced } = scanMarkdown(text);
  return specCriteria(lines, fenced);
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
