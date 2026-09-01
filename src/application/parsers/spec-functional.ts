import { specBaselineDigest } from "../../domain/lineage.js";
import { type MarkdownHeading, bilingualAliases, scanMarkdown } from "../markdown.js";
import { semanticDigest } from "../semantic-operation/protocol.js";

/**
 * WHAT a spec promises, separated from HOW its document happens to read.
 *
 * A plan seals which VERSION of its spec it derives from, and until now that
 * seal digested the spec's exact bytes. The consequence was not theoretical: a
 * comma, a reordered list or a line rewrapped in `## Context` turned every plan
 * of that spec `divergent`, a divergent plan cannot close
 * (`PLAN_EXEC_DONE_BASELINE_INVALID`), and the only repair was a full
 * `/w:plan-refine` per consumer. Editing prose is not amending a contract, so
 * the two must not produce the same verdict.
 *
 * So the seal digests a PAYLOAD: the spec cut down to the sections that state
 * the contract, normalized so that bookkeeping and typography cannot move it.
 * The rules below ARE the contract — whoever changes one of them by accident
 * turns plans that were fine into divergent ones, which is exactly the failure
 * this module exists to end.
 */

/**
 * The H2 sections that carry the functional contract. First entry of each group
 * is the canonical key the payload uses; the rest are accepted spellings.
 *
 * An ALLOWLIST and not a denylist, because the failure modes are asymmetric: a
 * new editorial section (`## Notes`, `## Glossary`) silently entering the payload
 * would resurrect the very divergence this closes, while a new FUNCTIONAL
 * section left out of it is caught the first time somebody notices the digest
 * did not move — and that is a fix, not a false alarm.
 *
 * The bilingual half is taken from {@link bilingualAliases}: `Requirement` and
 * `Acceptance criteria` already have their accepted spellings enumerated in the
 * markdown keyword table, and a second copy here is how two lists of one
 * heading's names start disagreeing.
 */
const DECLARED_SECTIONS: ReadonlyArray<readonly string[]> = [
  ["Requirement"],
  ["Scope", "Alcance"],
  ["Acceptance criteria"],
  ["Scenarios", "Escenarios"],
  ["Behavioral changes", "Cambios de comportamiento"],
  ["Affected capabilities", "Capacidades afectadas"],
];

/**
 * The declared groups widened with the keyword table's spellings — the ONE list
 * the alias index below is built from, and deliberately not exported: a second
 * reader of the section names is a second answer to "is this section contract",
 * and the only answer that decides anything is {@link CANONICAL_BY_ALIAS}.
 */
const FUNCTIONAL_SECTIONS: ReadonlyArray<readonly string[]> = DECLARED_SECTIONS.map((group) => [
  ...new Set([...group, ...bilingualAliases(group[0] as string)]),
]);

/** Heading names compare accent- and case-insensitively, like the keyword table. */
function normalizeHeading(title: string): string {
  return title.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** Every accepted spelling → the canonical key its section writes in the payload. */
const CANONICAL_BY_ALIAS = new Map<string, string>();
for (const group of FUNCTIONAL_SECTIONS) {
  const canonical = (group[0] as string).toLowerCase();
  for (const alias of group) CANONICAL_BY_ALIAS.set(normalizeHeading(alias), canonical);
}

/**
 * The canonical key of the criteria checklist — the ONE section whose item
 * labels are addressable assertions.
 *
 * Exported so `parseSpecCriteria` locates that checklist with THIS module's
 * answer instead of its own: the seal and the harvest disagreeing about where
 * the criteria are means a criterion sealed as contract that no note can
 * address (`CONTRACT_ASSERTION_ABSENT` about a criterion the spec states), which
 * leaves the plan `inconsistent` with nothing to correct.
 */
export const ACCEPTANCE_CRITERIA_KEY = "acceptance criteria";

/** One allowlisted section of a spec: its canonical key and the bounds of its body. */
export interface FunctionalSection {
  /** The canonical payload key — `"requirement"`, `"acceptance criteria"`, … */
  key: string;
  /** First line of the body; the heading itself is not part of it. */
  start: number;
  /** One past the last line of the body. */
  end: number;
}

/**
 * The allowlisted sections this spec declares, in document order, one entry per
 * APPEARANCE.
 *
 * A section repeated in the document yields one entry per occurrence rather than
 * the first: taking only the first would seal the later block's text while no
 * reader of the section could see it — and the criteria harvest is such a
 * reader, so a criterion in the second block would be contract and unaddressable
 * at the same time.
 *
 * A section ends at the next heading of the SAME level or shallower. A deeper
 * one belongs to the body, and that is not a detail: doctrine's own template
 * writes every scenario as `### Scenario: <name>` under `## Scenarios`, so
 * ending the section at any heading would empty the one section that states
 * behavior concretely — and rewriting a THEN would then be editorial.
 */
export function functionalSections(
  headings: readonly MarkdownHeading[],
  total: number,
): FunctionalSection[] {
  const out: FunctionalSection[] = [];
  for (const [index, heading] of headings.entries()) {
    if (heading.level !== 2) continue;
    const key = CANONICAL_BY_ALIAS.get(normalizeHeading(heading.title));
    if (key === undefined) continue;
    const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
    out.push({ key, start: heading.line + 1, end: next?.line ?? total });
  }
  return out;
}

/** `- [x]` / `- [X]` at the head of a collapsed line — a tick, not a promise. */
const TICKED_BOX = /^([-*+]) \[[xX]\]/;

/**
 * The functional sections of a spec, keyed by canonical heading and normalized.
 *
 * An OBJECT and not an array, deliberately: {@link semanticDigest} sorts object
 * keys, so REORDERING the document's sections is editorial and does not move the
 * digest — while moving text from `## Scope` to `## Acceptance criteria` does,
 * because the text lands under a different key.
 *
 * Line by line, and only OUTSIDE fenced code blocks:
 * - `trim()`, and internal runs of spaces/tabs collapsed to one — rewrapping and
 *   trailing whitespace are how a document reads, not what it promises;
 * - `- [x]` → `- [ ]`, because ticking a criterion is bookkeeping: the spec goes
 *   on stating it, and every plan of that spec would otherwise diverge the
 *   moment somebody marked one;
 * - runs of blank lines collapsed to one, and the blank borders of each section
 *   dropped.
 *
 * Inside a fence every line is kept VERBATIM except its line ending: a fenced
 * block is a literal — a payload shape, a command, an expected output — where
 * a space is promised, but the `\r` of a CRLF checkout is the filesystem's,
 * not the spec's.
 *
 * A section that is absent is omitted rather than keyed to an empty string, so a
 * spec that never had `## Scenarios` digests the same as one that never will. A
 * section that appears twice is concatenated in document order.
 */
export function functionalSpecPayload(specText: string): Record<string, string> {
  const { lines, fenced, headings } = scanMarkdown(specText);
  const payload: Record<string, string> = {};
  for (const section of functionalSections(headings, lines.length)) {
    const body = normalizeBody(lines, fenced, section.start, section.end);
    const previous = payload[section.key];
    payload[section.key] = previous === undefined ? body : `${previous}\n${body}`;
  }
  return payload;
}

/**
 * The digest a plan's baseline seals — `sha256:<64 hex>`, the SAME shape the
 * byte-exact digest published.
 *
 * The form does not change on purpose: `BASELINE_VALUE`, `isDigest` and a note's
 * anchor all read that shape, and this is a legitimate sha256 — of the payload
 * instead of the file. A second prefix would cost a regex, the note validators
 * and three messages for no reading anybody gains.
 *
 * An EMPTY payload degrades to the byte-exact digest, and that is a safe
 * degradation and not a border case somebody tolerated. A payload with no
 * sections digests to one CONSTANT shared by every spec in that state, so a plan
 * sealed against it stays `aligned` no matter what is done to its spec —
 * including rewriting or emptying the whole document. And the state is reachable
 * without anybody declaring a spec without a contract: one UNCLOSED fence in
 * `## Context` marks the rest of the file as fenced, so `scanMarkdown` sees no
 * further heading and every allowlisted section disappears at once. Falling back
 * here makes the seal sensitive to any edit again, so that state is not left
 * indistinguishable from a spec that genuinely declares no contract:
 * {@link unclosedSpecFence} names it, and whoever reports a divergence or
 * prepares a re-seal says WHICH fence to close instead of sending somebody to
 * diff a spec that did not change.
 */
export function functionalSpecDigest(specText: string): string {
  const payload = functionalSpecPayload(specText);
  if (Object.keys(payload).length === 0) return specBaselineDigest(specText);
  return `sha256:${semanticDigest(payload)}`;
}

/**
 * The line where this spec left a fence open, or `null` — 0-based, like
 * {@link MarkdownHeading.line}.
 *
 * The ONE observable for the state described on {@link functionalSpecDigest}: an
 * empty payload can mean "no contract declared" or "one fence swallowed the
 * document", and the two need opposite corrections. A number rather than a
 * status type because the index already distinguishes them and a second sum type
 * would be a vocabulary nobody reads.
 */
export function unclosedSpecFence(specText: string): number | null {
  return scanMarkdown(specText).unclosedFence;
}

/** A line of a section's body, and whether a fence made it untouchable. */
interface PayloadLine {
  text: string;
  verbatim: boolean;
}

/** One section's body under the rules documented on {@link functionalSpecPayload}. */
function normalizeBody(
  lines: readonly string[],
  fenced: readonly boolean[],
  start: number,
  end: number,
): string {
  const out: PayloadLine[] = [];
  for (let i = start; i < end; i += 1) {
    const verbatim = fenced[i] === true;
    const raw = lines[i] ?? "";
    const line: PayloadLine = {
      verbatim,
      text: verbatim ? raw.replace(/\r$/, "") : normalizeLine(raw),
    };
    if (dropped(line, out[out.length - 1])) continue;
    out.push(line);
  }
  // The section's trailing blanks: a heading followed by whitespace before the
  // next one must digest as the same section as one followed by none.
  while (isBlank(out[out.length - 1])) out.pop();
  return out.map((line) => line.text).join("\n");
}

/** A blank the payload does not keep: the section's leading one, or a repeat. */
function dropped(line: PayloadLine, previous: PayloadLine | undefined): boolean {
  if (!isBlank(line)) return false;
  return previous === undefined || isBlank(previous);
}

/** Blank AND collapsible: an empty line inside a fence is content. */
function isBlank(line: PayloadLine | undefined): boolean {
  return line !== undefined && !line.verbatim && line.text.length === 0;
}

function normalizeLine(raw: string): string {
  return raw
    .trim()
    .replace(/[ \t]+/g, " ")
    .replace(TICKED_BOX, "$1 [ ]");
}
