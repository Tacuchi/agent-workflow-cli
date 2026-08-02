import { ARTIFACT_REF_GLOBAL, CRITERION_GLOBAL } from "./identity.js";
import type { Reader } from "./validation.js";

/**
 * The Markdown body contract of Flow and Screen Specifications v1.
 *
 * The frontmatter is what machines read; the body is what people read. The
 * contract on the body exists so the two cannot drift: a fixed list of headings,
 * each exactly once and in order, each with real text — and no way to satisfy it
 * by typing "N/A".
 *
 * Marking something inapplicable is a FRONTMATTER act (`not_applicable.<key>`
 * with a reason) and only for the conditional sections. The heading still has to
 * be there with prose explaining it: the machine-readable reason and the human
 * explanation are two audiences, not two chances to say nothing.
 */

/** The two Markdown document kinds. Narrower than the catalog's artifact kinds. */
export type DesignDocKind = "flow" | "screen";

/** Flow v1 — once each, in this order. */
export const FLOW_HEADINGS = [
  "Goal and outcome",
  "Preconditions and entry",
  "Main journey",
  "Alternatives and recovery",
  "Permissions and privacy",
  "Traceability",
] as const;

/** Screen v1 — once each, in this order. */
export const SCREEN_HEADINGS = [
  "Purpose and context",
  "Structure and content",
  "Components and design-system deltas",
  "Data, permissions and validation",
  "States and transitions",
  "Interaction and navigation",
  "Responsive and adaptation",
  "Localization",
  "Accessibility",
  "Edge cases and degradation",
  "Traceability",
] as const;

/**
 * The sections that never accept a non-applicability claim. They carry what the
 * artifact IS: drop them and there is nothing left to implement against.
 */
export const ESSENTIAL_HEADINGS: Record<DesignDocKind, readonly string[]> = {
  flow: ["Goal and outcome", "Main journey", "Traceability"],
  screen: [
    "Purpose and context",
    "Structure and content",
    "States and transitions",
    "Interaction and navigation",
    "Accessibility",
    "Traceability",
  ],
};

export const HEADINGS: Record<DesignDocKind, readonly string[]> = {
  flow: FLOW_HEADINGS,
  screen: SCREEN_HEADINGS,
};

/** `Data, permissions and validation` → `data_permissions_and_validation`. */
export function headingKey(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** The `not_applicable` keys each kind admits — derived from its own headings. */
export function conditionalKeys(kind: DesignDocKind): string[] {
  const essential = new Set(ESSENTIAL_HEADINGS[kind]);
  return HEADINGS[kind].filter((h) => !essential.has(h)).map(headingKey);
}

/**
 * Placeholders that look like an answer and are not. A section may legitimately
 * say "ninguno" or "none" — that is a statement about the design. `N/A`, `TBD`
 * and a lone dash are refusals to answer, and the contract has a proper place
 * for those: `not_applicable` with a reason.
 */
export const PLACEHOLDER = /^(n\/?a\.?|n\.a\.|tbd|todo|pendiente|\?+|[-–—*]+)$/i;

export interface BodySection {
  heading: string;
  key: string;
  /** Everything under the heading, trimmed — what "non-empty" is measured on. */
  text: string;
  /**
   * The same text with fenced blocks removed. Cross-validation harvests from
   * HERE: a fenced example of a frontmatter is documentation, not a claim, and
   * treating its references as real would make every doc that teaches the format
   * fail its own contract.
   */
  prose: string;
  /** 1-based line of the heading, for the diagnostic. */
  line: number;
}

export interface ParsedBody {
  sections: BodySection[];
  /** `##` headings in the order they appear, including unknown ones. */
  order: string[];
  /**
   * Content before the first `##`, other than a single `# H1`. It belongs to no
   * section, so it is harvested with the rest instead of escaping every check —
   * banning it would be a rule the contract never states.
   */
  preamble: string;
}

/** Split the body into its `##` sections. `#`/`###` are content, not structure. */
export function parseBody(body: string, firstLine: number): ParsedBody {
  const lines = body.split(/\r?\n/);
  const sections: BodySection[] = [];
  const order: string[] = [];
  const preamble: string[] = [];
  let current: { heading: string; line: number; text: string[] } | null = null;
  let fence: string | null = null;

  const close = (): void => {
    if (current === null) return;
    const text = current.text.join("\n").trim();
    sections.push({
      heading: current.heading,
      key: headingKey(current.heading),
      text,
      prose: stripFences(current.text).join("\n").trim(),
      line: current.line,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    fence = trackFence(line, fence);
    const match = fence === null ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (match === null) {
      if (current !== null) current.text.push(line);
      else if (line.trim().length > 0 && !/^#\s+/.test(line)) preamble.push(line.trim());
      continue;
    }
    close();
    const heading = match[1] as string;
    order.push(heading);
    current = { heading, line: firstLine + i, text: [] };
  }
  close();
  return { sections, order, preamble: preamble.join("\n") };
}

/** Track ``` and ~~~ fences. Returns the open fence marker, or null outside one. */
function trackFence(line: string, open: string | null): string | null {
  const match = /^\s*(```+|~~~+)/.exec(line);
  if (match === null) return open;
  const marker = (match[1] as string).slice(0, 3);
  if (open === null) return marker;
  return marker === open ? null : open;
}

function stripFences(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const next = trackFence(line, fence);
    if (fence === null && next !== null) {
      fence = next;
      continue;
    }
    if (fence !== null) {
      if (next === null) fence = null;
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * The heading contract: the expected list, once each, in order, non-empty, with
 * no placeholder standing in for content and no heading nobody declared.
 */
export function checkHeadings(
  r: Reader,
  parsed: ParsedBody,
  kind: DesignDocKind,
  artifact: string,
): void {
  checkPresence(r, parsed, kind, artifact);
  checkOrder(r, parsed, kind, artifact);
  checkContent(r, parsed, kind, artifact);
}

/** Every expected heading exactly once, and nothing the contract does not name. */
function checkPresence(r: Reader, parsed: ParsedBody, kind: DesignDocKind, artifact: string): void {
  const expected = HEADINGS[kind];
  const expectedSet = new Set<string>(expected);
  const seen = new Map<string, number>();

  for (const heading of parsed.order) {
    seen.set(heading, (seen.get(heading) ?? 0) + 1);
    if (expectedSet.has(heading)) continue;
    r.fail(
      "DESIGN_HEADING_UNKNOWN",
      artifact,
      `'## ${heading}' no es una sección de ${kind} v1`,
      `usá solo las ${expected.length} secciones del contrato: ${expected.join(" · ")}`,
    );
  }

  for (const heading of expected) {
    const count = seen.get(heading) ?? 0;
    if (count === 0) {
      r.fail(
        "DESIGN_HEADING_MISSING",
        artifact,
        `falta la sección '## ${heading}'`,
        "escribila con texto propio; omitirla no la vuelve no aplicable",
      );
    } else if (count > 1) {
      r.fail(
        "DESIGN_HEADING_DUPLICATE",
        artifact,
        `'## ${heading}' aparece ${count} veces`,
        "dejá una sola y fusioná su contenido",
      );
    }
  }
}

/**
 * Order is only meaningful over the headings actually present and expected —
 * reporting it on top of a missing heading would be noise on top of noise.
 */
function checkOrder(r: Reader, parsed: ParsedBody, kind: DesignDocKind, artifact: string): void {
  const expected = HEADINGS[kind];
  const expectedSet = new Set<string>(expected);
  const present = parsed.order.filter((h) => expectedSet.has(h));
  const canonical = expected.filter((h) => present.includes(h));
  if (present.length !== canonical.length) return;
  if (present.join("\n") === canonical.join("\n")) return;
  r.fail(
    "DESIGN_HEADING_ORDER",
    artifact,
    `las secciones están fuera de orden: ${present.join(" · ")}`,
    `el orden de ${kind} v1 es: ${canonical.join(" · ")}`,
  );
}

/** Each section carries real text — never empty, never a placeholder. */
function checkContent(r: Reader, parsed: ParsedBody, kind: DesignDocKind, artifact: string): void {
  const expectedSet = new Set<string>(HEADINGS[kind]);
  for (const section of parsed.sections) {
    if (!expectedSet.has(section.heading)) continue;
    if (section.text.length === 0) {
      r.fail(
        "DESIGN_SECTION_EMPTY",
        artifact,
        `'## ${section.heading}' (línea ${section.line}) no tiene texto`,
        "cada sección lleva texto propio coherente con el frontmatter",
      );
      continue;
    }
    if (!PLACEHOLDER.test(section.text)) continue;
    r.fail(
      "DESIGN_SECTION_PLACEHOLDER",
      artifact,
      `'## ${section.heading}' (línea ${section.line}) dice solo '${section.text}'`,
      isEssential(kind, section.heading)
        ? "esta sección es esencial y no admite no-aplicabilidad: escribí su contenido"
        : `si de verdad no aplica, declaralo en 'not_applicable.${section.key}' con una razón, y explicalo acá`,
    );
  }
}

export function isEssential(kind: DesignDocKind, heading: string): boolean {
  return ESSENTIAL_HEADINGS[kind].includes(heading);
}

/**
 * Canonical references the body cites, in document order and deduplicated.
 *
 * Only the exact `DES-NNN/XXX-NNN@rN[#anchor]` form is extracted — never prose.
 * That is the whole point: cross-validation may not depend on reading a
 * sentence, so anything the author writes informally is simply not a reference.
 */
export function bodyReferences(parsed: ParsedBody): string[] {
  return harvest(parsed, ARTIFACT_REF_GLOBAL);
}

/** Acceptance criteria the body cites, in document order and deduplicated. */
export function bodyCriteria(parsed: ParsedBody): string[] {
  return harvest(parsed, CRITERION_GLOBAL);
}

/** Asset digests the body cites. Same closed grammar as everywhere else. */
export function bodyDigests(parsed: ParsedBody): string[] {
  return harvest(parsed, /sha256:[0-9a-f]{64}/g);
}

function harvest(parsed: ParsedBody, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const prose of [parsed.preamble, ...parsed.sections.map((s) => s.prose)]) {
    for (const match of prose.matchAll(pattern)) {
      if (!out.includes(match[0])) out.push(match[0]);
    }
  }
  return out;
}
