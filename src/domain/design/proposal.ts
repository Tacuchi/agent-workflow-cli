import { parseBody } from "./artifact-body.js";
import { type DesignArtifact, splitDesignDocument, validateDesignArtifact } from "./artifact.js";
import { parseArtifactRef } from "./identity.js";
import type { RenderBundle } from "./render-bundle.js";
import {
  type RenditionSource,
  type StaleVerdict,
  checkSourcesStale,
  computeSourceDigest,
} from "./rendition.js";
import type { DesignFailure } from "./validation.js";

/**
 * An edit made somewhere else comes back as a PROPOSAL.
 *
 * This is the direction the whole exchange is weakest in. Handing a bundle out is
 * safe by construction — reading cannot corrupt anything. Taking a result back is
 * where a package gets silently overwritten by somebody who was looking at an
 * older revision, and where the difference between "the design changed" and "the
 * tool re-exported the same thing" stops being obvious.
 *
 * Three rules, and the first one is what the other two rest on:
 *
 * - **A proposal is anchored.** It carries the bundle it was generated from, so
 *   the base revision and the exact bytes it saw are facts, not recollections.
 * - **A stale base is a conflict, not a merge.** If the package moved on, the
 *   proposal is refused with the refs whose bytes moved. The current revision is
 *   never touched — this module cannot write at all.
 * - **The delta is shown before anything happens.** What Workline can name
 *   semantically it names; what it cannot it declares as prose it does not
 *   understand, instead of implying the change is smaller than it is.
 *
 * Turning an accepted proposal into `@rN+1` is authoring, and authoring belongs to
 * the agent — the same split as everywhere else in this capability. What lives here
 * is the reconciliation RECORD: the base the decision was made against, what was
 * accepted and which revision the result must supersede. Publication then enforces
 * it with the compare-and-swap it already has.
 */

/** One document as an external tool handed it back. */
export interface ProposedDocument {
  /** Package-relative path it would occupy. */
  path: string;
  kind: "flow" | "screen";
  content: string;
}

/** A difference this Workline can name. */
export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface DocumentDelta {
  /** The base revision this document was edited from, e.g. `DES-001/SCR-001@r2`. */
  ref: string;
  path: string;
  changes: FieldChange[];
  /**
   * Sections whose text changed. Named, not diffed: the words are the author's,
   * and pretending to summarize them is how a review starts trusting a summary.
   */
  prose_changed: string[];
  /** The proposal does not validate, so nothing can be taken from it. */
  failures: DesignFailure[];
}

export interface ProposalReview {
  /** True only when the base is current AND every proposed document validates. */
  ok: boolean;
  base: {
    package: string;
    baseline: number;
    /** Over the closure the bundle handed out. Recomputable from the package. */
    source_digest: string;
  };
  /** Non-null when the package moved on: a conflict, never a merge. */
  stale: StaleVerdict | null;
  delta: DocumentDelta[];
  failures: DesignFailure[];
  /**
   * Always true. A review is a report: nothing here creates a revision, and the
   * field says so at the call site instead of in a comment somebody may not read.
   */
  reconciliation_required: true;
}

export interface ProposalInput {
  /** The bundle the tool was given, already validated. */
  base: RenderBundle;
  documents: readonly ProposedDocument[];
  /** The package as it is NOW: ref → sha256 of the bytes on disk. */
  current: ReadonlyMap<string, string>;
  /** The document as it is NOW, by package-relative path. */
  currentText: ReadonlyMap<string, string>;
}

/**
 * Judge a proposal without touching anything.
 *
 * The staleness check runs FIRST and short-circuits the delta: comparing a
 * proposal against a revision it never saw would produce a diff that describes
 * neither what the author changed nor what the package says, which is worse than
 * no diff at all.
 */
export function reviewExternalProposal(input: ProposalInput): ProposalReview {
  const base = {
    package: input.base.package,
    baseline: input.base.baseline,
    source_digest: baseSourceDigestOf(input.base),
  };
  const stale = checkSourcesStale(
    `${input.base.package}@r${input.base.baseline}`,
    sourcesOf(input.base),
    base.source_digest,
    input.current,
  );
  if (stale !== null) {
    return {
      ok: false,
      base,
      stale,
      delta: [],
      failures: [staleBaseFailure(stale, input.base)],
      reconciliation_required: true,
    };
  }

  const delta = input.documents.map((doc) => deltaOf(doc, input.base, input.currentText));
  const failures = delta.flatMap((d) => d.failures);
  return {
    ok: failures.length === 0,
    base,
    stale: null,
    delta,
    failures,
    reconciliation_required: true,
  };
}

/** The closure of a bundle, as the (ref, sha256) pairs staleness is derived from. */
function sourcesOf(bundle: RenderBundle): RenditionSource[] {
  return bundle.closure.map((m) => ({ ref: m.ref, sha256: m.sha256 }));
}

/**
 * The base token: one digest over everything the bundle handed out.
 *
 * The SAME token a rendition computes over its sources, on purpose: an external
 * return may come from a bundle or from a snapshot, and having two spellings of
 * one fact is how false conflicts get in.
 */
export function baseSourceDigestOf(bundle: RenderBundle): string {
  return computeSourceDigest(sourcesOf(bundle));
}

/**
 * The base moved. `DESIGN_BASE_STALE` on purpose — it is the same event the
 * compare-and-swap of a publication reports, and giving it a second code would
 * make the two read as different problems.
 */
function staleBaseFailure(stale: StaleVerdict, bundle: RenderBundle): DesignFailure {
  return {
    code: "DESIGN_BASE_STALE",
    artifact: `${bundle.package}/render-bundle.json`,
    message: `la propuesta se generó desde ${stale.subject} y ese contenido ya cambió (${stale.moved.join(", ") || "sus fuentes"})`,
    action:
      "cortá un bundle nuevo desde la revisión vigente y rehacé la edición sobre él: una base obsoleta no sobrescribe lo publicado",
  };
}

/** What changed in one proposed document, against the revision it was cut from. */
function deltaOf(
  doc: ProposedDocument,
  base: RenderBundle,
  currentText: ReadonlyMap<string, string>,
): DocumentDelta {
  const member = base.closure.find((m) => m.path === doc.path);
  const ref = member?.ref ?? doc.path;
  const empty = { ref, path: doc.path, changes: [], prose_changed: [] };

  if (member === undefined) {
    return {
      ...empty,
      failures: [
        {
          code: "DESIGN_REFERENCE_MISSING",
          artifact: doc.path,
          message: `'${doc.path}' no estaba en el bundle que se entregó`,
          action:
            "una propuesta modifica lo que recibió: si es contenido nuevo, autoralo como revisión nueva en vez de devolverlo como propuesta",
        },
      ],
    };
  }
  const proposed = validateDesignArtifact(doc.content, doc.kind, doc.path);
  if (!proposed.ok || proposed.value === null) {
    return { ...empty, failures: proposed.failures };
  }
  const before = currentText.get(doc.path);
  if (before === undefined) {
    return {
      ...empty,
      failures: [
        {
          code: "DESIGN_REFERENCE_FILE_MISSING",
          artifact: doc.path,
          message: `'${doc.path}' no se pudo leer del package para comparar`,
          action:
            "restauralo: sin la revisión base no hay delta que mostrar, solo una sobrescritura",
        },
      ],
    };
  }
  const current = validateDesignArtifact(before, doc.kind, doc.path);
  if (!current.ok || current.value === null) {
    return { ...empty, failures: current.failures };
  }
  return {
    ref,
    path: doc.path,
    changes: fieldChanges(current.value, proposed.value),
    prose_changed: changedSections(before, doc.content),
    failures: [],
  };
}

/** Frontmatter fields, rendered as text so a scalar and a list compare the same way. */
function fieldsOf(doc: DesignArtifact): Array<[string, string]> {
  const common: Array<[string, string]> = [
    ["revision", String(doc.revision)],
    ["maturity", doc.maturity],
    ["purpose", doc.purpose],
    ["platform", doc.platform],
    ["trace", doc.trace.map((t) => t.criterion).join(", ")],
  ];
  if (doc.kind === "flow") {
    return [
      ...common,
      ["actors", doc.actors.join(", ")],
      ["entry", doc.entry],
      ["nodes", doc.nodes.join(", ")],
      ["edges", doc.edges.map((e) => `${e.from} -[${e.trigger}]-> ${e.to}`).join(" · ")],
      ["dependencies", doc.dependencies.join(", ")],
    ];
  }
  return [
    ...common,
    ["title", doc.title],
    ["default_state", doc.default_state],
    ["states", doc.states.map((s) => s.anchor).join(", ")],
    ["flow_refs", doc.flow_refs.join(", ")],
    ["dependencies.rules", doc.dependencies.rules.join(", ")],
    ["dependencies.tokens", doc.dependencies.tokens.join(", ")],
    ["dependencies.assets", doc.dependencies.assets.join(", ")],
    [
      "trace.classification",
      doc.trace.map((t) => `${t.criterion}=${t.classification ?? "sin clasificar"}`).join(", "),
    ],
  ];
}

function fieldChanges(current: DesignArtifact, proposed: DesignArtifact): FieldChange[] {
  const after = new Map(fieldsOf(proposed));
  const out: FieldChange[] = [];
  for (const [field, before] of fieldsOf(current)) {
    const value = after.get(field) ?? "";
    if (value === before) continue;
    out.push({ field, before, after: value });
  }
  return out;
}

/**
 * Which `##` sections changed. Only their names: the body is prose, and this
 * refuses to paraphrase it — "«Accessibility» cambió" is a fact a reviewer can act
 * on, while a generated summary of what it now says is a claim nobody authored.
 */
function changedSections(before: string, after: string): string[] {
  const sectionsOf = (text: string): Map<string, string> => {
    const split = splitDesignDocument(text);
    if (split === null) return new Map();
    return new Map(parseBody(split.body, split.bodyLine).sections.map((s) => [s.heading, s.text]));
  };
  const from = sectionsOf(before);
  const to = sectionsOf(after);
  const out: string[] = [];
  for (const [heading, text] of to) {
    if (from.get(heading) !== text) out.push(heading);
  }
  for (const heading of from.keys()) {
    if (!to.has(heading)) out.push(`${heading} (quitada)`);
  }
  return out;
}

/** The human's explicit decision about a reviewed proposal. */
export interface ReconciliationDecision {
  /** The refs being taken in. Empty accepts nothing — and produces nothing. */
  accept: readonly string[];
  /** Why. Recorded, because "somebody approved this" is the audit trail. */
  rationale: string;
}

/**
 * What an accepted proposal becomes: the instruction to author `@rN+1`.
 *
 * Deliberately not the documents themselves. Writing the next revision means
 * rewriting a document's frontmatter, and mechanically editing somebody's
 * authored file is exactly the kind of silent transformation this phase exists to
 * prevent — the agent authors, the CLI validates and publishes. What this returns
 * is the contract that authoring has to satisfy, and `publishDesignRevision` then
 * enforces it with the compare-and-swap and the naming rules it already has.
 */
export interface AcceptedRevision {
  /** The base revision of the artifact, e.g. `DES-001/SCR-001@r2`. */
  ref: string;
  /** Path of that base revision, for the author to start from. */
  path: string;
  /** What the new document must declare in `supersedes`. */
  must_supersede: string;
  /** The revision the new document must declare — the ARTIFACT's, not the package's. */
  target_revision: number;
}

export interface Reconciliation {
  package: string;
  /** The published baseline the decision was made against — what `expectedBase` needs. */
  expected_base: string;
  /**
   * The baseline the publication will create. A different axis from an artifact's
   * revision, and named apart on purpose: conflating the two is how a document ends
   * up numbered after the package instead of after itself.
   */
  target_baseline: number;
  accepted: AcceptedRevision[];
  rationale: string;
}

export type ReconciliationResult =
  | { ok: true; value: Reconciliation }
  | { ok: false; failures: DesignFailure[] };

export function reconcileProposal(
  review: ProposalReview,
  decision: ReconciliationDecision,
): ReconciliationResult {
  const refuse = (message: string, action: string): ReconciliationResult => ({
    ok: false,
    failures: [
      {
        code: "DESIGN_RECONCILIATION_REQUIRED",
        artifact: `${review.base.package}@r${review.base.baseline}`,
        message,
        action,
      },
    ],
  });

  if (!review.ok) {
    return refuse(
      "la propuesta no está en condiciones de reconciliarse",
      review.stale === null
        ? "corregí los documentos propuestos y volvé a revisar: no se reconcilia lo que no valida"
        : "la base quedó obsoleta: cortá un bundle nuevo desde la revisión vigente y rehacé la edición",
    );
  }
  if (decision.accept.length === 0) {
    return refuse(
      "ninguna revisión fue aceptada",
      "aceptá explícitamente las revisiones que entran: una propuesta no se convierte en @rN+1 por haber sido revisada",
    );
  }
  if (decision.rationale.trim().length === 0) {
    return refuse(
      "la reconciliación no dice por qué se acepta",
      "escribí el motivo: es el registro de que alguien lo decidió, y lo único que quedará dentro de seis meses",
    );
  }

  const known = new Map(review.delta.map((d) => [d.ref, d]));
  const unresolved = decision.accept.filter(
    (ref) => !known.has(ref) || parseArtifactRef(ref) === null,
  );
  if (unresolved.length > 0) {
    return refuse(
      `la decisión acepta ${unresolved.join(", ")} y la revisión no lo trae como una referencia resoluble`,
      "aceptá solo lo que la propuesta trajo: revisá los refs del delta",
    );
  }

  return {
    ok: true,
    value: {
      package: review.base.package,
      expected_base: `${review.base.package}@r${review.base.baseline}`,
      target_baseline: review.base.baseline + 1,
      accepted: decision.accept.map((ref) => {
        const entry = known.get(ref) as DocumentDelta;
        const parsed = parseArtifactRef(ref) as NonNullable<ReturnType<typeof parseArtifactRef>>;
        return {
          ref,
          path: entry.path,
          must_supersede: ref,
          target_revision: parsed.revision + 1,
        };
      }),
      rationale: decision.rationale,
    },
  };
}
