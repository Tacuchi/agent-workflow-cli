import { createHash } from "node:crypto";
import { canonicalJson } from "../../application/semantic-operation/protocol.js";
import { checkSafeRelativePath } from "../safe-path.js";
import { CANONICAL_SCHEMAS } from "./capability.js";
import { GRAMMAR, isDigest, isRevision, parseArtifactId, parseArtifactRef } from "./identity.js";
import type { DataClassification } from "./render-bundle.js";
import { secretFailures } from "./secrets.js";
import {
  type AllowedKeys,
  type DesignFailure,
  Reader,
  eachRecord,
  isNonEmptyString,
  isRecord,
} from "./validation.js";

/**
 * `renditions/VIS-NNN-rNNN-<slug>/rendition.json` — what a picture of a design
 * knows about itself.
 *
 * v21.0.0 already reserved the place and the name; what was missing is the only
 * part that makes a rendition trustworthy: **which revision it came out of**.
 * Without it a package accumulates images that look current forever, and the
 * oldest screenshot in the folder is indistinguishable from the newest.
 *
 * So the contract is built around three separations that must never collapse:
 *
 * - **Fidelity is not maturity.** `high` says the picture is polished; it says
 *   nothing about whether the screen is implementable. Raising one must never
 *   move the other, and they live in different documents for that reason.
 * - **Staleness against the SOURCE is derived; sync with the PROVIDER is not.**
 *   `source_digest` is computed from the bytes of the revisions this rendition
 *   was cut from, so anybody can recompute it and see that the screen moved on.
 *   Whether Figma's copy still matches cannot be derived from here at all — it is
 *   a claim, and it lives inside `provider` where it is obviously one.
 * - **A locator locates; it never identifies.** `file_key`, `node_id`,
 *   `artifact` — none of them replace the Workline id, revision or digest, and
 *   none of them may carry a credential.
 */

export const DESIGN_RENDITION_SCHEMA_ID = CANONICAL_SCHEMAS.rendition;

/** What kind of artifact the rendition IS. Decides what evidence it can carry. */
export type RenditionMedium =
  | "static_image"
  | "document"
  | "interactive_html"
  | "prototype"
  | "storyboard";

const MEDIA: readonly RenditionMedium[] = [
  "static_image",
  "document",
  "interactive_html",
  "prototype",
  "storyboard",
];

/** The two media that can show a trigger, a transition and an outcome. */
const INTERACTIVE_MEDIA: readonly RenditionMedium[] = ["prototype", "storyboard"];

/**
 * How polished the picture is — a property OF THE PICTURE.
 *
 * Deliberately the same three words the industry uses for wireframe / mid /
 * pixel-perfect, and deliberately NOT `outline`/`handoff`: sharing a vocabulary
 * with maturity is how the two start getting confused.
 */
export type RenditionFidelity = "low" | "medium" | "high";

const FIDELITIES: readonly RenditionFidelity[] = ["low", "medium", "high"];

/** File formats a rendition may be. Closed, so `format` can be cross-checked. */
export type RenditionFormat = "svg" | "png" | "jpeg" | "webp" | "pdf" | "html";

const FORMATS: readonly RenditionFormat[] = ["svg", "png", "jpeg", "webp", "pdf", "html"];

/** Accepted file extensions per format — `format` must match what is on disk. */
const EXTENSIONS: Readonly<Record<RenditionFormat, readonly string[]>> = {
  svg: [".svg"],
  png: [".png"],
  jpeg: [".jpg", ".jpeg"],
  webp: [".webp"],
  pdf: [".pdf"],
  html: [".html"],
};

/**
 * Who can reach the editable original, as a CLASS — never as a credential.
 *
 * `local_only` is the honest answer for a rendition that lives entirely in the
 * package, and it is the one that keeps working when the provider does not.
 */
export type RenditionAccess = "local_only" | "public" | "link_shared" | "team" | "private";

const ACCESS: readonly RenditionAccess[] = [
  "local_only",
  "public",
  "link_shared",
  "team",
  "private",
];

/** Whether the provider's copy still matches this snapshot. A claim, not a derivation. */
export type ProviderSync = "in_sync" | "diverged" | "unknown";

const SYNCS: readonly ProviderSync[] = ["in_sync", "diverged", "unknown"];

/** One revision this rendition was produced from, with the bytes it saw. */
export interface RenditionSource {
  /** `DES-001/SCR-001@r2`, or anchored at one state. */
  ref: string;
  sha256: string;
}

/** Where the picture came out looking the way it does. */
export interface RenditionContext {
  platform: string;
  /** `1280x800`, `390x844`, or a named breakpoint. */
  viewport: string;
  theme: string;
  locale: string;
  variants: string[];
}

/** What this rendition demonstrates, in the screen's own vocabulary. */
export interface RenditionCoverage {
  criteria: string[];
  states: string[];
}

export interface RenditionFile {
  /** Relative to the rendition's OWN directory: `preview.svg`. */
  path: string;
  sha256: string;
}

/** A trigger, a transition and an outcome — what a still frame cannot show. */
export interface InteractionEvidence {
  trigger: string;
  transition: string;
  outcome: string;
}

/**
 * The external object, when there is one. `sync` lives here because it is only
 * meaningful when a provider copy exists: folding it into the root would need a
 * fourth `not_applicable` value for the case where there is nothing to be in
 * sync with.
 */
export interface RenditionProvider {
  name: string;
  /** Provider-shaped keys (`file_key`, `node_id`, …). Never a credential. */
  locator: Record<string, string>;
  /** The provider's own version identity, or null when it has no stable one. */
  version: string | null;
  sync: ProviderSync;
}

export interface DesignRendition {
  schema: string;
  id: string;
  revision: number;
  supersedes: string | null;
  purpose: string;
  medium: RenditionMedium;
  fidelity: RenditionFidelity;
  /** Free text: the tool that produced it, as a human would name it. */
  tool: string;
  format: RenditionFormat;
  context: RenditionContext;
  sources: RenditionSource[];
  /** Over the canonical list of `sources`. Recomputable — that is the point. */
  source_digest: string;
  coverage: RenditionCoverage;
  files: RenditionFile[];
  provider: RenditionProvider | null;
  access: RenditionAccess;
  interaction_evidence: InteractionEvidence | null;
  data_classification: DataClassification;
}

export const ALLOWED_KEYS: AllowedKeys = {
  "": [
    "schema",
    "id",
    "revision",
    "supersedes",
    "purpose",
    "medium",
    "fidelity",
    "tool",
    "format",
    "context",
    "sources",
    "source_digest",
    "coverage",
    "files",
    "provider",
    "access",
    "interaction_evidence",
    "data_classification",
  ],
  context: ["platform", "viewport", "theme", "locale", "variants"],
  "sources[]": ["ref", "sha256"],
  coverage: ["criteria", "states"],
  "files[]": ["path", "sha256"],
  provider: ["name", "locator", "version", "sync"],
  interaction_evidence: ["trigger", "transition", "outcome"],
};

const ANCHOR_RE = new RegExp(`^${GRAMMAR.anchor}$`);
const CRITERION_RE = /^S\d{3}\/AC-(?:[A-Z]+-)?\d+$/;
const DATA_CLASSIFICATIONS: readonly DataClassification[] = ["synthetic", "redacted", "real"];

/**
 * The staleness token: one digest over every source this rendition saw.
 *
 * Sorted and canonicalized so the same set of sources always produces the same
 * token, and computed over the pairs rather than over the refs alone — a
 * rendition of `SCR-001@r2` is stale when the BYTES of r2 changed, not only when
 * somebody published r3.
 */
export function computeSourceDigest(sources: readonly RenditionSource[]): string {
  const sorted = [...sources].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const input = canonicalJson(sorted.map((s) => ({ ref: s.ref, sha256: s.sha256 })));
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/** Why something no longer matches the sources it came from, or null when it does. */
export interface StaleVerdict {
  /** What went stale: a rendition (`VIS-001@r1`) or a proposal's base bundle. */
  subject: string;
  expected: string;
  actual: string;
  /** The refs whose bytes moved, so the diagnostic points at the real cause. */
  moved: string[];
}

/**
 * Did the content this was cut from move?
 *
 * Generic over the subject because a rendition and an external proposal ask the
 * exact same question: I recorded these revisions with these bytes — are they
 * still those bytes? `current` is the package as it is RIGHT NOW; comparing a
 * record against itself would always pass, which is the failure mode this exists
 * to prevent.
 */
export function checkSourcesStale(
  subject: string,
  sources: readonly RenditionSource[],
  sourceDigest: string,
  current: ReadonlyMap<string, string>,
): StaleVerdict | null {
  const rebuilt = sources.map((s) => ({ ref: s.ref, sha256: current.get(s.ref) ?? "" }));
  const actual = computeSourceDigest(rebuilt);
  if (actual === sourceDigest) return null;
  return {
    subject,
    expected: sourceDigest,
    actual,
    moved: sources
      .filter((s) => current.get(s.ref) !== s.sha256)
      .map((s) => s.ref)
      .sort(),
  };
}

/** Is this rendition still a picture of what it claims to be? */
export function checkStale(
  rendition: DesignRendition,
  current: ReadonlyMap<string, string>,
): StaleVerdict | null {
  return checkSourcesStale(
    `${rendition.id}@r${rendition.revision}`,
    rendition.sources,
    rendition.source_digest,
    current,
  );
}

/** The stale verdict as a failure, for a caller that must refuse to go on. */
export function staleFailure(verdict: StaleVerdict, artifact: string): DesignFailure {
  return {
    code: "DESIGN_RENDITION_STALE",
    artifact,
    message: `${verdict.subject} se generó desde un contenido que ya cambió (${verdict.moved.join(", ") || "sus fuentes"})`,
    action:
      "regenerá la rendition sobre la revisión vigente, o registrala contra la revisión de la que realmente salió",
  };
}

export interface RenditionValidation {
  ok: boolean;
  value: DesignRendition | null;
  failures: DesignFailure[];
  touched: ReadonlySet<string>;
}

export function validateDesignRendition(raw: unknown, artifact: string): RenditionValidation {
  const r = new Reader(ALLOWED_KEYS);
  if (!isRecord(raw)) {
    r.fail(
      "DESIGN_RENDITION_NOT_OBJECT",
      artifact,
      "la rendition no es un objeto JSON",
      `reescribí '${artifact}' como un único objeto JSON conforme a ${DESIGN_RENDITION_SCHEMA_ID}`,
    );
    return done(r, null);
  }

  const schema = r.read(raw, "schema");
  if (schema !== DESIGN_RENDITION_SCHEMA_ID) {
    r.fail(
      "DESIGN_SCHEMA_UNKNOWN",
      artifact,
      `versión de formato no soportada: ${JSON.stringify(schema)}`,
      `este Workline entiende ${DESIGN_RENDITION_SCHEMA_ID}`,
    );
    return done(r, null);
  }

  r.closed(raw, "", artifact);
  const rawId = r.read(raw, "id");
  const parsedId = parseArtifactId(rawId);
  if (parsedId === null || !parsedId.artifact.startsWith("VIS-")) {
    r.invalid(
      artifact,
      `'id' debe ser DES-NNN/VIS-NNN y llegó ${JSON.stringify(rawId)}`,
      "escribí la identidad completa, por ejemplo DES-001/VIS-001",
    );
  }
  const revision = r.read(raw, "revision");
  if (!isRevision(revision)) {
    r.invalid(
      artifact,
      "'revision' debe ser un entero >= 1",
      "las revisiones son lógicas y empiezan en 1",
    );
  }
  const supersedes = readSupersedes(r, raw, artifact, rawId, revision);

  const purpose = r.read(raw, "purpose");
  if (!isNonEmptyString(purpose)) {
    r.invalid(
      artifact,
      "'purpose' es obligatorio y no admite vacío",
      "escribí para qué existe esta rendition",
    );
  }
  const tool = r.read(raw, "tool");
  if (!isNonEmptyString(tool)) {
    r.invalid(artifact, "'tool' es obligatorio", "nombrá la herramienta que la produjo");
  }

  const medium = readEnum(r, raw, artifact, "medium", MEDIA, "declará qué clase de artefacto es");
  const fidelity = readEnum(
    r,
    raw,
    artifact,
    "fidelity",
    FIDELITIES,
    "la fidelidad es una propiedad de la IMAGEN y no mueve la madurez de la screen",
  );
  const format = readEnum(
    r,
    raw,
    artifact,
    "format",
    FORMATS,
    "declará el formato del archivo de preview",
  );
  const access = readEnum(
    r,
    raw,
    artifact,
    "access",
    ACCESS,
    "registrá la CLASE de acceso, nunca la credencial",
  );
  const classification = readEnum(
    r,
    raw,
    artifact,
    "data_classification",
    DATA_CLASSIFICATIONS,
    "el default es 'synthetic': material real exige declararlo",
  );

  const context = readContext(r, raw, artifact);
  const sources = readSources(r, raw, artifact);
  const coverage = readCoverage(r, raw, artifact);
  const files = readFiles(r, raw, artifact, format);
  const provider = readProvider(r, raw, artifact);
  const evidence = readInteractionEvidence(r, raw, artifact, medium);

  const sourceDigest = r.read(raw, "source_digest");
  if (!isDigest(sourceDigest)) {
    r.invalid(
      artifact,
      "'source_digest' debe ser 'sha256:' + 64 hex",
      "calculalo sobre la lista canónica de 'sources'",
    );
  } else if (sources.length > 0 && sourceDigest !== computeSourceDigest(sources)) {
    // Un token que no es el de sus propias fuentes no detecta nada: la detección
    // de obsolescencia entera cuelga de que este digest sea recomputable.
    r.fail(
      "DESIGN_DIGEST_MISMATCH",
      artifact,
      `'source_digest' no es el de las fuentes declaradas (declara ${sourceDigest}, calcula ${computeSourceDigest(sources)})`,
      "recalculalo sobre 'sources', o corregí las fuentes que esta rendition realmente usó",
    );
  }

  // Una rendition apunta a un objeto de un tercero: es el lugar más probable de
  // todo el package para que se cuele un token de acceso.
  for (const failure of secretFailures(raw, artifact)) r.failures.push(failure);
  if (r.failures.length > 0) return done(r, null);

  return done(r, {
    schema: DESIGN_RENDITION_SCHEMA_ID,
    id: rawId as string,
    revision: revision as number,
    supersedes,
    purpose: purpose as string,
    medium: medium as RenditionMedium,
    fidelity: fidelity as RenditionFidelity,
    tool: tool as string,
    format: format as RenditionFormat,
    context,
    sources,
    source_digest: sourceDigest as string,
    coverage,
    files,
    provider,
    access: access as RenditionAccess,
    interaction_evidence: evidence,
    data_classification: classification as DataClassification,
  });
}

/** A closed vocabulary field, read and reported once. */
function readEnum<T extends string>(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
  field: string,
  allowed: readonly T[],
  action: string,
): T | null {
  const value = r.read(raw, field);
  if (allowed.includes(value as T)) return value as T;
  r.invalid(
    artifact,
    `'${field}' debe ser uno de ${allowed.join(", ")} y llegó ${JSON.stringify(value)}`,
    action,
  );
  return null;
}

function readSupersedes(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
  id: unknown,
  revision: unknown,
): string | null {
  const value = r.read(raw, "supersedes");
  if (value === null || value === undefined) {
    if (value === undefined) {
      r.invalid(
        artifact,
        "'supersedes' es obligatorio",
        "usá null cuando esta es la primera revisión de la rendition",
      );
    }
    return null;
  }
  const ref = parseArtifactRef(value);
  if (ref === null || `${ref.package}/${ref.artifact}` !== id) {
    r.invalid(
      artifact,
      `'supersedes' debe ser una revisión anterior de ${String(id)} y llegó ${JSON.stringify(value)}`,
      "una rendition supersede a sí misma o a nada",
    );
    return null;
  }
  if (isRevision(revision) && ref.revision >= revision) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'supersedes' apunta a r${ref.revision} y esta revisión es r${revision}`,
      "solo se supersede una revisión anterior",
    );
    return null;
  }
  return value as string;
}

function readContext(r: Reader, raw: Record<string, unknown>, artifact: string): RenditionContext {
  const empty: RenditionContext = {
    platform: "",
    viewport: "",
    theme: "",
    locale: "",
    variants: [],
  };
  const node = r.read(raw, "context");
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'context' debe ser un objeto con platform, viewport, theme, locale y variants",
      "el mismo diseño se ve distinto según el contexto: declaralo",
    );
    return empty;
  }
  r.closed(node, "context", artifact);
  const out = { ...empty };
  for (const field of ["platform", "viewport", "theme", "locale"] as const) {
    const value = r.read(node, `context.${field}`);
    if (!isNonEmptyString(value)) {
      r.invalid(
        artifact,
        `'context.${field}' es obligatorio y no admite vacío`,
        `declará el ${field} en el que se produjo la rendition`,
      );
      continue;
    }
    out[field] = value;
  }
  const variants = r.read(node, "context.variants");
  if (!Array.isArray(variants)) {
    r.invalid(artifact, "'context.variants' debe ser un array", "usá [] si no hay variantes");
    return out;
  }
  for (const variant of variants) {
    if (!isNonEmptyString(variant)) {
      r.invalid(
        artifact,
        `'context.variants' trae una variante vacía: ${JSON.stringify(variant)}`,
        "nombrá cada variante, o dejá el array vacío",
      );
      continue;
    }
    out.variants.push(variant);
  }
  return out;
}

/**
 * The revisions this rendition came out of, anchored or whole.
 *
 * An anchor is allowed and meaningful here: a preview of one state IS a preview
 * of one state, and recording the whole screen instead would claim coverage of
 * every state the screen has.
 */
function readSources(r: Reader, raw: Record<string, unknown>, artifact: string): RenditionSource[] {
  const out: RenditionSource[] = [];
  const seen = new Set<string>();
  for (const entry of eachRecord(r, raw, "sources", artifact, " de revisiones fuente")) {
    const ref = r.read(entry, "sources[].ref");
    const sha256 = r.read(entry, "sources[].sha256");
    const parsed = parseArtifactRef(ref);
    if (parsed === null || parsed.artifact.startsWith("VIS-")) {
      r.invalid(
        artifact,
        `'sources[].ref' debe ser una revisión de flow, screen, rule o token y llegó ${JSON.stringify(ref)}`,
        "una rendition sale del diseño, no de otra rendition",
      );
      continue;
    }
    if (seen.has(ref as string)) {
      r.fail(
        "DESIGN_ID_DUPLICATE",
        artifact,
        `'sources' repite ${ref as string}`,
        "dejá una sola aparición",
      );
      continue;
    }
    seen.add(ref as string);
    if (!isDigest(sha256)) {
      r.invalid(
        artifact,
        `sources['${ref as string}']: 'sha256' debe ser 'sha256:' + 64 hex`,
        "hasheá los bytes del documento fuente",
      );
      continue;
    }
    out.push({ ref: ref as string, sha256 });
  }
  if (out.length === 0 && r.failures.length === 0) {
    r.invalid(
      artifact,
      "'sources' está vacío y una rendition siempre sale de algo",
      "declará la revisión de la que se generó: sin fuente no hay obsolescencia detectable",
    );
  }
  return out;
}

function readCoverage(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
): RenditionCoverage {
  const out: RenditionCoverage = { criteria: [], states: [] };
  const node = r.read(raw, "coverage");
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'coverage' debe ser un objeto con 'criteria' y 'states'",
      "declará qué criterios y qué estados demuestra esta rendition",
    );
    return out;
  }
  r.closed(node, "coverage", artifact);
  out.criteria = readClosedList(
    r,
    artifact,
    "coverage.criteria",
    r.read(node, "coverage.criteria"),
    CRITERION_RE,
    "citá el criterio como lo escribe Workline, por ejemplo S013/AC-REN-01",
  );
  out.states = readClosedList(
    r,
    artifact,
    "coverage.states",
    r.read(node, "coverage.states"),
    ANCHOR_RE,
    "nombrá el anchor del estado, sin '#'",
  );
  return out;
}

/**
 * A list whose items all have to match one closed grammar, deduplicated. The two
 * halves of `coverage` differ only in that grammar, so they share this.
 */
function readClosedList(
  r: Reader,
  artifact: string,
  path: string,
  raw: unknown,
  grammar: RegExp,
  action: string,
): string[] {
  if (!Array.isArray(raw)) {
    r.invalid(artifact, `'${path}' debe ser un array`, `usá '${path}': [] si no cubre ninguno`);
    return [];
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !grammar.test(value)) {
      r.invalid(artifact, `'${path}' trae un valor inválido: ${JSON.stringify(value)}`, action);
      continue;
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * The local files. Paths are relative to the rendition's OWN directory, so a
 * rendition can never claim a file that belongs to another one.
 */
function readFiles(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
  format: RenditionFormat | null,
): RenditionFile[] {
  const out: RenditionFile[] = [];
  const seen = new Set<string>();
  for (const entry of eachRecord(r, raw, "files", artifact, " de archivos locales")) {
    const path = r.read(entry, "files[].path");
    const sha256 = r.read(entry, "files[].sha256");
    if (typeof path !== "string" || path.length === 0) {
      r.invalid(
        artifact,
        "cada entrada de 'files' necesita 'path'",
        "escribí el path relativo a la carpeta de la rendition, por ejemplo preview.svg",
      );
      continue;
    }
    const safe = checkSafeRelativePath(path);
    if (!safe.ok) {
      r.fail(
        "DESIGN_PATH_UNSAFE",
        artifact,
        `files: '${path}' ${safe.why}`,
        "los archivos de una rendition viven dentro de su propia carpeta",
      );
      continue;
    }
    if (seen.has(safe.path)) {
      r.fail(
        "DESIGN_ID_DUPLICATE",
        artifact,
        `'${safe.path}' está declarado dos veces`,
        "nombrá cada archivo una vez",
      );
      continue;
    }
    seen.add(safe.path);
    if (!isDigest(sha256)) {
      r.invalid(
        artifact,
        `files['${safe.path}']: 'sha256' debe ser 'sha256:' + 64 hex`,
        "hasheá los bytes del archivo",
      );
      continue;
    }
    out.push({ path: safe.path, sha256 });
  }

  if (out.length === 0) {
    // Una rendition sin archivo local es exactamente la evidencia que desaparece
    // cuando el proveedor no está: es el caso que AC-REN-07 existe para impedir.
    r.fail(
      "DESIGN_EVIDENCE_INSUFFICIENT",
      artifact,
      "'files' está vacío: la rendition no conserva ninguna evidencia local",
      "guardá la preview dentro de la carpeta de la rendition y declarala en 'files'",
    );
    return out;
  }
  if (format !== null && !out.some((f) => EXTENSIONS[format].some((e) => f.path.endsWith(e)))) {
    r.invalid(
      artifact,
      `declara 'format': ${format} y ninguno de sus archivos termina en ${EXTENSIONS[format].join(" o ")}`,
      "corregí el formato declarado, o agregá el archivo que lo respalda",
    );
  }
  return out;
}

function readProvider(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
): RenditionProvider | null {
  const node = r.read(raw, "provider");
  if (node === null || node === undefined) {
    if (node === undefined) {
      r.invalid(
        artifact,
        "'provider' es obligatorio",
        "usá null cuando la rendition es puramente local",
      );
    }
    return null;
  }
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'provider' debe ser null o un objeto con name, locator, version y sync",
      "una rendición local declara provider: null",
    );
    return null;
  }
  r.closed(node, "provider", artifact);

  const name = r.read(node, "provider.name");
  if (!isNonEmptyString(name)) {
    r.invalid(artifact, "'provider.name' es obligatorio", "nombrá el proveedor, por ejemplo figma");
  }
  const pairs = readLocator(r, artifact, r.read(node, "provider.locator"));
  const version = r.read(node, "provider.version");
  if (version !== null && version !== undefined && !isNonEmptyString(version)) {
    r.invalid(
      artifact,
      `'provider.version' debe ser un texto o null y llegó ${JSON.stringify(version)}`,
      "usá null cuando el proveedor no expone una versión estable",
    );
  }
  const sync = readEnum(
    r,
    node,
    artifact,
    "provider.sync",
    SYNCS,
    "la sincronía con el proveedor es una AFIRMACIÓN: 'unknown' es la respuesta honesta sin consultarlo",
  );

  return {
    name: isNonEmptyString(name) ? name : "",
    locator: pairs,
    version: typeof version === "string" ? version : null,
    sync: sync ?? "unknown",
  };
}

/**
 * The provider-shaped keys. Which keys they are is the adapter profile's business,
 * so this only insists that there is at least one and that each one locates
 * something — an empty value is worse than an absent locator, because it reads as
 * a registered fact.
 */
function readLocator(r: Reader, artifact: string, locator: unknown): Record<string, string> {
  const pairs: Record<string, string> = {};
  if (!isRecord(locator) || Object.keys(locator).length === 0) {
    r.invalid(
      artifact,
      "'provider.locator' debe ser un objeto con al menos una clave",
      "declará el locator mínimo del proveedor, por ejemplo file_key y node_id",
    );
    return pairs;
  }
  for (const [key, value] of Object.entries(locator)) {
    if (!isNonEmptyString(value)) {
      r.invalid(
        artifact,
        `'provider.locator.${key}' no admite vacío`,
        "un locator que no localiza nada es peor que ninguno: quitalo o completalo",
      );
      continue;
    }
    pairs[key] = value;
  }
  return pairs;
}

function readInteractionEvidence(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
  medium: RenditionMedium | null,
): InteractionEvidence | null {
  const node = r.read(raw, "interaction_evidence");
  if (node === null || node === undefined) {
    if (node === undefined) {
      r.invalid(
        artifact,
        "'interaction_evidence' es obligatorio",
        "usá null cuando la rendition no demuestra una interacción",
      );
    }
    return null;
  }
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'interaction_evidence' debe ser null o un objeto con trigger, transition y outcome",
      "una rendition estática declara interaction_evidence: null",
    );
    return null;
  }
  r.closed(node, "interaction_evidence", artifact);

  // Un PNG no muestra una transición. Aceptar la evidencia sobre un medio que no
  // puede sostenerla es dejar que una afirmación pase por una demostración.
  if (medium !== null && !INTERACTIVE_MEDIA.includes(medium)) {
    r.fail(
      "DESIGN_EVIDENCE_INSUFFICIENT",
      artifact,
      `declara evidencia de interacción sobre un medio '${medium}'`,
      `una interacción se evidencia con ${INTERACTIVE_MEDIA.join(" o ")}: cambiá el medio, o poné interaction_evidence en null`,
    );
  }

  const out: InteractionEvidence = { trigger: "", transition: "", outcome: "" };
  for (const field of ["trigger", "transition", "outcome"] as const) {
    const value = r.read(node, `interaction_evidence.${field}`);
    if (!isNonEmptyString(value)) {
      r.invalid(
        artifact,
        `'interaction_evidence.${field}' es obligatorio y no admite vacío`,
        "una interacción se demuestra con las tres cosas: qué la dispara, qué transición produce y en qué termina",
      );
      continue;
    }
    out[field] = value;
  }
  return out;
}

function done(r: Reader, value: DesignRendition | null): RenditionValidation {
  return { ok: value !== null, value, failures: r.failures, touched: r.touched };
}
