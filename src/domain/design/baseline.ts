import { createHash } from "node:crypto";
import { canonicalJson } from "../../application/semantic-operation/protocol.js";
import { checkSafeRelativePath } from "../safe-path.js";
import {
  ARTIFACT_PREFIX,
  isArtifactId,
  isAssetFilename,
  isDigest,
  isPackageId,
  isRevision,
  parseBaselineRef,
} from "./identity.js";
import type { DesignManifest } from "./manifest.js";
import { NAMING, type NamedKind, PROJECTIONS, checkNaming } from "./naming.js";
import { secretFailures } from "./secrets.js";
import {
  type AllowedKeys,
  type DesignFailure,
  Reader,
  eachRecord,
  isRecord,
} from "./validation.js";

/**
 * `baselines/DES-NNN-rNNN.json` — the immutable authority of one published
 * revision of a package.
 *
 * A baseline answers one question: *which exact bytes were published together*.
 * It enumerates a CLOSED selection of normative files with their revision and
 * the SHA-256 of their bytes, and seals that with a digest of its own.
 *
 * Two exclusions make the seal mean something:
 *
 * - the digest is computed over canonical JSON **without its own `digest`
 *   field**, so there is no self-reference to chase; and
 * - the selection excludes the mutable manifest, the governance records and the
 *   regenerable projections, so re-indexing the catalog or re-rendering
 *   `PACKAGE.md` can never alter a revision published months ago.
 *
 * Without the second one, every published digest would drift every time
 * somebody added a package relation — which is exactly the retroactive change
 * the contract exists to forbid.
 */

export const DESIGN_BASELINE_SCHEMA_ID = "workline.design-baseline/v1";

export interface SelectionEntry {
  /** Package-relative path of a normative file. */
  path: string;
  /** Revision the file's name carries; null for content-addressed assets. */
  revision: number | null;
  /** SHA-256 of the file's BYTES — not of a projection of them. */
  sha256: string;
}

export interface DesignBaseline {
  schema: string;
  package: string;
  revision: number;
  /** `DES-001@r1`, or null for the first baseline of the line. */
  parent_baseline: string | null;
  published: string;
  /** Over canonical JSON of everything EXCEPT this field. */
  digest: string;
  selection: SelectionEntry[];
}

export const ALLOWED_KEYS: AllowedKeys = {
  "": ["schema", "package", "revision", "parent_baseline", "published", "digest", "selection"],
  "selection[]": ["path", "revision", "sha256"],
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A date that EXISTS: `2026-13-45` has the shape and is not a day. */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Directories whose files a baseline may select. Everything else is excluded. */
const SELECTABLE_DIRS = [...Object.values(NAMING).map((r) => r.dir), "assets"];

export interface DesignBaselineValidation {
  ok: boolean;
  value: DesignBaseline | null;
  failures: DesignFailure[];
  touched: ReadonlySet<string>;
}

/**
 * The digest a baseline must carry. Excluding `digest` from its own input is
 * what makes it verifiable: anyone can recompute it from the file and compare.
 */
export function computeBaselineDigest(baseline: Omit<DesignBaseline, "digest">): string {
  const { schema, package: pkg, revision, parent_baseline, published, selection } = baseline;
  const sealed = {
    schema,
    package: pkg,
    revision,
    parent_baseline,
    published,
    // Sorted by path: a selection is a SET, so reordering the array is a
    // no-change. Digesting it as written would let a reformat reseal a revision
    // published months ago.
    selection: [...selection].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(sealed), "utf8").digest("hex")}`;
}

export function validateDesignBaseline(raw: unknown, artifact: string): DesignBaselineValidation {
  const r = new Reader(ALLOWED_KEYS);
  if (!isRecord(raw)) {
    r.fail(
      "DESIGN_BASELINE_NOT_OBJECT",
      artifact,
      "el baseline no es un objeto JSON",
      `reescribí '${artifact}' como un único objeto JSON conforme a ${DESIGN_BASELINE_SCHEMA_ID}`,
    );
    return done(r, null);
  }

  const schema = r.read(raw, "schema");
  if (schema !== DESIGN_BASELINE_SCHEMA_ID) {
    r.fail(
      "DESIGN_SCHEMA_UNKNOWN",
      artifact,
      `versión de formato no soportada: ${JSON.stringify(schema)}`,
      `este Workline entiende ${DESIGN_BASELINE_SCHEMA_ID}`,
    );
    return done(r, null);
  }

  r.closed(raw, "", artifact);
  const pkg = r.read(raw, "package");
  if (!isPackageId(pkg)) {
    r.invalid(
      artifact,
      `'package' no es un identificador DES-NNN: ${JSON.stringify(pkg)}`,
      "nombrá el package que este baseline sella",
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
  const parent = r.read(raw, "parent_baseline");
  checkParent(r, artifact, parent, pkg, revision);

  const published = r.read(raw, "published");
  if (typeof published !== "string" || !isCalendarDate(published)) {
    r.invalid(
      artifact,
      `'published' no es una fecha YYYY-MM-DD: ${JSON.stringify(published)}`,
      "escribí la fecha de publicación como YYYY-MM-DD",
    );
  }

  const selection = readSelection(r, raw, artifact);
  if (selection.length === 0 && r.failures.length === 0) {
    r.invalid(
      artifact,
      "'selection' está vacía y una revisión publica algo",
      "enumerá los archivos normativos que esta revisión sella",
    );
  }
  const digest = r.read(raw, "digest");
  if (!isDigest(digest)) {
    r.invalid(artifact, "'digest' debe ser 'sha256:' + 64 hex", "recalculá el digest del baseline");
  }

  for (const failure of secretFailures(raw, artifact)) r.failures.push(failure);
  if (r.failures.length > 0) return done(r, null);

  const value: DesignBaseline = {
    schema: DESIGN_BASELINE_SCHEMA_ID,
    package: pkg as string,
    revision: revision as number,
    parent_baseline: typeof parent === "string" ? parent : null,
    published: published as string,
    digest: digest as string,
    selection,
  };

  // The seal is only a seal if it matches. Checked last so a malformed baseline
  // is reported for what it is, not for a digest that could never have matched.
  const expected = computeBaselineDigest(value);
  if (value.digest !== expected) {
    r.fail(
      "DESIGN_DIGEST_MISMATCH",
      artifact,
      `el digest declarado no es el de este contenido (declara ${value.digest}, calcula ${expected})`,
      "recalculá el digest sobre el JSON canónico sin el campo 'digest', o restaurá el contenido sellado",
    );
    return done(r, null);
  }
  return done(r, value);
}

function checkParent(
  r: Reader,
  artifact: string,
  parent: unknown,
  pkg: unknown,
  revision: unknown,
): void {
  if (parent === null) {
    if (isRevision(revision) && revision !== 1) {
      r.fail(
        "DESIGN_RELATION_BROKEN",
        artifact,
        `r${revision} declara 'parent_baseline: null' y solo la primera revisión no tiene padre`,
        "encadenala con la revisión anterior del mismo package",
      );
    }
    return;
  }
  const ref = parseBaselineRef(parent);
  if (ref === null) {
    r.invalid(
      artifact,
      `'parent_baseline' debe ser null o DES-NNN@rN: ${JSON.stringify(parent)}`,
      "encadená el baseline con su padre",
    );
    return;
  }
  if (isPackageId(pkg) && ref.package !== pkg) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'parent_baseline' apunta a ${ref.package} y este baseline es de ${pkg}`,
      "una línea de baselines pertenece a un solo package; una divergencia crea OTRO package con 'derived_from'",
    );
    return;
  }
  if (isRevision(revision) && ref.revision !== revision - 1) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `r${revision} declara como padre a r${ref.revision} y su padre es r${revision - 1}`,
      "la línea es continua: no se saltean revisiones ni se bifurca",
    );
  }
}

/**
 * The closed selection. Two things are checked beyond shape: that every entry
 * is a file a baseline is ALLOWED to seal, and that the revision it declares is
 * the one its own name carries.
 */
function readSelection(
  r: Reader,
  raw: Record<string, unknown>,
  artifact: string,
): SelectionEntry[] {
  const out: SelectionEntry[] = [];
  const seen = new Set<string>();

  for (const entry of eachRecord(r, raw, "selection", artifact, " de archivos normativos")) {
    const path = r.read(entry, "selection[].path");
    const revision = r.read(entry, "selection[].revision");
    const sha256 = r.read(entry, "selection[].sha256");

    if (typeof path !== "string" || path.length === 0) {
      r.invalid(
        artifact,
        "cada entrada de 'selection' necesita 'path'",
        "escribí el path relativo al package",
      );
      continue;
    }
    const normalized = checkSelectable(r, artifact, path);
    if (normalized === null) continue;
    // Deduplicated on the NORMALIZED path, and Unicode-normalized with it: a
    // trailing space and an NFD spelling are the same file on disk, and sealing
    // it twice with two different SHA-256 leaves nobody able to say which is right.
    if (seen.has(normalized)) {
      r.fail(
        "DESIGN_ID_DUPLICATE",
        artifact,
        `'${normalized}' está seleccionado dos veces`,
        "una selección cerrada nombra cada archivo una vez",
      );
      continue;
    }
    seen.add(normalized);
    if (!isDigest(sha256)) {
      r.invalid(
        artifact,
        `selection['${normalized}']: 'sha256' debe ser 'sha256:' + 64 hex`,
        "hasheá los bytes del archivo",
      );
      continue;
    }
    if (!checkDeclaredRevision(r, artifact, normalized, revision)) continue;
    out.push({
      path: normalized,
      revision: typeof revision === "number" ? revision : null,
      sha256,
    });
  }
  return out;
}

/** Only normative files. The mutable index and the projections are excluded BY CONSTRUCTION. */
function checkSelectable(r: Reader, artifact: string, path: string): string | null {
  // FIRST, before any prefix reasoning: `flows/../governance/reviews/REV-001.json`
  // starts with `flows/` and would sail past every exclusion below. A traversal
  // does not just escape the package — it defeats the whole "by construction".
  const safe = checkSafeRelativePath(path);
  if (!safe.ok) {
    r.fail(
      "DESIGN_PATH_UNSAFE",
      artifact,
      `selection: '${path}' ${safe.why}`,
      "los paths de una selección son relativos al package y nunca salen de él",
    );
    return null;
  }
  const normalized = safe.path.normalize("NFC");
  if (PROJECTIONS.includes(normalized)) {
    r.fail(
      "DESIGN_SELECTION_FORBIDDEN",
      artifact,
      `'${normalized}' es una proyección regenerable y no puede sellarse`,
      "quitala de la selección: regenerarla cambiaría el digest de una revisión ya publicada",
    );
    return null;
  }
  if (normalized === "design-manifest.json" || normalized.startsWith("governance/")) {
    r.fail(
      "DESIGN_SELECTION_FORBIDDEN",
      artifact,
      `'${normalized}' es un índice mutable o un record de gobierno y no puede sellarse`,
      "quitalo de la selección: el catálogo y el gobierno cambian sin mintear una revisión",
    );
    return null;
  }
  if (!SELECTABLE_DIRS.some((dir) => normalized.startsWith(`${dir}/`))) {
    r.fail(
      "DESIGN_SELECTION_FORBIDDEN",
      artifact,
      `'${normalized}' no está en ninguna carpeta de artefactos normativos`,
      `una selección solo sella archivos bajo: ${SELECTABLE_DIRS.join(", ")}`,
    );
    return null;
  }
  return normalized;
}

/** An asset carries no revision; everything else carries it in its own name. */
function checkDeclaredRevision(
  r: Reader,
  artifact: string,
  path: string,
  revision: unknown,
): boolean {
  if (path.startsWith("assets/")) {
    if (revision !== null) {
      r.invalid(
        artifact,
        `selection['${path}']: un asset es content-addressed y no lleva revisión`,
        "poné 'revision': null",
      );
      return false;
    }
    // Content-addressed means the digest IS the name. Without this the selection
    // could seal `assets/logo.svg` with any sha256 at all.
    if (!isAssetFilename(path.slice("assets/".length))) {
      r.invalid(
        artifact,
        `selection['${path}']: un asset se nombra <sha256>-<nombre>.<ext>`,
        "renombrá el archivo con su propio digest adelante",
      );
      return false;
    }
    return true;
  }
  if (!isRevision(revision)) {
    r.invalid(
      artifact,
      `selection['${path}']: 'revision' debe ser un entero >= 1`,
      "declará la revisión que el archivo sella",
    );
    return false;
  }

  // The SAME naming rule the manifest applies, not a looser `includes`: an
  // `includes("-r001-")` accepts `flows/FLW-001-r002-nota-r001-vieja.md` as r1,
  // and a flow filed under `screens/`. One rule, one place.
  const kind = kindOfDirectory(path);
  if (kind === null) return true; // ya reportado por checkSelectable
  const id = path
    .slice(NAMING[kind].dir.length + 1)
    .split("-")
    .slice(0, 2)
    .join("-");
  // The id comes FROM the path, so checking the name against it would be
  // circular. What is not circular — and what actually catches a flow filed
  // under `screens/` — is that the prefix has to match the directory's kind.
  if (!isArtifactId(id, kind)) {
    r.invalid(
      artifact,
      `selection['${path}']: un ${kind} vive en '${NAMING[kind].dir}/' y su id empieza con ${ARTIFACT_PREFIX[kind]}-`,
      "movelo a la carpeta de su tipo, o corregí el id",
    );
    return false;
  }
  const check = checkNaming(kind, path, id, revision);
  if (check.ok) return true;
  r.fail("DESIGN_RELATION_BROKEN", artifact, `selection: ${check.why}`, `usá '${check.expected}'`);
  return false;
}

/** Which artifact kind lives in the directory a selected path sits in. */
function kindOfDirectory(path: string): NamedKind | null {
  const kinds = Object.entries(NAMING) as Array<[NamedKind, (typeof NAMING)[NamedKind]]>;
  // Longest directory first, so `design-system/rules` wins over any prefix of it.
  const match = kinds
    .sort(([, a], [, b]) => b.dir.length - a.dir.length)
    .find(([, rule]) => path.startsWith(`${rule.dir}/`));
  return match === undefined ? null : match[0];
}

function done(r: Reader, value: DesignBaseline | null): DesignBaselineValidation {
  return { ok: value !== null, value, failures: r.failures, touched: r.touched };
}

/**
 * The authority table, applied. Manifest and baseline describe overlapping
 * facts; where they disagree the NORMATIVE owner wins and the disagreement is
 * an error — never a silent reconciliation.
 */
export function checkBaselineAuthority(
  manifest: DesignManifest,
  baseline: DesignBaseline,
  artifact: string,
): DesignFailure[] {
  const failures: DesignFailure[] = [];
  const broken = (message: string, action: string): void => {
    failures.push({ code: "DESIGN_AUTHORITY_CONFLICT", artifact, message, action });
  };

  if (baseline.package !== manifest.id) {
    broken(
      `el baseline dice ser de ${baseline.package} y el manifest declara ${manifest.id}`,
      "un baseline vive dentro del package que sella",
    );
    return failures;
  }

  const indexed = manifest.baselines.find((b) => b.revision === baseline.revision);
  if (indexed === undefined) {
    broken(
      `el manifest no cataloga r${baseline.revision}`,
      "agregá la revisión a 'baselines' del manifest, o borrá el baseline huérfano",
    );
  } else {
    compareIndexEntry(broken, baseline, indexed);
  }
  compareSelectionAgainstCatalog(broken, manifest, baseline);
  return failures;
}

type Broken = (message: string, action: string) => void;

/** The baseline is the authority; the manifest merely indexes it. */
function compareIndexEntry(
  broken: Broken,
  baseline: DesignBaseline,
  indexed: DesignManifest["baselines"][number],
): void {
  const fields: Array<[string, string | null, string | null]> = [
    ["digest", indexed.digest, baseline.digest],
    ["parent_baseline", indexed.parent_baseline, baseline.parent_baseline],
    ["published", indexed.published, baseline.published],
  ];
  for (const [field, indexedValue, sealedValue] of fields) {
    if (indexedValue === sealedValue) continue;
    broken(
      `el manifest declara ${field}=${indexedValue ?? "null"} para r${baseline.revision} y el baseline sella ${sealedValue ?? "null"}`,
      `el baseline es la autoridad: copiá su '${field}' al manifest`,
    );
  }
  // No se compara `indexed.path`: `validateDesignManifest` ya exige el nombre
  // canónico de cada baseline, así que un manifest con otro path no llega hasta
  // acá. Duplicarlo sería una rama que ningún manifest válido puede alcanzar.
}

/**
 * Everything a baseline seals, the package must know about — otherwise the
 * revision publishes bytes its own catalog cannot name.
 */
function compareSelectionAgainstCatalog(
  broken: Broken,
  manifest: DesignManifest,
  baseline: DesignBaseline,
): void {
  const catalogued = new Set<string>();
  for (const list of Object.values(manifest.catalog)) {
    for (const entry of list) catalogued.add(entry.path);
  }
  for (const entry of baseline.selection) {
    if (catalogued.has(entry.path)) continue;
    broken(
      `el baseline sella '${entry.path}' y el catálogo del manifest no lo contiene`,
      "catalogá ese archivo en el manifest, o quitalo de la selección",
    );
  }
}

/**
 * Compare-and-swap. Publishing a revision states which baseline it believed was
 * current; if the line moved since, the publication is refused rather than
 * leaving two revisions claiming the same succession.
 */
export function checkPublicationBase(
  manifest: DesignManifest,
  candidate: DesignBaseline,
  artifact: string,
): DesignFailure | null {
  if (candidate.package !== manifest.id) {
    return {
      code: "DESIGN_AUTHORITY_CONFLICT",
      artifact,
      message: `la publicación trae un baseline de ${candidate.package} y el package es ${manifest.id}`,
      action: "un baseline se publica dentro del package que sella",
    };
  }
  if (manifest.baselines.some((b) => b.revision === candidate.revision)) {
    return {
      code: "DESIGN_BASE_STALE",
      artifact,
      message: `r${candidate.revision} ya está publicada`,
      action: "una revisión publicada no se republica: numerá la siguiente",
    };
  }

  const current = manifest.current_baseline;
  const expected = current === null ? null : `${manifest.id}@r${current.revision}`;

  if (candidate.parent_baseline !== expected) {
    return {
      code: "DESIGN_BASE_STALE",
      artifact,
      message: `la publicación parte de ${candidate.parent_baseline ?? "ninguna revisión"} y la vigente es ${expected ?? "ninguna"}`,
      action:
        "alguien publicó mientras preparabas esta: releé el package y rehacé la revisión sobre la base nueva",
    };
  }
  const next = current === null ? 1 : current.revision + 1;
  if (candidate.revision !== next) {
    return {
      code: "DESIGN_BASE_STALE",
      artifact,
      message: `la publicación numera r${candidate.revision} y la siguiente de la línea es r${next}`,
      action: "la línea es continua: numerá la revisión que sigue a la vigente",
    };
  }
  return null;
}
