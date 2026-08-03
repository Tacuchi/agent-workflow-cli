/**
 * What `design` accepts as a source, and what happens to each one.
 *
 * The envelope already carries WHICH inputs an invocation declared and where
 * they came from — that is the capability contract's job, and it is not redone
 * here. What this module owns is the design domain's half: which KINDS of
 * source v1 can actually read, what a reading produced, and what it costs when
 * one of them could not be read.
 *
 * The disposition vocabulary is five values because the four ways a source can
 * fail to contribute are not the same problem for whoever has to fix it:
 * `skipped` is a decision, `unsupported` is a format nobody promised,
 * `unavailable` is something that should have been there and was not, and
 * `redacted` is a deliberate withholding. Collapsing them into "not used" would
 * make the receipt say four different things with one word.
 *
 * The consequence is fail-closed on purpose: a source that did not contribute
 * blocks `handoff` unless someone states, in writing, why the design does not
 * need it. A design that silently dropped a requirements document and still
 * declared itself ready for implementation is precisely the failure the
 * provenance exists to prevent.
 */

import type { InputProvenance } from "../capability/protocol.js";
import type { DesignFailure } from "./validation.js";

/**
 * The v1 source catalog. Binary documents are read by the HOST's multimodal
 * capability — the CLI ships no PDF, DOCX or PPTX parser — so what this list
 * declares is what the domain KNOWS HOW TO ACCOUNT FOR, not what the CLI can
 * decode by itself.
 */
export const DESIGN_SOURCE_KINDS = [
  "markdown",
  "image",
  "pdf",
  "docx",
  "pptx",
  /** Conversation or attachments the host exposed, passed in explicitly. */
  "host_context",
  /** An existing UI Design Package, by identity. */
  "package",
  /** A provider reference (`file_key`, `project_id`, an artifact id…). */
  "provider_locator",
] as const;

export type DesignSourceKind = (typeof DESIGN_SOURCE_KINDS)[number];

export const SOURCE_DISPOSITIONS = [
  /** Read, and its content reached the design. */
  "used",
  /** Deliberately not read. A decision, and it carries its reason. */
  "skipped",
  /** A format v1 does not accept — including every retired UI format. */
  "unsupported",
  /** It should have been readable and was not: missing, corrupt, unreachable. */
  "unavailable",
  /** Withheld on purpose: sensitive, and the invocation did not authorize it. */
  "redacted",
] as const;

export type SourceDisposition = (typeof SOURCE_DISPOSITIONS)[number];

export interface DesignSource {
  /** The declared input this source arrived as. */
  name: string;
  kind: DesignSourceKind;
  /** Safe locator or the caller-declared origin. */
  locator: string;
  disposition: SourceDisposition;
  /** Why it did not contribute. Required for every disposition but `used`. */
  reason: string | null;
  /**
   * What reading it produced — an extracted section, a transcribed screen, a
   * token table. Enough to repeat or audit the extraction, which a digest of
   * the original alone never gives you.
   */
  derived: string[];
  sensitivity: InputProvenance["sensitivity"];
  /**
   * Whether the design can be complete without it. Defaults to essential:
   * assuming a source is optional is how a dropped requirement becomes a
   * `handoff` nobody can trace back.
   */
  essential: boolean;
}

/** Extension → kind, for the locators that carry one. */
const BY_EXTENSION: ReadonlyMap<string, DesignSourceKind> = new Map([
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["txt", "markdown"],
  ["png", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["webp", "image"],
  ["gif", "image"],
  ["svg", "image"],
  ["pdf", "pdf"],
  ["docx", "docx"],
  ["pptx", "pptx"],
]);

/**
 * Classify a locator by what it looks like. Returns null when nothing in the
 * catalog matches — which the caller reports as `unsupported`, never as a guess.
 */
export function classifySource(locator: string): DesignSourceKind | null {
  const trimmed = locator.trim();
  if (trimmed.length === 0) return null;
  if (/^DES-(?:[0-9]{3}|[1-9][0-9]{3,})(?:@r[1-9][0-9]{0,5})?$/.test(trimmed)) return "package";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)) return "provider_locator";
  const extension = trimmed.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION.get(extension) ?? null;
}

export interface SourceReport {
  sources: DesignSource[];
  /** Sources that did not contribute, grouped for the receipt. */
  omitted: DesignSource[];
  /** True when an essential source did not contribute. */
  blocksHandoff: boolean;
  failures: DesignFailure[];
}

/**
 * Judge a set of sources: shape first, then consequence.
 *
 * A malformed record is a failure of the caller, not of the design — a source
 * that says it was skipped and does not say why cannot be reported at all, so
 * it is refused here rather than reaching a receipt that would read as if
 * nothing had been dropped.
 */
export function reportSources(sources: readonly DesignSource[], artifact: string): SourceReport {
  const failures: DesignFailure[] = [];
  for (const source of sources) {
    if (source.disposition !== "used" && (source.reason ?? "").trim().length === 0) {
      failures.push({
        code: "DESIGN_SOURCE_WITHOUT_REASON",
        artifact,
        message: `la fuente '${source.name}' quedó '${source.disposition}' y no dice por qué`,
        action: "declará la causa: una fuente descartada en silencio es una decisión invisible",
      });
    }
    if (!source.essential && (source.reason ?? "").trim().length === 0) {
      failures.push({
        code: "DESIGN_SOURCE_OPTIONAL_WITHOUT_REASON",
        artifact,
        message: `la fuente '${source.name}' se declara no esencial sin justificarlo`,
        action: "explicá por qué el diseño se sostiene sin ella, o dejala como esencial",
      });
    }
  }

  const omitted = sources.filter((s) => s.disposition !== "used");
  return {
    sources: [...sources],
    omitted,
    blocksHandoff: omitted.some((s) => s.essential),
    failures,
  };
}

/**
 * The gap an omission leaves behind.
 *
 * Actionable on purpose: it names the source, its disposition and its reason,
 * so the person reading the receipt knows what to go get rather than that
 * "something" was missing.
 */
export function handoffGapsFrom(report: SourceReport): string[] {
  return report.omitted
    .filter((s) => s.essential)
    .map(
      (s) =>
        // The LOCATOR, not just the input name: several sources arrive under one
        // declared input, so "the essential source 'sources' is missing" tells
        // nobody which file to go and get.
        `la fuente esencial '${s.locator}' (${s.kind}, input '${s.name}') quedó '${s.disposition}': ${s.reason ?? "sin causa"} — conseguila o declarala no esencial con su razón`,
    );
}

/**
 * Whether an original document may be copied into the package.
 *
 * The default is no, and that is a privacy decision rather than a storage one:
 * the sources of a design are often the least shareable thing in the room — a
 * contract draft, a screenshot with real customer data — and a package is meant
 * to be handed to a tool, an agency or a repository. Copying one in has to be
 * something a person asked for, on a source they named.
 *
 * The permission itself is not granted here: copying is a `local_additive`
 * effect, so the capability's authorization decides whether it happens at all.
 * This only says which sources were even eligible.
 *
 * **No production caller yet, and enumerated rather than hidden** (same
 * treatment the capability layer's caller sweep established): today NOTHING
 * copies an original, because the authoring path only ever writes the artifacts
 * the agent authored into the declared destinations. That is the production
 * fallback, and it is stricter than this gate — the gate is what the escape
 * hatch will have to pass through the day someone asks for one.
 */
export interface CopyOriginalsRequest {
  /** Source names the caller explicitly asked to keep. Empty is the default. */
  approved: readonly string[];
}

export type CopyDecision =
  | { ok: true; copy: DesignSource[] }
  | { ok: false; failure: DesignFailure };

export function planOriginalCopy(
  sources: readonly DesignSource[],
  request: CopyOriginalsRequest,
  artifact: string,
): CopyDecision {
  const byName = new Map(sources.map((s) => [s.name, s]));
  const copy: DesignSource[] = [];
  for (const name of request.approved) {
    const source = byName.get(name);
    if (source === undefined) {
      return {
        ok: false,
        failure: {
          code: "DESIGN_SOURCE_COPY_UNKNOWN",
          artifact,
          message: `se autorizó copiar '${name}' y no hay ninguna fuente con ese nombre`,
          action: `nombrá una de: ${[...byName.keys()].join(", ") || "(ninguna)"}`,
        },
      };
    }
    // Copying a source the run never managed to read would put a file in the
    // package that nothing in the design derives from.
    if (source.disposition !== "used") {
      return {
        ok: false,
        failure: {
          code: "DESIGN_SOURCE_COPY_UNUSED",
          artifact,
          message: `'${name}' quedó '${source.disposition}' y no se copia al package`,
          action: "copiá solo fuentes que el diseño usó de verdad",
        },
      };
    }
    if (source.sensitivity === "sensitive") {
      return {
        ok: false,
        failure: {
          code: "DESIGN_SOURCE_COPY_SENSITIVE",
          artifact,
          message: `'${name}' está clasificada sensible: no entra al package`,
          action: "desclasificala explícitamente o dejá solo su proveniencia",
        },
      };
    }
    copy.push(source);
  }
  return { ok: true, copy };
}
