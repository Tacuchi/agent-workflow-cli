import { checkSafeRelativePath } from "../safe-path.js";
import {
  ARTIFACT_PREFIX,
  type DesignArtifactKind,
  isArtifactId,
  isAssetFilename,
  isDigest,
  isPackageId,
  isRevision,
  parseArtifactRef,
  parseBaselineRef,
} from "./identity.js";
import {
  type AllowedKeys,
  type DesignFailure,
  Reader,
  eachRecord,
  isNonEmptyString,
  isRecord,
} from "./validation.js";

/**
 * `design-manifest.json` — the package's MUTABLE index.
 *
 * It is the only file in a package that changes without minting a revision, and
 * that is exactly why it owns nothing normative: it declares where things are,
 * which baseline is current and who references the package, while the baselines
 * and the artifacts they select own what things ARE. A baseline digest excludes
 * this file on purpose, so re-indexing never rewrites history.
 *
 * Validation is hand-written and fail-closed (same call as DEC-001: no schema
 * engine, no new dependency). The published JSON Schema is the normative
 * contract; `skills/w/schemas/design/design-manifest.v1.schema.json` holds it,
 * and a guard test proves this validator reads every property it declares.
 */

export const DESIGN_MANIFEST_SCHEMA_ID = "workline.design-manifest/v1";
export const DESIGN_MANIFEST_FILE = "design-manifest.json";
/** Workspace-relative root of the durable design taxonomy. */
export const DESIGNS_DIR = "docs/designs";

export type { DesignFailure } from "./validation.js";

export interface BaselineEntry {
  revision: number;
  path: string;
  digest: string;
  /** `DES-001@r3`, or null for the first baseline of the line. */
  parent_baseline: string | null;
  published: string;
}

export interface CatalogEntry {
  id: string;
  revision: number;
  path: string;
  /** `DES-001/FLW-001@r1`, or null when this revision supersedes nothing. */
  supersedes: string | null;
  /** Flows and screens only: every other artifact kind has no maturity. */
  maturity?: DesignMaturity;
}

export type DesignMaturity = "outline" | "handoff";

export interface AssetEntry {
  digest: string;
  path: string;
}

export interface DesignCatalog {
  flows: CatalogEntry[];
  screens: CatalogEntry[];
  rules: CatalogEntry[];
  tokens: CatalogEntry[];
  renditions: CatalogEntry[];
  assets: AssetEntry[];
}

export type CurrentnessState = "current" | "superseded";

export interface CurrentnessEntry {
  ref: string;
  state: CurrentnessState;
}

export interface GovernanceEntry {
  id: string;
  path: string;
  digest: string;
  /** The exact baseline this record decides on: `DES-001@r4`. */
  target: string;
}

export interface DesignGovernance {
  reviews: GovernanceEntry[];
  revocations: GovernanceEntry[];
}

/**
 * Many-to-many links to the documents that consume this package. This IS the
 * backreference: the package points back at every spec and plan that reference
 * it, so a consumer can be found without scanning `docs/`.
 */
export interface DesignRelations {
  specs: string[];
  plans: string[];
}

export interface CurrentBaseline {
  revision: number;
  path: string;
  digest: string;
}

export interface DesignManifest {
  schema: string;
  id: string;
  title: string;
  created: string;
  /** `DES-000@r3` when this package forked another; never a second live line. */
  derived_from: string | null;
  /** Null until the first publication. */
  current_baseline: CurrentBaseline | null;
  baselines: BaselineEntry[];
  catalog: DesignCatalog;
  currentness: CurrentnessEntry[];
  governance: DesignGovernance;
  relations: DesignRelations;
}

export type DesignManifestValidation = {
  ok: boolean;
  value: DesignManifest | null;
  failures: DesignFailure[];
  /**
   * Every property path this run actually read. The schema↔validator drift
   * guard compares it against the published schema, so a property that is
   * declared but never checked cannot ship.
   */
  touched: ReadonlySet<string>;
};

/**
 * Keys each object of the manifest admits, by property path (`""` is the root,
 * `[]` an array item). Drives the unknown-key rejection AND the drift guard: the
 * published schema declares `additionalProperties: false` everywhere, so a key
 * this table does not list is a typo of a real one, never an extension.
 */
export const ALLOWED_KEYS: AllowedKeys = {
  "": [
    "schema",
    "id",
    "title",
    "created",
    "derived_from",
    "current_baseline",
    "baselines",
    "catalog",
    "currentness",
    "governance",
    "relations",
  ],
  current_baseline: ["revision", "path", "digest"],
  "baselines[]": ["revision", "path", "digest", "parent_baseline", "published"],
  catalog: ["flows", "screens", "rules", "tokens", "renditions", "assets"],
  "catalog.flows[]": ["id", "revision", "path", "supersedes", "maturity"],
  "catalog.screens[]": ["id", "revision", "path", "supersedes", "maturity"],
  "catalog.rules[]": ["id", "revision", "path", "supersedes"],
  "catalog.tokens[]": ["id", "revision", "path", "supersedes"],
  "catalog.renditions[]": ["id", "revision", "path", "supersedes"],
  "catalog.assets[]": ["digest", "path"],
  "currentness[]": ["ref", "state"],
  governance: ["reviews", "revocations"],
  "governance.reviews[]": ["id", "path", "digest", "target"],
  "governance.revocations[]": ["id", "path", "digest", "target"],
  relations: ["specs", "plans"],
};

/** Catalog lists of revisioned artifacts — `assets` is content-addressed and apart. */
type RevisionedCatalogKey = Exclude<keyof DesignCatalog, "assets">;

const CATALOG_KINDS: Array<{ key: RevisionedCatalogKey; kind: DesignArtifactKind }> = [
  { key: "flows", kind: "flow" },
  { key: "screens", kind: "screen" },
  { key: "rules", kind: "rule" },
  { key: "tokens", kind: "token" },
  { key: "renditions", kind: "rendition" },
];

/** Kinds whose revisions carry a maturity. */
const MATURITY_KEYS: ReadonlySet<RevisionedCatalogKey> = new Set(["flows", "screens"]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDesignManifest(
  raw: unknown,
  artifact = DESIGN_MANIFEST_FILE,
): DesignManifestValidation {
  const r = new Reader(ALLOWED_KEYS);

  if (!isRecord(raw)) {
    r.fail(
      "DESIGN_MANIFEST_NOT_OBJECT",
      artifact,
      "el manifest no es un objeto JSON",
      `reescribí '${artifact}' como un único objeto JSON conforme a ${DESIGN_MANIFEST_SCHEMA_ID}`,
    );
    return done(r, null);
  }

  // The version gate runs first and alone: reading fields off a manifest whose
  // shape we do not know would report a pile of derived nonsense.
  const schema = r.read(raw, "schema");
  if (schema !== DESIGN_MANIFEST_SCHEMA_ID) {
    r.fail(
      "DESIGN_SCHEMA_UNKNOWN",
      artifact,
      `versión de formato no soportada: ${JSON.stringify(schema)}`,
      `este Workline entiende ${DESIGN_MANIFEST_SCHEMA_ID}; actualizá la CLI o el package`,
    );
    return done(r, null);
  }

  r.closed(raw, "", artifact);

  const id = r.read(raw, "id");
  if (!isPackageId(id)) {
    r.invalid(
      artifact,
      `'id' no es un identificador de package: ${JSON.stringify(id)}`,
      "usá la forma DES-NNN (tres dígitos o más), independiente del slug y del path",
    );
  }

  const title = r.read(raw, "title");
  if (!isNonEmptyString(title)) {
    r.invalid(
      artifact,
      "'title' es obligatorio y no puede estar vacío",
      "poné el nombre humano del package",
    );
  }

  const created = r.read(raw, "created");
  if (typeof created !== "string" || !ISO_DATE_RE.test(created)) {
    r.invalid(
      artifact,
      `'created' no es una fecha YYYY-MM-DD: ${JSON.stringify(created)}`,
      "escribí la fecha de creación como YYYY-MM-DD",
    );
  }

  const derivedFrom = r.read(raw, "derived_from");
  if (derivedFrom !== null && parseBaselineRef(derivedFrom) === null) {
    r.invalid(
      artifact,
      `'derived_from' no es un baseline: ${JSON.stringify(derivedFrom)}`,
      "usá null, o la forma DES-NNN@rN del package del que este deriva",
    );
  }

  const baselines = readBaselines(r, raw, artifact);
  const currentBaseline = readCurrentBaseline(r, raw, artifact, baselines);
  const catalog = readCatalog(r, raw, artifact);
  const currentness = readCurrentness(r, raw, artifact, id, catalog);
  const governance = readGovernance(r, raw, artifact, baselines);
  const relations = readRelations(r, raw, artifact);

  if (r.failures.length > 0) return done(r, null);

  return done(r, {
    schema: DESIGN_MANIFEST_SCHEMA_ID,
    id: id as string,
    title: title as string,
    created: created as string,
    derived_from: derivedFrom as string | null,
    current_baseline: currentBaseline,
    baselines,
    catalog,
    currentness,
    governance,
    relations,
  });
}

function readBaselines(r: Reader, raw: Record<string, unknown>, artifact: string): BaselineEntry[] {
  const out: BaselineEntry[] = [];
  const seen = new Set<number>();
  for (const entry of eachRecord(
    r,
    raw,
    "baselines",
    artifact,
    " (vacío si el package todavía no publicó)",
  )) {
    const parsed = readBaselineEntry(r, entry, artifact, seen);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function readBaselineEntry(
  r: Reader,
  entry: Record<string, unknown>,
  artifact: string,
  seen: Set<number>,
): BaselineEntry | null {
  const revision = r.read(entry, "baselines[].revision");
  const path = r.read(entry, "baselines[].path");
  const digest = r.read(entry, "baselines[].digest");
  const parent = r.read(entry, "baselines[].parent_baseline");
  const published = r.read(entry, "baselines[].published");

  const label = `baselines[r${String(revision)}]`;
  if (!isRevision(revision)) {
    r.invalid(
      artifact,
      `${label}: 'revision' debe ser un entero >= 1`,
      "las revisiones son lógicas y empiezan en 1",
    );
    return null;
  }
  if (seen.has(revision)) {
    r.fail(
      "DESIGN_ID_DUPLICATE",
      artifact,
      `la revisión r${revision} aparece dos veces en 'baselines'`,
      "una revisión publicada es única: eliminá la entrada duplicada",
    );
    return null;
  }
  seen.add(revision);
  checkPackagePath(r, artifact, `${label}.path`, path);
  if (!isDigest(digest)) {
    r.invalid(
      artifact,
      `${label}: 'digest' debe ser 'sha256:' + 64 hex`,
      "recalculá el digest del baseline",
    );
  }
  if (parent !== null && parseBaselineRef(parent) === null) {
    r.invalid(
      artifact,
      `${label}: 'parent_baseline' debe ser null o DES-NNN@rN`,
      "encadená el baseline con su padre, o null si es el primero",
    );
  }
  if (typeof published !== "string" || !ISO_DATE_RE.test(published)) {
    r.invalid(
      artifact,
      `${label}: 'published' no es una fecha YYYY-MM-DD`,
      "escribí la fecha de publicación como YYYY-MM-DD",
    );
  }
  return {
    revision,
    path: typeof path === "string" ? path : "",
    digest: typeof digest === "string" ? digest : "",
    parent_baseline: typeof parent === "string" ? parent : null,
    published: typeof published === "string" ? published : "",
  };
}

function readCurrentBaseline(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
  baselines: BaselineEntry[],
): CurrentBaseline | null {
  const node = r.read(raw, "current_baseline");
  if (node === null) return null;
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'current_baseline' debe ser un objeto o null",
      "poné null mientras el package no haya publicado",
    );
    return null;
  }
  r.closed(node, "current_baseline", artifact);
  const revision = r.read(node, "current_baseline.revision");
  const path = r.read(node, "current_baseline.path");
  const digest = r.read(node, "current_baseline.digest");

  if (!isRevision(revision)) {
    r.invalid(
      artifact,
      "'current_baseline.revision' debe ser un entero >= 1",
      "apuntá a una revisión publicada",
    );
    return null;
  }
  checkPackagePath(r, artifact, "current_baseline.path", path);
  if (!isDigest(digest)) {
    r.invalid(
      artifact,
      "'current_baseline.digest' debe ser 'sha256:' + 64 hex",
      "copiá el digest del baseline vigente",
    );
  }

  // The index may only point at a baseline the line actually contains: a
  // current_baseline nobody published is a dangling reference, not a state.
  const match = baselines.find((b) => b.revision === revision);
  if (match === undefined) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'current_baseline' apunta a r${revision} y 'baselines' no la contiene`,
      "publicá esa revisión o apuntá a una existente",
    );
  } else if (match.digest !== digest || match.path !== path) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'current_baseline' contradice la entrada r${revision} de 'baselines' (path o digest distintos)`,
      "el catálogo manda: copiá path y digest de 'baselines'",
    );
  }

  return {
    revision,
    path: typeof path === "string" ? path : "",
    digest: typeof digest === "string" ? digest : "",
  };
}

function readCatalog(r: Reader, raw: Record<string, unknown>, artifact: string): DesignCatalog {
  const node = r.read(raw, "catalog");
  const empty: DesignCatalog = {
    flows: [],
    screens: [],
    rules: [],
    tokens: [],
    renditions: [],
    assets: [],
  };
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'catalog' debe ser un objeto con flows, screens, rules, tokens, renditions y assets",
      "escribí las seis claves, con array vacío donde no haya contenido",
    );
    return empty;
  }
  r.closed(node, "catalog", artifact);

  const catalog = { ...empty };
  for (const { key, kind } of CATALOG_KINDS) {
    catalog[key] = readCatalogList(r, node, artifact, key, kind);
  }
  catalog.assets = readAssets(r, node, artifact);
  return catalog;
}

function readCatalogList(
  r: Reader,
  node: Record<string, unknown>,
  artifact: string,
  key: RevisionedCatalogKey,
  kind: DesignArtifactKind,
): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of eachRecord(r, node, `catalog.${key}`, artifact)) {
    const parsed = readCatalogEntry(r, entry, artifact, key, kind, seen);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function readCatalogEntry(
  r: Reader,
  entry: Record<string, unknown>,
  artifact: string,
  key: RevisionedCatalogKey,
  kind: DesignArtifactKind,
  seen: Set<string>,
): CatalogEntry | null {
  const wantsMaturity = MATURITY_KEYS.has(key);
  const id = r.read(entry, `catalog.${key}[].id`);
  const revision = r.read(entry, `catalog.${key}[].revision`);
  const path = r.read(entry, `catalog.${key}[].path`);
  const supersedes = r.read(entry, `catalog.${key}[].supersedes`);
  const maturity = wantsMaturity ? r.read(entry, `catalog.${key}[].maturity`) : undefined;

  const label = `catalog.${key}[${String(id)}]`;
  if (!isArtifactId(id, kind)) {
    r.invalid(
      artifact,
      `${label}: 'id' debe empezar con ${ARTIFACT_PREFIX[kind]}- y tres dígitos o más`,
      `usá ${ARTIFACT_PREFIX[kind]}-NNN`,
    );
    return null;
  }
  if (!isRevision(revision)) {
    r.invalid(
      artifact,
      `${label}: 'revision' debe ser un entero >= 1`,
      "las revisiones son lógicas y empiezan en 1",
    );
    return null;
  }
  const slot = `${id}@r${revision}`;
  if (seen.has(slot)) {
    r.fail(
      "DESIGN_ID_DUPLICATE",
      artifact,
      `${slot} aparece dos veces en 'catalog.${key}'`,
      "una revisión de un artefacto se cataloga una sola vez",
    );
    return null;
  }
  seen.add(slot);
  checkPackagePath(r, artifact, `${label}.path`, path);
  if (supersedes !== null && parseArtifactRef(supersedes) === null) {
    r.invalid(
      artifact,
      `${label}: 'supersedes' debe ser null o DES-NNN/XXX-NNN@rN`,
      "referenciá la revisión anterior completa, o null",
    );
  }
  if (wantsMaturity && maturity !== "outline" && maturity !== "handoff") {
    r.invalid(
      artifact,
      `${label}: 'maturity' debe ser 'outline' o 'handoff'`,
      "declará la madurez de esta revisión",
    );
    return null;
  }
  return {
    id,
    revision,
    path: typeof path === "string" ? path : "",
    supersedes: typeof supersedes === "string" ? supersedes : null,
    ...(wantsMaturity ? { maturity: maturity as DesignMaturity } : {}),
  };
}

function readAssets(r: Reader, node: Record<string, unknown>, artifact: string): AssetEntry[] {
  const out: AssetEntry[] = [];
  const seen = new Set<string>();
  for (const entry of eachRecord(r, node, "catalog.assets", artifact)) {
    const digest = r.read(entry, "catalog.assets[].digest");
    const path = r.read(entry, "catalog.assets[].path");
    if (!isDigest(digest)) {
      r.invalid(
        artifact,
        `catalog.assets: 'digest' debe ser 'sha256:' + 64 hex (recibido ${JSON.stringify(digest)})`,
        "recalculá el SHA-256 del asset",
      );
      continue;
    }
    if (seen.has(digest)) {
      r.fail(
        "DESIGN_ID_DUPLICATE",
        artifact,
        `el asset ${digest} está catalogado dos veces`,
        "los assets son content-addressed: una entrada por digest",
      );
      continue;
    }
    seen.add(digest);
    if (!checkPackagePath(r, artifact, "catalog.assets[].path", path)) continue;

    // Content-addressed on disk too: the digest lives in the file name, so an
    // asset can never be silently replaced by different bytes under the same path.
    const filename = (path as string).split("/").pop() as string;
    const bare = digest.slice("sha256:".length);
    if (!isAssetFilename(filename) || !filename.startsWith(`${bare}-`)) {
      r.invalid(
        artifact,
        `catalog.assets: '${String(path)}' no usa la forma <sha256>-<safe-name>.<ext> de su digest`,
        `renombrá el archivo a ${bare}-<nombre>.<ext>`,
      );
    }
    out.push({ digest, path: path as string });
  }
  return out;
}

function readCurrentness(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
  packageId: unknown,
  catalog: DesignCatalog,
): CurrentnessEntry[] {
  const catalogued = new Set<string>();
  for (const { key } of CATALOG_KINDS) {
    for (const entry of catalog[key]) {
      catalogued.add(`${entry.id}@r${entry.revision}`);
    }
  }

  const out: CurrentnessEntry[] = [];
  const seen = new Set<string>();
  for (const entry of eachRecord(
    r,
    raw,
    "currentness",
    artifact,
    " (vacío si nada fue superseded)",
  )) {
    const parsed = readCurrentnessEntry(r, entry, artifact, packageId, catalogued, seen);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function readCurrentnessEntry(
  r: Reader,
  entry: Record<string, unknown>,
  artifact: string,
  packageId: unknown,
  catalogued: ReadonlySet<string>,
  seen: Set<string>,
): CurrentnessEntry | null {
  const ref = r.read(entry, "currentness[].ref");
  const state = r.read(entry, "currentness[].state");

  const parsed = parseArtifactRef(ref);
  if (parsed === null) {
    r.invalid(
      artifact,
      `currentness: '${String(ref)}' no es una referencia DES-NNN/XXX-NNN@rN`,
      "referenciá el artefacto completo",
    );
    return null;
  }
  if (state !== "current" && state !== "superseded") {
    r.invalid(
      artifact,
      `currentness[${parsed.artifact}]: 'state' debe ser 'current' o 'superseded'`,
      "la currentness se deriva de supersedes; escribí uno de los dos valores",
    );
    return null;
  }
  if (seen.has(ref as string)) {
    r.fail(
      "DESIGN_ID_DUPLICATE",
      artifact,
      `currentness repite ${String(ref)}`,
      "una revisión tiene un solo estado de currentness",
    );
    return null;
  }
  seen.add(ref as string);
  if (isPackageId(packageId) && parsed.package !== packageId) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `currentness cita ${String(ref)}, de otro package`,
      "el manifest solo declara la currentness de sus propios artefactos",
    );
    return null;
  }
  if (!catalogued.has(`${parsed.artifact}@r${parsed.revision}`)) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `currentness cita ${String(ref)} y el catálogo no la contiene`,
      "catalogá esa revisión o quitá la entrada",
    );
    return null;
  }
  return { ref: ref as string, state };
}

function readGovernance(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
  baselines: BaselineEntry[],
): DesignGovernance {
  const node = r.read(raw, "governance");
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'governance' debe ser un objeto con 'reviews' y 'revocations'",
      "escribí ambas claves, con array vacío si no hay records",
    );
    return { reviews: [], revocations: [] };
  }
  r.closed(node, "governance", artifact);
  return {
    reviews: readGovernanceList(r, node, artifact, "reviews", "review", baselines),
    revocations: readGovernanceList(r, node, artifact, "revocations", "revocation", baselines),
  };
}

function readGovernanceList(
  r: Reader,
  node: Record<string, unknown>,
  artifact: string,
  key: "reviews" | "revocations",
  kind: DesignArtifactKind,
  baselines: BaselineEntry[],
): GovernanceEntry[] {
  const out: GovernanceEntry[] = [];
  const seen = new Set<string>();
  for (const entry of eachRecord(r, node, `governance.${key}`, artifact)) {
    const id = r.read(entry, `governance.${key}[].id`);
    const path = r.read(entry, `governance.${key}[].path`);
    const digest = r.read(entry, `governance.${key}[].digest`);
    const target = r.read(entry, `governance.${key}[].target`);

    if (!isArtifactId(id, kind)) {
      r.invalid(
        artifact,
        `governance.${key}: 'id' debe empezar con ${ARTIFACT_PREFIX[kind]}-`,
        `usá ${ARTIFACT_PREFIX[kind]}-NNN`,
      );
      continue;
    }
    if (seen.has(id)) {
      r.fail(
        "DESIGN_ID_DUPLICATE",
        artifact,
        `governance.${key} repite ${id}`,
        "cada record de gobierno tiene un id único",
      );
      continue;
    }
    seen.add(id);
    checkPackagePath(r, artifact, `governance.${key}[${id}].path`, path);
    if (!isDigest(digest)) {
      r.invalid(
        artifact,
        `governance.${key}[${id}]: 'digest' debe ser 'sha256:' + 64 hex`,
        "recalculá el digest propio del record",
      );
    }
    const ref = parseBaselineRef(target);
    if (ref === null) {
      r.invalid(
        artifact,
        `governance.${key}[${id}]: 'target' debe ser DES-NNN@rN`,
        "un record decide sobre un baseline exacto",
      );
      continue;
    }
    if (!baselines.some((b) => b.revision === ref.revision)) {
      r.fail(
        "DESIGN_RELATION_BROKEN",
        artifact,
        `governance.${key}[${id}] decide sobre ${String(target)} y 'baselines' no la contiene`,
        "apuntá a un baseline publicado",
      );
      continue;
    }
    out.push({ id, path: path as string, digest: digest as string, target: target as string });
  }
  return out;
}

function readRelations(r: Reader, raw: Record<string, unknown>, artifact: string): DesignRelations {
  const node = r.read(raw, "relations");
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'relations' debe ser un objeto con 'specs' y 'plans'",
      "escribí ambas claves, con array vacío si el package todavía no tiene consumidores",
    );
    return { specs: [], plans: [] };
  }
  r.closed(node, "relations", artifact);
  return {
    specs: readRelationList(r, node, artifact, "specs"),
    plans: readRelationList(r, node, artifact, "plans"),
  };
}

function readRelationList(
  r: Reader,
  node: Record<string, unknown>,
  artifact: string,
  key: "specs" | "plans",
): string[] {
  const list = r.read(node, `relations.${key}`);
  if (!Array.isArray(list)) {
    r.invalid(
      artifact,
      `'relations.${key}' debe ser un array de paths del workspace`,
      `escribí 'relations.${key}': []`,
    );
    return [];
  }
  const out: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") {
      r.invalid(
        artifact,
        `'relations.${key}' solo admite paths de texto`,
        `revisá el array 'relations.${key}'`,
      );
      continue;
    }
    const safe = checkSafeRelativePath(value);
    if (!safe.ok) {
      r.fail(
        "DESIGN_PATH_UNSAFE",
        artifact,
        `relations.${key}: '${value}' ${safe.why}`,
        `usá un path relativo al workspace, por ejemplo docs/${key === "specs" ? "specs" : "plans"}/NNN-....md`,
      );
      continue;
    }
    if (out.includes(safe.path)) continue;
    out.push(safe.path);
  }
  return out;
}

/** A manifest path is package-relative and never escapes the package folder. */
function checkPackagePath(r: Reader, artifact: string, field: string, value: unknown): boolean {
  if (typeof value !== "string") {
    r.invalid(
      artifact,
      `${field} debe ser un path de texto relativo al package`,
      "escribí el path relativo, por ejemplo flows/FLW-001-r001-alta.md",
    );
    return false;
  }
  const safe = checkSafeRelativePath(value);
  if (!safe.ok) {
    r.fail(
      "DESIGN_PATH_UNSAFE",
      artifact,
      `${field}: '${value}' ${safe.why}`,
      "los paths del manifest son relativos al package y nunca salen de él",
    );
    return false;
  }
  return true;
}

function done(r: Reader, value: DesignManifest | null): DesignManifestValidation {
  return { ok: value !== null, value, failures: r.failures, touched: r.touched };
}
