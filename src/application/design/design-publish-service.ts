import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DesignMaturity } from "../../domain/design/artifact.js";
import { validateDesignArtifact } from "../../domain/design/artifact.js";
import {
  type DesignBaseline,
  type SelectionEntry,
  checkBaselineAuthority,
  computeBaselineDigest,
  validateDesignBaseline,
} from "../../domain/design/baseline.js";
import { ARTIFACT_PREFIX, parseArtifactId } from "../../domain/design/identity.js";
import type { CatalogEntry, DesignFailure, DesignManifest } from "../../domain/design/manifest.js";
import { validateDesignManifest } from "../../domain/design/manifest.js";
import { NAMING, type NamedKind, baselinePath, checkNaming } from "../../domain/design/naming.js";
import {
  currentRevisions,
  renderDesignMd,
  renderPackageMd,
} from "../../domain/design/projections.js";
import { KIND_LIST } from "../../domain/design/revision.js";
import { checkSafeRelativePath } from "../../domain/safe-path.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { SemanticFailure } from "../semantic-operation/protocol.js";
import { type PublishableArtifact, publishArtifacts } from "../semantic-operation/publish.js";
import { type DesignIndex, readDesignIndex } from "./design-index-service.js";

/**
 * Publishing a package revision: all of it, or none of it.
 *
 * A package is several files that only mean something together — the manifest,
 * the baseline that seals them, the artifacts themselves, the projections. Half
 * of that on disk is worse than none: a manifest that indexes a baseline nobody
 * wrote, or a baseline sealing bytes that are not there.
 *
 * So the order is strict, and the first write is late:
 *
 *   1. read the package and everything the revision will seal;
 *   2. build the whole candidate — manifest, baseline, projections;
 *   3. validate ALL of it, including the compare-and-swap against the base;
 *   4. only then hand the batch to `publishArtifacts`, which captures every
 *      previous state and rolls back on any failure.
 *
 * Nothing between 1 and 3 touches the filesystem for writing. Step 4 is
 * all-or-nothing by construction, and the new revision's files are written
 * EXCLUSIVELY so a concurrent publication loses the race instead of being
 * silently overwritten.
 */

export interface PublishFile {
  /** Package-relative path of a normative file this revision introduces. */
  path: string;
  content: string;
}

export interface PublishInput {
  packageId: string;
  files: PublishFile[];
  /** Publication date. Passed in: the domain never reads the clock. */
  published: string;
  /**
   * The baseline the caller PREPARED against (`DES-001@r1`, or `null` for a
   * package with nothing published). REQUIRED: this is the compare-and-swap,
   * and a safety check that can be omitted is a safety check nobody performs.
   * Stating `null` for a fresh package is a claim the caller can be wrong about
   * — which is the point.
   */
  expectedBase: string | null;
}

export interface PublishOutcome {
  revision: number;
  baseline: DesignBaseline;
  /** Workspace-relative paths written, in the order they were written. */
  written: string[];
}

export type PublishResolution =
  | { ok: true; value: PublishOutcome }
  | { ok: false; failures: DesignFailure[] };

export async function publishDesignRevision(
  fs: FileSystemPort,
  workspace: string,
  input: PublishInput,
): Promise<PublishResolution> {
  const unsafe = input.files.flatMap((f) => pathFailure(f.path));
  if (unsafe.length > 0) return { ok: false, failures: unsafe };

  const index = await readDesignIndex(fs, workspace);
  const located = locate(index, input.packageId);
  if ("failures" in located) return { ok: false, failures: located.failures };
  const { manifest, packagePath } = located;

  const current = manifest.current_baseline;
  const actual = current === null ? null : `${manifest.id}@r${current.revision}`;
  if (input.expectedBase !== actual) {
    return {
      ok: false,
      failures: [
        {
          code: "DESIGN_BASE_STALE",
          artifact: `${packagePath}/design-manifest.json`,
          message: `preparaste sobre ${input.expectedBase ?? "ninguna revisión"} y la vigente es ${actual ?? "ninguna"}`,
          action:
            "alguien publicó mientras preparabas esta: releé el package y rehacé la revisión sobre la base nueva",
        },
      ],
    };
  }

  const catalog = mergeCatalog(manifest, input.files);
  if ("failures" in catalog) return { ok: false, failures: catalog.failures };

  const revision = (manifest.current_baseline?.revision ?? 0) + 1;
  const selection = await buildSelection(fs, workspace, packagePath, catalog.value, input.files);
  if ("failures" in selection) return { ok: false, failures: selection.failures };

  const baseline = sealBaseline(manifest, revision, input.published, selection.value);
  const nextManifest = nextManifestOf(manifest, catalog.value, baseline);

  const failures = validateCandidate(nextManifest, baseline, packagePath);
  if (failures.length > 0) return { ok: false, failures };

  const artifacts = candidateArtifacts(packagePath, nextManifest, baseline, input.files);
  const published = await publishArtifacts(fs, workspace, artifacts);
  if (!published.ok)
    return { ok: false, failures: [publishFailure(published.failure, packagePath)] };
  return { ok: true, value: { revision, baseline, written: published.value.written } };
}

/**
 * Every published path, checked at the ENTRANCE.
 *
 * Not inside the per-kind branches: an asset whose digest was already
 * catalogued used to skip the catalog — and with it the only path check there
 * was — while still being written, and `join(root, path)` normalizes `..`.
 * A file escaped the workspace through the one branch that had no guard.
 */
function pathFailure(path: string): DesignFailure[] {
  const check = checkSafeRelativePath(path);
  if (check.ok) return [];
  return [
    {
      code: "DESIGN_PATH_UNSAFE",
      artifact: path,
      message: `'${path}' ${check.why}`,
      action: "una publicación escribe DENTRO de su package: usá una ruta relativa sin '..'",
    },
  ];
}

/** Last resort: a package with no manifest and no diagnosis of its own. */
function brokenManifest(packagePath: string): DesignFailure {
  return {
    code: "DESIGN_MANIFEST_MISSING",
    artifact: `${packagePath}/design-manifest.json`,
    message: "el package no tiene un manifest legible",
    action: "reparalo antes de publicar sobre él",
  };
}

/**
 * A publication failure said in this domain's terms.
 *
 * The generic layer offers «confirmá la sobrescritura, o publicá en otro
 * destino»: here both are ILLEGAL — overwriting a published baseline destroys
 * an immutable revision, and a revision has no other destination. And the
 * artifact named must be the file to fix, not the dossier it lives in.
 */
function publishFailure(failure: SemanticFailure, packagePath: string): DesignFailure {
  // `publishArtifacts` ya nombra la ruta relativa al workspace entre comillas.
  const quoted = /'([^']+)'/.exec(failure.message);
  const artifact = quoted?.[1] ?? packagePath;
  if (failure.code !== "PUBLISH_TARGET_EXISTS") {
    return { ...failure, artifact };
  }
  return {
    code: "DESIGN_BASE_STALE",
    artifact,
    message: `'${artifact}' ya existe: alguien publicó esta revisión mientras preparabas`,
    action:
      "releé el package y rehacé la revisión sobre la base nueva: una publicada no se reescribe",
  };
}

function locate(
  index: DesignIndex,
  packageId: string,
): { manifest: DesignManifest; packagePath: string } | { failures: DesignFailure[] } {
  const found = index.packages.filter((p) => p.id === packageId || p.declared_id === packageId);
  if (found.length > 1) {
    return {
      failures: [
        {
          code: "DESIGN_REFERENCE_AMBIGUOUS",
          artifact: index.root,
          message: `${packageId} está declarado por ${found.length} packages`,
          action: "dos packages no pueden reclamar la misma identidad: renombrá uno",
        },
      ],
    };
  }
  const entry = found[0];
  if (entry === undefined) {
    return {
      failures: [
        {
          code: "DESIGN_REFERENCE_MISSING",
          artifact: index.root,
          message: `no hay un package ${packageId} bajo ${index.root}/`,
          action: "revisá 'aw designs': publicar exige un package existente",
        },
      ],
    };
  }
  // Un package ROTO no es un package inexistente: son problemas muy distintos
  // para quien tiene que arreglar uno, así que se devuelven sus fallos reales.
  if (entry.manifest == null) {
    return { failures: entry.failures.length > 0 ? entry.failures : [brokenManifest(entry.path)] };
  }
  return { manifest: entry.manifest as DesignManifest, packagePath: entry.path };
}

/**
 * The catalog this revision will have: the current one plus what it introduces.
 *
 * Two rules the first draft got backwards. A published document is VALIDATED
 * before it is sealed — sealing bytes that do not satisfy their own contract
 * makes the seal a lie. And for a flow or a screen the **frontmatter** is the
 * authority for identity, revision and maturity (spec § *Canonical authority*):
 * the file name must AGREE with it, never define it.
 */
function mergeCatalog(
  manifest: DesignManifest,
  files: PublishFile[],
): { value: DesignManifest["catalog"] } | { failures: DesignFailure[] } {
  const catalog = structuredClone(manifest.catalog);
  const failures: DesignFailure[] = [];

  for (const file of files) {
    if (file.path.startsWith("assets/")) {
      failures.push(...addAsset(catalog, file));
      continue;
    }
    failures.push(...addArtifact(catalog, manifest.id, file));
  }
  return failures.length > 0 ? { failures } : { value: catalog };
}

/** One flow, screen, rule, token or rendition into the catalog it belongs to. */
function addArtifact(
  catalog: DesignManifest["catalog"],
  packageId: string,
  file: PublishFile,
): DesignFailure[] {
  const described = describeFile(file, packageId);
  if ("failures" in described) return described.failures;

  const { kind, id, revision, maturity, states, supersedes } = described.value;
  const list = catalog[KIND_LIST[kind]] as CatalogEntry[];
  if (list.some((e) => e.id === id && e.revision === revision)) {
    return [
      {
        code: "DESIGN_ID_DUPLICATE",
        artifact: file.path,
        message: `${id}@r${revision} ya está publicada`,
        action: "una revisión publicada no se reescribe: numerá la siguiente",
      },
    ];
  }
  const previous = list.filter((e) => e.id === id).reduce((max, e) => Math.max(max, e.revision), 0);
  list.push({
    id,
    revision,
    path: file.path,
    // El documento declara a quién supersede y F2 ya lo validó; acuñarlo desde
    // el catálogo publicaría un manifest que contradice lo que sella.
    supersedes:
      supersedes === undefined
        ? previous === 0
          ? null
          : `${packageId}/${id}@r${previous}`
        : supersedes,
    ...(maturity === undefined ? {} : { maturity }),
    ...(states === undefined ? {} : { states }),
  });
  return [];
}

/** An asset is content-addressed: its name has to be the digest of its bytes. */
function addAsset(catalog: DesignManifest["catalog"], file: PublishFile): DesignFailure[] {
  const digest = digestOf(new TextEncoder().encode(file.content));
  const expected = `assets/${digest.slice("sha256:".length)}-`;
  if (!file.path.startsWith(expected)) {
    return [
      {
        code: "DESIGN_FIELD_INVALID",
        artifact: file.path,
        message: "el nombre del asset no es el digest de su contenido",
        action: `renombralo a '${expected}<nombre>.<ext>'`,
      },
    ];
  }
  const twin = catalog.assets.find((a) => a.digest === digest);
  if (twin !== undefined) {
    // Escribirlo sin catalogarlo dejaría bytes dentro del package que ningún
    // baseline sella: un asset es su contenido, y ya tiene un nombre.
    return [
      {
        code: "DESIGN_ID_DUPLICATE",
        artifact: file.path,
        message: `ese contenido ya está publicado como '${twin.path}'`,
        action: "un asset se direcciona por su contenido: referenciá el que ya existe",
      },
    ];
  }
  catalog.assets.push({ digest, path: file.path });
  return [];
}

/**
 * What a published file IS. For a flow or a screen the frontmatter decides and
 * the path must match it; for the kinds F2 gave no frontmatter contract, the
 * name is the only declaration there is — and that is stated, not hidden.
 */
function describeFile(
  file: PublishFile,
  packageId: string,
): { value: PublishedIdentity } | { failures: DesignFailure[] } {
  const kind = kindOfPath(file.path);
  if (kind === null) {
    return {
      failures: [
        {
          code: "DESIGN_FIELD_INVALID",
          artifact: file.path,
          message: `'${file.path}' no está en ninguna carpeta de artefactos normativos`,
          action: `publicá bajo: ${[...Object.values(NAMING).map((r) => r.dir), "assets"].join(", ")}`,
        },
      ],
    };
  }
  if (kind === "flow" || kind === "screen") return describeDocument(file, packageId, kind);

  const name = file.path.slice(NAMING[kind].dir.length + 1);
  const parsed = /^((?:RUL|TOK|VIS)-[0-9]+)-r([0-9]{3,})-/.exec(name);
  if (parsed === null) {
    return {
      failures: [
        {
          code: "DESIGN_FIELD_INVALID",
          artifact: file.path,
          message: `'${file.path}' no lleva su identidad y revisión en el nombre`,
          action: `usá '${NAMING[kind].dir}/${ARTIFACT_PREFIX[kind]}-NNN-rNNN-<slug>${NAMING[kind].suffix}'`,
        },
      ],
    };
  }
  return { value: { kind, id: parsed[1] as string, revision: Number(parsed[2]) } };
}

/** What a published file declares itself to be, once the frontmatter is read. */
interface PublishedIdentity {
  kind: NamedKind;
  id: string;
  revision: number;
  maturity?: DesignMaturity;
  states?: string[];
  /** Declared by the document; `undefined` for the kinds with no frontmatter. */
  supersedes?: string | null;
}

/** A flow or a screen: validated, and its identity read from the frontmatter. */
function describeDocument(
  file: PublishFile,
  packageId: string,
  kind: "flow" | "screen",
): { value: PublishedIdentity } | { failures: DesignFailure[] } {
  const document = validateDesignArtifact(file.content, kind, file.path);
  if (!document.ok || document.value === null) return { failures: document.failures };

  const parsed = parseArtifactId(document.value.id);
  if (parsed === null || parsed.package !== packageId) {
    return {
      failures: [
        {
          code: "DESIGN_AUTHORITY_CONFLICT",
          artifact: file.path,
          message: `el frontmatter declara '${document.value.id}' y el package es ${packageId}`,
          action: "un artefacto se publica dentro del package que declara su id",
        },
      ],
    };
  }
  const naming = checkNaming(kind, file.path, parsed.artifact, document.value.revision);
  if (!naming.ok) {
    return {
      failures: [
        {
          code: "DESIGN_AUTHORITY_CONFLICT",
          artifact: file.path,
          message: `el frontmatter declara ${parsed.artifact}@r${document.value.revision} y ${naming.why}`,
          action: `el frontmatter manda: renombralo a '${naming.expected}'`,
        },
      ],
    };
  }
  return {
    value: {
      kind,
      id: parsed.artifact,
      revision: document.value.revision,
      maturity: document.value.maturity,
      supersedes: document.value.supersedes,
      ...(document.value.kind === "screen"
        ? { states: document.value.states.map((s) => s.anchor) }
        : {}),
    },
  };
}

/** Which artifact kind lives in the directory a path sits in. */
function kindOfPath(path: string): NamedKind | null {
  const kinds = Object.entries(NAMING) as Array<[NamedKind, (typeof NAMING)[NamedKind]]>;
  const match = kinds
    .sort(([, a], [, b]) => b.dir.length - a.dir.length)
    .find(([, rule]) => path.startsWith(`${rule.dir}/`));
  return match === undefined ? null : match[0];
}

/**
 * What the revision seals: the CURRENT revision of every artifact plus every
 * asset. A baseline says what the package IS at this revision, not what changed.
 */
async function buildSelection(
  fs: FileSystemPort,
  workspace: string,
  packagePath: string,
  catalog: DesignManifest["catalog"],
  files: PublishFile[],
): Promise<{ value: SelectionEntry[] } | { failures: DesignFailure[] }> {
  const incoming = new Map(files.map((f) => [f.path, f.content]));
  const entries: SelectionEntry[] = [];
  const failures: DesignFailure[] = [];

  for (const key of ["flows", "screens", "rules", "tokens", "renditions"] as const) {
    for (const entry of currentRevisions(catalog[key])) {
      const bytes = await bytesOf(fs, workspace, packagePath, entry.path, incoming);
      if (bytes === null) {
        failures.push(missingFile(entry.path, packagePath));
        continue;
      }
      entries.push({ path: entry.path, revision: entry.revision, sha256: digestOf(bytes) });
    }
  }
  for (const asset of catalog.assets) {
    const bytes = await bytesOf(fs, workspace, packagePath, asset.path, incoming);
    if (bytes === null) {
      failures.push(missingFile(asset.path, packagePath));
      continue;
    }
    entries.push({ path: asset.path, revision: null, sha256: digestOf(bytes) });
  }
  return failures.length > 0 ? { failures } : { value: entries };
}

/** Bytes of a file this revision publishes, or of one already on disk. */
async function bytesOf(
  fs: FileSystemPort,
  workspace: string,
  packagePath: string,
  path: string,
  incoming: Map<string, string>,
): Promise<Uint8Array | null> {
  const content = incoming.get(path);
  if (content !== undefined) return new TextEncoder().encode(content);
  const absolute = join(workspace, packagePath, path);
  if (!(await fs.exists(absolute))) return null;
  return fs.readBytes(absolute);
}

function missingFile(path: string, packagePath: string): DesignFailure {
  return {
    code: "DESIGN_REFERENCE_FILE_MISSING",
    artifact: `${packagePath}/${path}`,
    message: `el catálogo declara '${path}' y el archivo no está`,
    action: "restauralo o quitalo del catálogo: un baseline sella bytes que existen",
  };
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sealBaseline(
  manifest: DesignManifest,
  revision: number,
  published: string,
  selection: SelectionEntry[],
): DesignBaseline {
  const current = manifest.current_baseline;
  const sealed = {
    schema: "workline.design-baseline/v1",
    package: manifest.id,
    revision,
    parent_baseline: current === null ? null : `${manifest.id}@r${current.revision}`,
    published,
    selection,
  };
  return { ...sealed, digest: computeBaselineDigest(sealed) };
}

function nextManifestOf(
  manifest: DesignManifest,
  catalog: DesignManifest["catalog"],
  baseline: DesignBaseline,
): DesignManifest {
  const path = baselinePath(manifest.id, baseline.revision);
  return {
    ...manifest,
    catalog,
    currentness: deriveCurrentness(manifest.id, catalog),
    baselines: [
      ...manifest.baselines,
      {
        revision: baseline.revision,
        path,
        digest: baseline.digest,
        parent_baseline: baseline.parent_baseline,
        published: baseline.published,
      },
    ],
    current_baseline: { revision: baseline.revision, path, digest: baseline.digest },
  };
}

/**
 * Currentness is DERIVED, never authored: the highest revision of each artifact
 * is current and the rest are superseded. Minting `supersedes` and leaving the
 * index empty would publish a manifest that contradicts itself.
 */
function deriveCurrentness(
  packageId: string,
  catalog: DesignManifest["catalog"],
): DesignManifest["currentness"] {
  const out: DesignManifest["currentness"] = [];
  for (const key of ["flows", "screens", "rules", "tokens", "renditions"] as const) {
    const highest = new Map<string, number>();
    for (const entry of catalog[key]) {
      highest.set(entry.id, Math.max(highest.get(entry.id) ?? 0, entry.revision));
    }
    for (const entry of catalog[key]) {
      out.push({
        ref: `${packageId}/${entry.id}@r${entry.revision}`,
        state: entry.revision === highest.get(entry.id) ? "current" : "superseded",
      });
    }
  }
  return out;
}

/**
 * Everything, before anything is written. The compare-and-swap runs against the
 * manifest as it was READ, which is what makes it a swap: if the line moved
 * since, the candidate's parent no longer matches and the publication stops.
 */
function validateCandidate(
  after: DesignManifest,
  baseline: DesignBaseline,
  packagePath: string,
): DesignFailure[] {
  // Sin compare-and-swap acá: el candidato DERIVA su parent y su revisión del
  // mismo manifest contra el que se compararía, así que la guarda no podía
  // fallar nunca. El swap real es `expectedBase`, que el que llama declara.
  const manifestPath = `${packagePath}/design-manifest.json`;
  const baselineDoc = `${packagePath}/${baselinePath(after.id, baseline.revision)}`;

  const manifestCheck = validateDesignManifest(JSON.parse(JSON.stringify(after)), manifestPath);
  if (!manifestCheck.ok) return manifestCheck.failures;

  const baselineCheck = validateDesignBaseline(JSON.parse(JSON.stringify(baseline)), baselineDoc);
  if (!baselineCheck.ok) return baselineCheck.failures;

  return checkBaselineAuthority(manifestCheck.value as DesignManifest, baseline, baselineDoc);
}

/**
 * The batch. The new revision's files and its baseline are written EXCLUSIVELY —
 * a concurrent publication must lose the race, not overwrite an immutable
 * revision. The index and the projections are meant to be rewritten.
 */
function candidateArtifacts(
  packagePath: string,
  manifest: DesignManifest,
  baseline: DesignBaseline,
  files: PublishFile[],
): PublishableArtifact[] {
  const at = (path: string): string => `${packagePath}/${path}`;
  return [
    ...files.map((f) => ({ path: at(f.path), content: f.content, overwrite: false })),
    {
      path: at(baselinePath(manifest.id, baseline.revision)),
      content: `${JSON.stringify(baseline, null, 2)}\n`,
      overwrite: false,
    },
    { path: at("PACKAGE.md"), content: renderPackageMd(manifest), overwrite: true },
    // `design-system/` es CONDICIONAL: crear la carpeta en un package sin reglas
    // ni tokens inventaría estructura que la spec no pide.
    ...(manifest.catalog.rules.length + manifest.catalog.tokens.length > 0
      ? [
          {
            path: at("design-system/DESIGN.md"),
            content: renderDesignMd(manifest),
            overwrite: true,
          },
        ]
      : []),
    // ÚLTIMO, a propósito: el manifest es el interruptor que conmuta el package
    // a la revisión nueva. Escribirlo antes que las proyecciones deja una
    // ventana en la que un rollback fallido publica un baseline colgante.
    {
      path: at("design-manifest.json"),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      overwrite: true,
    },
  ];
}
