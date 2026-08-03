import {
  type BodySection,
  type DesignDocKind,
  ESSENTIAL_HEADINGS,
  HEADINGS,
  conditionalKeys,
  headingKey,
  parseBody,
} from "./artifact-body.js";
import {
  type DesignArtifact,
  type DesignMaturity,
  type ScreenArtifact,
  type ScreenTraceEntry,
  splitDesignDocument,
  validateDesignArtifact,
} from "./artifact.js";
import { parseArtifactId, parseArtifactRef } from "./identity.js";
import type { DesignFailure } from "./validation.js";

/**
 * The `handoff` gate: does this revision say enough to be implemented against?
 *
 * F2 proved the document is WELL FORMED — every heading present, every field of
 * the right shape. That is a different question from whether it is FINISHED, and
 * the two are deliberately separate: a package mixes `outline` and `handoff`
 * revisions on purpose, so a document that is honestly incomplete must be able
 * to validate. What it must not do is *claim* to be implementable.
 *
 * So this module reads a document that already validated and judges it against
 * the profile its own frontmatter declares. Nothing here rewrites the maturity:
 * the author claims, the gate refuses.
 */

/** Which profile an artifact is being judged against. */
export interface MaturityVerdict {
  /** The maturity the artifact can honestly claim. */
  attainable: DesignMaturity;
  /** Empty when the declared maturity is attainable. */
  failures: DesignFailure[];
  /**
   * What the implementation will have to PROVE. A design document states
   * obligations; it never discharges them (AC-SEM-07).
   */
  obligations: DesignObligation[];
}

/** One thing the implementation owes, and where the design says it. */
export interface DesignObligation {
  /** The section it comes from, as a `not_applicable` key. */
  key: string;
  /** What the design demands, in the design's own words. */
  statement: string;
}

/**
 * A reference that is only a picture. A rendition shows what a screen LOOKED
 * like when someone rendered it; it is not the semantics and it is not a WCAG
 * verdict. A section whose entire content is a rendition reference has answered
 * with an image (AC-SEM-07).
 */
const RENDITION_ONLY = /^(?:\s*(?:DES-[0-9]+\/)?VIS-[0-9]+@r[0-9]+\s*[,·.;]?\s*)+$/;

/** Sections whose closure a `handoff` must be able to demonstrate later. */
const OBLIGATION_KEYS = new Set([
  "accessibility",
  "data_permissions_and_validation",
  "states_and_transitions",
  "responsive_and_adaptation",
  "localization",
  "permissions_and_privacy",
  "alternatives_and_recovery",
]);

export function checkMaturity(
  artifact: DesignArtifact,
  sections: BodySection[],
  kind: DesignDocKind,
  file: string,
): MaturityVerdict {
  const obligations = readObligations(sections, artifact.not_applicable);
  const failures = [
    ...checkOutlineFloor(artifact, sections, kind, file),
    ...(artifact.maturity === "handoff" ? checkHandoff(artifact, sections, kind, file) : []),
  ];
  return {
    attainable: failures.length === 0 ? artifact.maturity : "outline",
    failures,
    obligations,
  };
}

/**
 * The floor BOTH profiles stand on (AC-SEM-01).
 *
 * `outline` is not "anything goes": it is the minimum inventory from which the
 * next revision can be planned — who, what for, on what, what screens or steps
 * exist, and what it traces to. What `outline` does NOT demand is completing the
 * handoff early, which is why every check here is about presence, not depth.
 */
function checkOutlineFloor(
  artifact: DesignArtifact,
  sections: BodySection[],
  kind: DesignDocKind,
  file: string,
): DesignFailure[] {
  const failures: DesignFailure[] = [];

  if (artifact.trace.length === 0) {
    failures.push({
      code: "DESIGN_MATURITY_INCOMPLETE",
      artifact: file,
      message: "sin trazabilidad no hay inventario: 'trace' está vacío",
      action: "declará al menos el Requirement y el acceptance criterion que origina esto",
    });
  }

  if (artifact.kind === "flow" && artifact.actors.length === 0) {
    failures.push({
      code: "DESIGN_MATURITY_INCOMPLETE",
      artifact: file,
      message: "no declara actores: el inventario mínimo incluye quién lo recorre",
      action: "declará al menos un actor en 'actors'",
    });
  }

  const inventory =
    artifact.kind === "flow"
      ? { what: "nodos", empty: artifact.nodes.length === 0 }
      : { what: "estados", empty: artifact.states.length === 0 };
  if (inventory.empty) {
    failures.push({
      code: "DESIGN_MATURITY_INCOMPLETE",
      artifact: file,
      message: `el inventario mínimo está vacío: no declara ${inventory.what}`,
      action: `un ${kind} en 'outline' ya enumera sus ${inventory.what}, aunque no los detalle`,
    });
  }

  // Acá vivía un cruce `unknown` ↔ `not_applicable` por coincidencia de texto.
  // Era inseguro en las dos direcciones —no veía la contradicción real escrita
  // como pregunta, y bloqueaba documentos legítimos que nombraban la sección de
  // paso— así que se fue: adivinar sobre prosa libre no es una guarda. Lo que
  // AC-SEM-04 exige de verdad lo hace `checkBlockingUnknowns`, sobre un booleano
  // que el autor declara.

  failures.push(...checkPlaceholders(sections, kind, file));
  return failures;
}

/** Whatever a section says, it cannot be only a picture — in either profile. */
function checkPlaceholders(
  sections: BodySection[],
  kind: DesignDocKind,
  file: string,
): DesignFailure[] {
  const essential = new Set(ESSENTIAL_HEADINGS[kind]);
  return sections
    .filter((s) => essential.has(s.heading) && RENDITION_ONLY.test(s.prose.trim()))
    .map((s) => ({
      code: "DESIGN_EVIDENCE_INSUFFICIENT",
      artifact: file,
      message: `'${s.heading}' responde con una rendition y nada más`,
      action:
        "una imagen aprobada no es la semántica vigente ni una conformidad WCAG: escribí lo que exige",
    }));
}

/**
 * `handoff` (AC-SEM-02, AC-SEM-03, AC-SEM-04, AC-PKG-09).
 *
 * The claim is: everything applicable is closed, and nothing open can still move
 * behavior or acceptance. Every check below is a way that claim can be false.
 */
function checkHandoff(
  artifact: DesignArtifact,
  sections: BodySection[],
  kind: DesignDocKind,
  file: string,
): DesignFailure[] {
  return [
    ...checkBlockingUnknowns(artifact, file),
    ...checkGraph(artifact, file),
    ...checkApplicableCompleteness(artifact, sections, kind, file),
    ...checkExternalCustody(artifact, file),
    ...checkVisualEvidence(artifact, file),
  ];
}

/**
 * The elevation of AC-REN-01 and AC-REN-02: a `handoff` screen is LOOKABLE.
 *
 * Until this existed, `handoff` meant the prose was complete. That let a screen
 * be declared implementable while nobody could see it — and the visual evidence,
 * when it existed at all, was somebody's habit rather than a requirement. So a
 * `handoff` screen now owes two things:
 *
 * 1. a classification for every criterion it traces, and
 * 2. a local preview of its `default_state` — the criterion that shows the base
 *    state has to enumerate it AND enumerate a rendition of it.
 *
 * Both are checked HERE, against the document alone, and only the document's own
 * claims. Whether the enumerated rendition exists, was cut from this revision and
 * really covers that state is the package-level cross in `visual-evidence.ts`:
 * this gate cannot open another file, and a gate that pretended to would be
 * reporting on evidence it never read.
 *
 * `outline` is untouched on purpose. A screen still being shaped legitimately has
 * no picture yet, and demanding one would push the author to render a placeholder
 * so the document matches a template.
 */
function checkVisualEvidence(artifact: DesignArtifact, file: string): DesignFailure[] {
  if (artifact.kind !== "screen") return [];
  const screen = artifact as ScreenArtifact;
  const failures: DesignFailure[] = [];

  for (const entry of screen.trace) {
    failures.push(...checkClassified(entry, file));
  }

  const base = screen.trace.filter(
    (e) => e.classification !== "not_visual" && e.states.includes(screen.default_state),
  );
  if (!base.some((e) => e.renditions.length > 0)) {
    failures.push({
      code: "DESIGN_EVIDENCE_INSUFFICIENT",
      artifact: file,
      message: `ningún criterio trazado muestra el estado base '${screen.default_state}' con una rendition`,
      action:
        "un 'handoff' conserva una preview estática local de su default_state: creá la rendition y enumerala en el criterio que lo demuestra",
    });
  }
  return failures;
}

/** One entry of the matrix: classified, and enumerating what its class demands. */
function checkClassified(entry: ScreenTraceEntry, file: string): DesignFailure[] {
  const incomplete = (message: string, action: string): DesignFailure => ({
    code: "DESIGN_MATURITY_INCOMPLETE",
    artifact: file,
    message: `trace['${entry.criterion}'] ${message}`,
    action,
  });

  if (entry.classification === null) {
    return [
      incomplete(
        "no está clasificado",
        "clasificalo 'visual', 'interaction' o 'not_visual': un 'handoff' dice cómo se demuestra cada criterio",
      ),
    ];
  }
  if (entry.classification === "not_visual") {
    return entry.reason === null
      ? [
          incomplete(
            "está clasificado 'not_visual' y no dice por qué",
            "escribí en 'reason' qué hace que ese criterio no tenga nada que mirar",
          ),
        ]
      : [];
  }

  const failures: DesignFailure[] = [];
  if (entry.states.length === 0) {
    failures.push(
      incomplete(
        `es '${entry.classification}' y no enumera estados`,
        "nombrá en 'states' los anchors donde se ve",
      ),
    );
  }
  if (entry.renditions.length === 0) {
    failures.push(
      incomplete(
        `es '${entry.classification}' y no enumera renditions`,
        "referenciá en 'renditions' la evidencia visual que lo muestra",
      ),
    );
  }
  return failures;
}

/**
 * AC-SEM-02: a `handoff` flow states its TRANSITIONS, not just its steps.
 *
 * A flow with two or more nodes and no edges has its graph only in the prose of
 * `## Main journey` — which is exactly what the machine-readable frontmatter
 * exists to avoid. One node and no edges is a legitimate degenerate case.
 */
function checkGraph(artifact: DesignArtifact, file: string): DesignFailure[] {
  if (artifact.kind !== "flow" || artifact.nodes.length < 2 || artifact.edges.length > 0) {
    return [];
  }
  return [
    {
      code: "DESIGN_MATURITY_INCOMPLETE",
      artifact: file,
      message: `declara ${artifact.nodes.length} nodos y ninguna transición entre ellos`,
      action:
        "un 'handoff' resuelve su grafo sin interpretar prosa: declará las aristas en 'edges'",
    },
  ];
}

/** AC-SEM-04: an open question that can move behavior forbids the claim. */
function checkBlockingUnknowns(artifact: DesignArtifact, file: string): DesignFailure[] {
  return artifact.unknowns
    .filter((u) => u.blocking)
    .map((u) => ({
      code: "DESIGN_MATURITY_BLOCKED",
      artifact: file,
      message: `queda una incógnita bloqueante: "${u.question}"`,
      action:
        "resolvela y volvé a declarar 'handoff', o bajá a 'outline': una incógnita no es un 'no aplica'",
    }));
}

/**
 * Every section either SAYS something or is justified as inapplicable.
 *
 * The essential sections admit neither escape — F2 already rejects a
 * `not_applicable` on them — so what is left to check here is the conditional
 * ones: silence is not closure.
 */
function checkApplicableCompleteness(
  artifact: DesignArtifact,
  sections: BodySection[],
  kind: DesignDocKind,
  file: string,
): DesignFailure[] {
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const failures: DesignFailure[] = [];

  for (const key of conditionalKeys(kind)) {
    const waived = artifact.not_applicable[key];
    if (waived !== undefined) continue;
    const section = byKey.get(key);
    if (section === undefined || section.text.trim().length > 0) continue;
    failures.push({
      code: "DESIGN_MATURITY_INCOMPLETE",
      artifact: file,
      message: `'${headingOf(kind, key)}' está vacía y no se declaró no aplicable`,
      action: `completala, o declará not_applicable.${key} con su razón`,
    });
  }
  return failures;
}

/**
 * AC-PKG-09: depending on someone else's design system.
 *
 * A `handoff` that points at another package's rules or tokens is implementable
 * only if that material is HERE — pinned by provider, revision and digest, and
 * kept locally. Otherwise the artifact describes something that can change
 * underneath it, which is exactly what `outline` is for.
 */
function checkExternalCustody(artifact: DesignArtifact, file: string): DesignFailure[] {
  const own = parseArtifactId(artifact.id)?.package;
  // Todas las referencias, no solo `dependencies`: un flow cuyos NODOS viven en
  // otro package es tan poco implementable como uno cuyas rules viven afuera, y
  // la clausura ya lo declara irresoluble. Las dos mitades tienen que coincidir.
  const refs =
    artifact.kind === "flow"
      ? [artifact.entry, ...artifact.nodes, ...artifact.dependencies]
      : [...artifact.flow_refs, ...artifact.dependencies.rules, ...artifact.dependencies.tokens];

  const pinned = new Set(artifact.external.map((e) => e.provider));
  const loose = new Map<string, string[]>();
  for (const ref of refs) {
    const parsed = parseArtifactRef(ref);
    if (parsed === null || parsed.package === own || pinned.has(parsed.package)) continue;
    loose.set(parsed.package, [...(loose.get(parsed.package) ?? []), ref]);
  }
  if (loose.size === 0) return [];

  return [...loose].map(([provider, refs]) => ({
    code: "DESIGN_EVIDENCE_INSUFFICIENT",
    artifact: file,
    message: `depende de ${provider} sin fijarlo: ${refs.join(", ")}`,
    action: `agregá a 'external' el proveedor ${provider} con su revisión y su digest, y conservá localmente ese subconjunto; sin esa evidencia queda en 'outline'`,
  }));
}

/**
 * What the implementation will have to prove.
 *
 * Derived, never authored: the obligations ARE the sections that state demands
 * an implementation can fail — accessibility, permissions, states, adaptation.
 * The gate records them so a later phase can ask for evidence instead of taking
 * a rendered picture as proof.
 *
 * A section the document WAIVED is not an obligation. F2 makes the heading exist
 * with real prose even when it is waived — the machine-readable reason and the
 * human explanation are two audiences — so filtering by prose alone would demand
 * evidence for exactly what the design justified as inapplicable. And the whole
 * section is the statement: cutting at the first period dropped the second half
 * of every rule, which is where the testable part usually lives.
 */
function readObligations(
  sections: BodySection[],
  waived: Record<string, string>,
): DesignObligation[] {
  return sections
    .filter(
      (s) => OBLIGATION_KEYS.has(s.key) && s.prose.trim().length > 0 && waived[s.key] === undefined,
    )
    .map((s) => ({ key: s.key, statement: s.prose.replace(/\s+/g, " ").trim() }));
}

function headingOf(kind: DesignDocKind, key: string): string {
  return HEADINGS[kind].find((h) => headingKey(h) === key) ?? key;
}

/**
 * The gate over raw document text: validate, then judge.
 *
 * One entry point so no caller can do half of it. A document that does not
 * validate has no maturity to judge — `attainable` is `outline` because that is
 * the only honest thing to say about text that is not yet a document.
 */
export function gateDesignDocument(
  text: string,
  kind: DesignDocKind,
  file: string,
): MaturityVerdict {
  const document = validateDesignArtifact(text, kind, file);
  if (!document.ok || document.value === null) {
    return { attainable: "outline", failures: document.failures, obligations: [] };
  }
  const split = splitDesignDocument(text);
  const sections = split === null ? [] : parseBody(split.body, split.bodyLine).sections;
  return checkMaturity(document.value, sections, kind, file);
}
