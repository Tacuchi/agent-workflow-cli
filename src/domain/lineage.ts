import { CORRELATIVE_SOURCE } from "./correlative.js";
import { CRITERION_GLOBAL, isDigest } from "./design/identity.js";
import { baseDigest } from "./proposal.js";

/**
 * The lineage between a SPEC and the PLANs derived from it, sealed rather than
 * named.
 *
 * A plan has always been able to say WHICH spec it came from — that is
 * `parseSpecRelation`, and it answers by number. What it could not say is
 * WHICH VERSION: a spec re-refined the day after its plan was derived leaves
 * the plan pointing at a document that no longer says what the plan was built
 * from, and nothing anywhere notices. "Same number" is not "same contract".
 *
 * The seal closes that. It is deliberately the same shape the design subsystem
 * already uses for a baseline — an identity, a path HINT and a digest
 * (`SpecDesignReference`) — because a second convention for "the exact bytes I
 * closed on" is a comparison that fails for a reason nobody can see.
 *
 * It is ADDITIVE on purpose. A parser that demanded the line would make every
 * plan written before it unexecutable, so its absence is a diagnostic
 * (`absent` → `sin sello`), never an error. What is NOT tolerated is a line
 * that is present and wrong: that reads `malformed`, never `absent`, because
 * silently degrading a typo into "no seal" hides the one case where somebody
 * believed they had sealed something.
 */

/** The exact spec content a plan was derived from. */
export interface SpecBaseline {
  /** Workspace-relative path of the spec when the plan was sealed — a HINT. */
  path: string;
  /** The spec's correlative, read from that path. It, not the path, is the identity. */
  number: string;
  /** {@link baseDigest} over the spec's exact bytes at derivation time. */
  digest: string;
}

/** What a plan's header blockquote declares about its baseline. */
export type PlanBaselineSeal =
  | { status: "sealed"; baseline: SpecBaseline }
  | { status: "malformed"; raw: string; why: string; action: string }
  | { status: "absent" };

/**
 * How a sealed plan stands against the spec's CURRENT content.
 *
 * `unsealed` is a first-class answer and never collapses into `aligned`: a plan
 * that never sealed anything cannot be alignment-checked, and reporting it as
 * aligned would be asserting a comparison that was never made.
 */
export type BaselineAlignment =
  | { status: "aligned"; digest: string }
  | { status: "divergent"; sealed_digest: string; current_digest: string }
  | { status: "unsealed" }
  | { status: "malformed"; why: string; action: string }
  | { status: "unresolved"; reason: "spec-not-found"; path: string };

const BASELINE_LABEL = /^\s*>\s*Baseline:\s*(.+?)\s*$/i;

/** `<spec path>@sha256:<64 hex>` — the path is the hint, the digest is the seal. */
const BASELINE_VALUE = /^(\S+?)@(sha256:[0-9a-fA-F]+)$/;

/**
 * The digest of a spec's bytes, in the ONE form this system writes.
 *
 * `sha256:`-prefixed because that is what `isDigest` accepts and what every
 * design baseline already publishes. A bare-hex second spelling would be a
 * comparison that fails for a reason nobody can see — the exact failure
 * `baseDigest` exists to prevent, one level up.
 */
export function specBaselineDigest(specText: string): string {
  return `sha256:${baseDigest(specText)}`;
}

/** The line a publication writes into the plan's header blockquote. */
export function formatSpecBaseline(baseline: SpecBaseline): string {
  return `> Baseline: ${baseline.path}@${baseline.digest}`;
}

/**
 * Read the seal from a plan's header blockquote.
 *
 * Bounded to the block between the title and the first `##` section, exactly
 * like `Derived from`: a plan that quotes the marker inside its own prose is
 * describing the contract, not declaring its own lineage.
 */
export function parsePlanBaseline(
  lines: readonly string[],
  fenced: readonly boolean[],
  end: number,
  specDir: string,
): PlanBaselineSeal {
  for (let i = 0; i < end; i += 1) {
    const line = lines[i];
    if (line === undefined || fenced[i] === true) continue;
    const labelled = BASELINE_LABEL.exec(line);
    if (labelled === null) continue;
    return readBaselineValue(labelled[1] ?? "", specDir);
  }
  return { status: "absent" };
}

function readBaselineValue(raw: string, specDir: string): PlanBaselineSeal {
  const value = raw.replace(/^`|`$/g, "").trim();
  const parts = BASELINE_VALUE.exec(value);
  if (parts === null) {
    return {
      status: "malformed",
      raw: value,
      why: "no tiene la forma '<ruta de la spec>@sha256:<64 hex>'",
      action: `escribí '> Baseline: ${specDir}/NNN-spec-<slug>.md@sha256:<64 hex>'`,
    };
  }
  const path = parts[1] as string;
  const digest = (parts[2] as string).toLowerCase();
  if (!isDigest(digest)) {
    return {
      status: "malformed",
      raw: value,
      why: "el digest no es 'sha256:' seguido de 64 hex",
      action: "volvé a sellar el plan desde la spec que consumió",
    };
  }
  const number = correlativeOfSpecPath(path, specDir);
  if (number === null) {
    return {
      status: "malformed",
      raw: value,
      why: `la ruta no es una spec bajo '${specDir}/'`,
      action: `apuntá el baseline a un documento de '${specDir}/'`,
    };
  }
  return { status: "sealed", baseline: { path, number, digest } };
}

function correlativeOfSpecPath(path: string, specDir: string): string | null {
  const escaped = specDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}/(${CORRELATIVE_SOURCE})-spec[^\\s]*\\.md$`);
  return re.exec(path)?.[1] ?? null;
}

/**
 * The plan text with its baseline sealed — inserted when absent, corrected when
 * it says anything else.
 *
 * The seal is written by PUBLICATION, not by whoever authored the document: a
 * digest is not something an author can be asked to compute by hand, and a
 * baseline that is optional in practice is a baseline that drifts. Returning the
 * text (rather than writing it) is what keeps it inside the SAME proposal that
 * publishes the plan — the stamped bytes are the ones previewed, approved and
 * written, so no reader ever sees a published plan whose seal landed separately.
 *
 * The line goes into the header blockquote, right after `Derived from`: the two
 * belong together — one names the spec, the other pins its version.
 */
export function withSpecBaseline(planText: string, baseline: SpecBaseline): string {
  const line = formatSpecBaseline(baseline);
  const lines = planText.split("\n");
  const end = headerBlockEnd(lines);
  let lastQuote = -1;
  let derivedAt = -1;
  for (let i = 0; i < end; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (!/^\s*>/.test(raw)) continue;
    lastQuote = i;
    if (BASELINE_LABEL.test(raw)) {
      if (raw === line) return planText;
      lines[i] = line;
      return lines.join("\n");
    }
    if (/derived from/i.test(raw)) derivedAt = i;
  }
  const at = derivedAt >= 0 ? derivedAt + 1 : lastQuote + 1;
  // No blockquote at all: the document does not have the header this seal lives
  // in, and inventing one would restructure somebody's plan to fit a field.
  if (lastQuote < 0) return planText;
  lines.splice(at, 0, line);
  return lines.join("\n");
}

/** Index of the first `##` section, or the end — the header block's bound. */
function headerBlockEnd(lines: readonly string[]): number {
  let fenced = false;
  for (const [index, raw] of lines.entries()) {
    if (raw === undefined) continue;
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^##\s/.test(raw)) return index;
  }
  return lines.length;
}

/**
 * The seal against the spec as it reads NOW.
 *
 * `specText` is `null` when the workspace holds no such spec: that is
 * `unresolved`, not `divergent` — a document that is not there did not change,
 * and saying it did would send whoever reads it to diff against nothing.
 */
export function alignSpecBaseline(
  seal: PlanBaselineSeal,
  specText: string | null,
): BaselineAlignment {
  if (seal.status === "absent") return { status: "unsealed" };
  if (seal.status === "malformed") {
    return { status: "malformed", why: seal.why, action: seal.action };
  }
  if (specText === null) {
    return { status: "unresolved", reason: "spec-not-found", path: seal.baseline.path };
  }
  const current = specBaselineDigest(specText);
  if (current === seal.baseline.digest) return { status: "aligned", digest: current };
  return {
    status: "divergent",
    sealed_digest: seal.baseline.digest,
    current_digest: current,
  };
}

/**
 * The acceptance criteria a spec states, in document order and without
 * duplicates.
 *
 * The grammar is NOT a second one: it is `CRITERION_GLOBAL`, the same closed
 * form the design subsystem already harvests (`S033/AC-01`, `S013/AC-SEM-11`).
 * A note that has to say WHICH assertion it replaces addresses it with this and
 * nothing else — inventing a parallel syntax is how two ids for one criterion
 * start disagreeing.
 */
export function specCriteria(lines: readonly string[], fenced: readonly boolean[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === undefined || fenced[index] === true) continue;
    // Fresh instance per line: the shared literal carries /g, whose lastIndex
    // would otherwise leak between lines.
    for (const match of line.matchAll(
      new RegExp(CRITERION_GLOBAL.source, CRITERION_GLOBAL.flags),
    )) {
      const id = match[0];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
