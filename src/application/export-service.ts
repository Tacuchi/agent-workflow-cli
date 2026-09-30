import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isCorrelative, leadingCorrelative, sameCorrelative } from "../domain/correlative.js";
import { baseDigest } from "../domain/proposal.js";
import { FOLDER_RESERVATION_MARKER, reservationMarker } from "../domain/reservation.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { appendClaimEvent } from "./claims-ledger.js";
import { localDateIso } from "./dates.js";
import { runNextNumber } from "./dev-only-services.js";
import { resolveDocsCanon } from "./docs-canon-service.js";
import { type CatalogLookup, checkExportCatalog } from "./export-catalog-check.js";
import { appendPublications, publicationRows } from "./history-publications.js";
import { publishedCorrelatives } from "./history-publications.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { type ReleaseDataInput, runReleaseData } from "./release-data-service.js";
import { readScriptsArtifacts } from "./release-data/artifacts.js";
import type { GraduatedBundle, StandaloneSql } from "./release-data/bundles.js";
import { listGraduatedBundles, listStandaloneSql } from "./release-data/bundles.js";
import { collectFilesByExt } from "./release-data/common.js";
import { derivePasses, readReleasePasses } from "./release-pass-ledger.js";
import {
  type SemanticArtifact,
  type SemanticFailure,
  type SemanticParse,
  type SemanticRequest,
  approvalDigest,
  buildSemanticRequest,
  parseSemanticResponse,
  readEnvelopeScope,
  semanticDigest,
} from "./semantic-operation/protocol.js";
import { publishArtifacts } from "./semantic-operation/publish.js";
import { resolveSessionTarget } from "./session-resolver.js";

/**
 * The four `export-*` commands, over one protocol.
 *
 * They differ only in their **policy**: which folder they own, what a valid
 * dossier looks like there, and whether anything may be overwritten. Corpus
 * selection, numbering, validation, authorization and the atomic publication
 * are shared and belong to the CLI — the AI only synthesizes the documents.
 *
 * Each export writes into exactly ONE `docs/` folder. A dossier is published as
 * a unit: a failure halfway through leaves zero final files.
 */

export type ExportCategory = "diagrams" | "manuals" | "reports" | "scripts";

export const EXPORT_CATEGORIES: readonly ExportCategory[] = [
  "diagrams",
  "manuals",
  "reports",
  "scripts",
];

interface CategoryPolicy {
  /** The single folder this export may write, unless the workspace canon moves it. */
  dir: string;
  /** `dossier` = a numbered directory of files; `document` = one numbered file. */
  shape: "dossier" | "document";
  /** Files that MUST be present in a dossier. */
  required: string[];
  /** Allowed extensions inside the destination. */
  extensions: string[];
  /** A file NAME, directly under the category folder, this export may replace. */
  overwritable?: string;
  contract: string;
}

/** A policy whose folder is the one this workspace actually publishes to. */
interface ResolvedPolicy extends Omit<CategoryPolicy, "overwritable"> {
  /** Full workspace-relative path of the overwritable file, or null. */
  overwritable: string | null;
}

/**
 * The generated contract for `export-scripts`, also mirrored by its direct
 * command guide. Keep its semantic anchors exported so a small parity guard
 * catches doctrine that drifts away from what the CLI actually sends.
 */
export const SCRIPTS_FINAL_STATE_CONTRACT =
  "Un dossier con README.md y rollback/00-global/00-ROLLBACK.sql obligatorios. Forwards NN-<nombre>.sql en 01-ddl-tablas/, 02-ddl-funciones/, 03-migracion/, 04-inserts/ o 05-grants/, numerados desde 01 dentro de cada carpeta; por cada forward, rollback/<categoría>/NN-<nombre>.rollback.sql. Ningún .sql en la raíz ni directamente en rollback/. El CLI NUNCA ejecuta SQL. El bundle publica el ESTADO FINAL NETO de la secuencia, no una réplica por sesión: lo que nace y muere dentro de la secuencia se omite; lo migrado va directo a su forma final; lo que el contexto declara retirado se omite aunque ningún script lo elimine. 00-ROLLBACK.sql invierte ese ESTADO FINAL en orden seguro para las dependencias, no el reverso literal de los forwards. Reconciliá contra el código además de las sesiones y la base. Excluí identidades concretas y semillas de prueba; conservá sólo objetos compartidos y necesarios para el estado final. Un bundle previo que entra al origen es MATERIAL A RECONCILIAR, no historia intocable: dos bundles que se contradicen publican el estado final neto resultante, nunca su suma cronológica.";

export const SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS = [
  "ESTADO FINAL NETO",
  "orden seguro para las dependencias",
  "objetos compartidos y necesarios para el estado final",
  "MATERIAL A RECONCILIAR",
] as const;

const POLICIES: Record<ExportCategory, CategoryPolicy> = {
  diagrams: {
    dir: "docs/diagrams",
    shape: "dossier",
    required: ["README.md"],
    extensions: [".md", ".dsl", ".puml", ".mmd", ".dot"],
    contract:
      "Un dossier con README.md obligatorio y diagramas en Markdown o fuente textual (.dsl/.puml/.mmd/.dot), sin notación obligatoria.",
  },
  manuals: {
    dir: "docs/manuals",
    shape: "dossier",
    required: ["README.md"],
    extensions: [".md"],
    // The only file an export may replace, and only with an explicit approval.
    overwritable: "INDEX.md",
    contract:
      "Un dossier con README.md obligatorio y los manuales en Markdown. Podés incluir el INDEX.md de la categoría para actualizar el índice: es el ÚNICO archivo sobrescribible y exige aprobación explícita.",
  },
  reports: {
    dir: "docs/reports",
    shape: "document",
    required: [],
    extensions: [".md"],
    contract:
      "UN informe en Markdown que declare su audiencia y su acotación en las primeras líneas.",
  },
  scripts: {
    dir: "docs/scripts",
    shape: "dossier",
    required: ["rollback/00-global/00-ROLLBACK.sql", "README.md"],
    extensions: [".sql", ".md", ".json"],
    contract: SCRIPTS_FINAL_STATE_CONTRACT,
  },
};

const FORWARD_MAX_BYTES = 512 * 1024;
const LIMITS = { max_artifacts: 64, max_artifact_bytes: 4 * 1024 * 1024 };
const SCRIPT_CATEGORIES = [
  "01-ddl-tablas",
  "02-ddl-funciones",
  "03-migracion",
  "04-inserts",
  "05-grants",
] as const;
const FORWARD_RE = /^(\d{2})-(?!.*\.rollback\.sql$)[^/]+\.sql$/;

/**
 * Everything `prepare` resolved about WHICH work this export covers and HOW its
 * unit is named — the whole of what a later stage would otherwise re-derive.
 *
 * It travels inside the request and comes back verbatim in the answer, which is
 * what lets `validate` and `apply` rebuild the same preparation. `date` and
 * `next` belong here for the same reason the filters do: they are not workspace
 * state (the day is the clock's, and the real number is minted inside the lock
 * anyway), but the unit's name is built from them, so re-deriving them at a
 * later stage renames the destination the answer was written against.
 */
export interface ExportScope {
  code?: string;
  catalog?: string;
  reservationOwner?: string;
  reservationMaterialDigest?: string;
  sessions?: string[];
  since?: string;
  source?: string;
  /** The base the material starts from. Absent = the session corpus, as always. */
  from?: ExportBase;
  /** Pieces the invocation subtracted by name, as the inventory spells them. */
  exclude?: string[];
  /** The destination environment. What already ran there drops out of the material. */
  environment?: string;
  /** The day that names the unit. */
  date: string;
  /** Number assigned to the unit; apply writes exactly this number. */
  next: string;
  /** Per-key seals for the scope fields above; travels with the envelope. */
  seal?: Record<string, string>;
}

/**
 * Which base the material starts from.
 *
 * `sessions` is what the command always did and stays the default: an
 * invocation that names no base produces exactly the material it produced
 * before this existed. `bundles` re-consolidates what `docs/scripts` already
 * published, and `workspace` sweeps everything the workspace holds.
 */
export type ExportBase = "sessions" | "bundles" | "workspace";

const EXPORT_BASES: readonly ExportBase[] = ["sessions", "bundles", "workspace"];

/** Where one piece of the material actually came from — the base resolves into these. */
export type MaterialOrigin = "sessions" | "standalone-sql" | "bundles";

/**
 * A piece the composition left out, and WHY.
 *
 * The reason is the whole point of listing it: an exclusion the invocation
 * asked for and one the release book imposed look identical in the resulting
 * bundle, and only the first is something the person can take back.
 */
export interface ExcludedPiece {
  origin: MaterialOrigin;
  name: string;
  path: string;
  /** `manual` = the invocation named it · `applied` = the book says it already ran. */
  reason: "manual" | "applied";
}

/**
 * What the destination environment took out of the material, and what the book
 * had to say about it.
 *
 * `no-record` is reported as itself and never as "nothing was applied": a book
 * that says nothing about an environment is a book nobody told about it, and
 * reading its silence as "nothing ran there" is exactly how SQL that already ran
 * would be handed to an operator a second time.
 *
 * `scanned` is the other half of that honesty. The filter can only look at
 * bundles — SQL still living in a session was never delivered, so it cannot have
 * run — and a zero here says the filter had nothing to look at rather than
 * letting an empty exclusion list read as "nothing was applied".
 */
export interface EnvironmentFilter {
  name: string;
  axis: "applied" | "no-record";
  scanned: number;
  excluded: number;
}

/** A scope not yet resolved: whatever the invocation declared, if anything. */
export type ExportSelection = Partial<ExportScope>;

export interface ExportPrepared {
  category: ExportCategory;
  request: SemanticRequest;
  /** The folder this workspace publishes the category to (canon or default). */
  dir: string;
  /** The scope this preparation resolved — echoed by the answer, never re-derived. */
  scope: ExportScope;
  /** Approved number, never reassigned by apply. */
  next: string;
  unit: string;
  /** CLI-derived origin for a scripts manifest; absent for other categories. */
  bundleOrigin?: BundleOrigin;
  availableBundles?: string[];
  reservationOwner?: string;
  reservationMaterialDigest?: string;
  existingManuals?: string[];
}

interface OriginFile {
  path: string;
  digest: string;
}
interface BundleOrigin {
  sessions: Array<{ session: string; files: OriginFile[] }>;
  standalone_sql: OriginFile[];
  bundles: Array<{ bundle: string; files: OriginFile[] }>;
}

export interface ExportPreview {
  category: ExportCategory;
  destination: string;
  files: Array<{ path: string; bytes: number }>;
  /** Present when the proposal replaces the category's overwritable file. */
  overwrites: string | null;
  replacements?: string[];
  mode?: "complement" | "flat" | "regenerate";
  unverified?: string[];
}

export interface ExportValidation {
  preview: ExportPreview;
  approval_digest: string;
}

export interface ExportApplied {
  category: ExportCategory;
  written: string[];
}

// ── prepare ──────────────────────────────────────────────────────────────────

export async function prepareExport(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  category: ExportCategory,
  selection: ExportSelection = {},
  // Injected so the midnight boundary is testable: a preparation that outlives
  // the day used to rename its own destination on the next stage.
  now: () => Date = () => new Date(),
  catalog?: CatalogLookup,
): Promise<SemanticParse<ExportPrepared>> {
  const canon = await resolveDocsCanon(fs, paths, EXPORT_CATEGORIES);
  if (!canon.ok) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_DESTINATION_INVALID",
        message: canon.error,
        action:
          "corregí la tabla [docs] de skills.toml, o quitala para usar el destino por defecto",
      },
    };
  }
  const policy = resolvePolicy(category, canon.canon[category]);
  const existingManuals = await listExistingManuals(fs, paths, category, policy.dir);
  const resolved = await resolveMaterial(fs, env, paths, category, selection);
  if (!resolved.ok) return resolved;
  const material = resolved.value;
  if (category === "scripts") {
    material.sessions = await sessionsWithSql(fs, paths, material.sessions);
    if (materialCount(material) === 0) return { ok: false, failure: emptyOrigin(material) };
  }

  // Pinned when the answer echoed them, derived only on a first preparation:
  // re-deriving either at `validate` renames the very unit the answer wrote to,
  // and neither is workspace state that a stale check should be defending.
  const date = selection.date ?? localDateIso(now());
  // Rejected HERE and not only when the envelope comes back: `prepare` used to
  // accept any string, mint `…-export-manuals-lunes` and let the composer be
  // blamed at `validate` for a scope it had copied verbatim, exactly as asked.
  // The invocation that supplied it is the one that can fix it.
  if (!DATE_RE.test(date)) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_SCOPE_INVALID",
        message: `--date '${date}' no tiene la forma YYYY-MM-DD`,
        action: "repetí la invocación con una fecha YYYY-MM-DD, o sin --date para usar la de hoy",
      },
    };
  }
  const catalogFailure = await checkSelectedCatalog(selection, catalog);
  if (catalogFailure !== null) return catalogFailure;
  const scriptsMaterial = category === "scripts" ? await sqlMaterial(fs, paths, material) : null;
  const reservationOwner = await exportReservationOwner(
    fs,
    paths,
    category,
    policy.dir,
    date,
    selection,
    scriptsMaterial,
  );
  if ("failure" in reservationOwner) return { ok: false, failure: reservationOwner.failure };
  const owner = selection.reservationOwner ?? reservationOwner.owner;
  const materialDigest = selection.reservationMaterialDigest ?? semanticDigest(scriptsMaterial);
  const marker = owner === null ? null : reservationMarker(owner, materialDigest);
  async function checkReservation(): Promise<SemanticParse<never> | null> {
    if (category === "scripts" && selection.next !== undefined) {
      const markerPath = join(
        paths.workspaceDir(),
        policy.dir,
        `${selection.next}-export-scripts-${date}`,
        FOLDER_RESERVATION_MARKER,
      );
      if (!(await fs.exists(markerPath)) || (await fs.readText(markerPath)) !== marker) {
        return {
          ok: false,
          failure: {
            code: "EXPORT_NUMBER_TAKEN",
            message: `la reserva ${selection.next} no está intacta`,
            action: "volvé a correr prepare sobre el material vigente",
          },
        };
      }
    }
    return null;
  }
  const reservationFailure = await checkReservation();
  if (reservationFailure !== null) return reservationFailure;
  async function reserveExportNumber(): Promise<string> {
    return (
      selection.next ??
      (
        await runNextNumber(fs, env, paths, {
          directory: policy.dir,
          ...(owner === null
            ? { dryRun: true }
            : {
                claim: {
                  name: `export-scripts-${date}`,
                  owner,
                  folder: true,
                  material: materialDigest,
                },
              }),
        })
      ).next
    );
  }
  const next = await reserveExportNumber();
  const unit =
    policy.shape === "dossier" ? `${policy.dir}/${next}-export-${category}-${date}` : policy.dir;
  const scope = buildExportScope(selection, owner, materialDigest, date, next);

  scope.seal = Object.fromEntries(
    Object.entries(scope).map(([key, value]) => [key, baseDigest(JSON.stringify(value))]),
  );

  async function buildInventory() {
    const bundleOrigin =
      category === "scripts" ? await manifestOrigin(fs, paths, material) : undefined;
    const allBundles =
      category === "scripts" ? await listGraduatedBundles(fs, paths.workspaceDir(), paths) : [];
    const availableBundles =
      category === "scripts" ? allBundles.map((bundle) => basename(bundle.path)) : undefined;
    const looseSql =
      category === "scripts" ? await listStandaloneSql(fs, paths.workspaceDir(), paths) : [];
    const coveredSql = new Set(allBundles.flatMap((bundle) => bundle.origin_standalone_sql ?? []));
    const unbundledSql = looseSql.filter(
      (file) => !coveredSql.has(relative(paths.workspaceDir(), file.path).split(sep).join("/")),
    );
    const bundleWarnings =
      category === "scripts" && selection.environment !== undefined
        ? await environmentWarnings(fs, paths, selection.environment, material.bundles)
        : [];

    const inventory = {
      category,
      destination: unit,
      shape: policy.shape,
      required: policy.required,
      extensions: policy.extensions,
      overwritable: policy.overwritable,
      // What the material was composed from, and what stayed in and out of it —
      // declared BEFORE anything is composed, which is the only moment at which
      // the person can still disagree with the origin.
      origins: material.origins,
      sessions: material.sessions,
      bundles: material.bundles,
      standalone_sql: material.standalone,
      excluded: material.excluded,
      exclude_unmatched: material.unmatched,
      environment: material.environment,
      ...(bundleOrigin === undefined
        ? {}
        : {
            bundle_origin: bundleOrigin,
            available_bundles: availableBundles,
            unbundled_sql: unbundledSql,
            bundle_warnings: bundleWarnings,
          }),
      date,
    };

    return { inventory, bundleOrigin, availableBundles };
  }
  const { inventory, bundleOrigin, availableBundles } = await buildInventory();

  function buildExportRequest() {
    const readSet = materialPaths(material);
    return buildSemanticRequest({
      operation: `export-${category}`,
      // What the seal defends is workspace state: the MATERIAL the scope covers —
      // sessions, loose SQL and previously published bundles alike, since any of
      // them appearing or changing changes what the dossier should have contained
      // — and the folder this workspace publishes to. The scope rides along so an
      // altered echo cannot pass as the original one.
      inputs: {
        ...(scriptsMaterial === null
          ? {
              corpus: material.sessions,
              bundles: material.bundles,
              standalone: material.standalone,
            }
          : { sql: scriptsMaterial }),
        dir: policy.dir,
        ...(category === "manuals" ? { existing_manuals: existingManuals } : {}),
        scope,
        workspace: paths.workspaceDir(),
      },
      sealed: "el material del alcance o el destino declarado de la categoría",
      scope,
      contract: `${policy.contract} Cada pieza divisible (incluidos forwards) admite ${FORWARD_MAX_BYTES} B y se divide en más archivos; un informe, README.md, RUNBOOK.md o rollback/00-global/00-ROLLBACK.sql admite hasta ${LIMITS.max_artifact_bytes} B. Respondé artifacts con paths dentro de ${unit}${policy.overwritable === null ? "" : ` (o exactamente ${policy.overwritable})`}. El NNN aprobado es el número publicado: nunca se reasigna en apply. Copiá 'scope' TAL CUAL, incluido scope.seal, en tu respuesta.${category === "scripts" ? " Declará decisions.supersedes y decisions.requires como listas de nombres de bundles existentes; NO incluyas bundle.json: lo genera el CLI con los digests del origen y lo sella en validate." : ""}`,
      inventory,
      allowedDestinations: [
        unit,
        ...(category === "manuals"
          ? [policy.dir]
          : policy.overwritable === null
            ? []
            : [policy.overwritable]),
      ],
      limits: LIMITS,
      readSet,
      readSetBytes: readSet.length,
    });
  }
  const request = buildExportRequest();

  function preparedResult(): SemanticParse<ExportPrepared> {
    return {
      ok: true,
      value: {
        category,
        request,
        dir: policy.dir,
        scope,
        next,
        unit,
        ...(category === "manuals" ? { existingManuals } : {}),
        ...(bundleOrigin === undefined
          ? {}
          : {
              bundleOrigin,
              availableBundles: availableBundles ?? [],
              reservationOwner: owner ?? "",
              reservationMaterialDigest: materialDigest,
            }),
      },
    };
  }
  return preparedResult();
}

async function exportReservationOwner(
  fs: FileSystemPort,
  paths: PathsService,
  category: ExportCategory,
  dir: string,
  date: string,
  selection: ExportSelection,
  sql: unknown,
): Promise<{ owner: string | null } | { failure: SemanticFailure }> {
  if (category !== "scripts") return { owner: null };
  if (selection.code !== undefined) {
    const session = await resolveSessionTarget(fs, paths, {
      code: selection.code,
      intent: "write",
    });
    if (session.outcome !== "resolved")
      return {
        failure: {
          code: "EXPORT_SCOPE_INVALID",
          message: `--code ${selection.code} no resuelve una sesión activa`,
          action: "seleccioná una sesión activa o quitá --code",
        },
      };
    return { owner: session.session.folder };
  }
  return {
    owner: `operation-${semanticDigest({
      category,
      dir,
      date,
      sql,
      selection: {
        sessions: selection.sessions,
        since: selection.since,
        source: selection.source,
        from: selection.from,
        exclude: selection.exclude,
        environment: selection.environment,
        catalog: selection.catalog,
        date,
      },
    })}`,
  };
}

async function manifestOrigin(
  fs: FileSystemPort,
  paths: PathsService,
  material: ComposedMaterial,
): Promise<BundleOrigin> {
  const digest = async (path: string): Promise<OriginFile> => ({
    path,
    digest: `sha256:${createHash("sha256")
      .update(await fs.readBytes(path))
      .digest("hex")}`,
  });
  const sessions: BundleOrigin["sessions"] = [];
  for (const session of material.sessions) {
    const relativeRoot = session.path ?? session.folder;
    const root = isAbsolute(relativeRoot) ? relativeRoot : join(paths.workspaceDir(), relativeRoot);
    const files: OriginFile[] = [];
    for (const sql of await readScriptsArtifacts(fs, root)) {
      files.push({ path: sql.name, digest: (await digest(sql.path)).digest });
    }
    sessions.push({
      session: session.folder,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  const standalone_sql = await Promise.all(
    material.standalone.map(async (file) => ({
      path: relative(paths.workspaceDir(), file.path).split(sep).join("/"),
      digest: (await digest(file.path)).digest,
    })),
  );
  const bundles: BundleOrigin["bundles"] = [];
  for (const bundle of material.bundles) {
    const files = await Promise.all(
      (await collectFilesByExt(fs, bundle.path, "")).map(async (path) => ({
        path: relative(bundle.path, path).split(sep).join("/"),
        digest: (await digest(path)).digest,
      })),
    );
    bundles.push({
      bundle: basename(bundle.path),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  return {
    sessions,
    standalone_sql: standalone_sql.sort((a, b) => a.path.localeCompare(b.path)),
    bundles,
  };
}

/** Script seals depend on SQL bytes and paths, never on session metadata. */
async function sessionsWithSql(
  fs: FileSystemPort,
  paths: PathsService,
  sessions: MaterialSession[],
): Promise<MaterialSession[]> {
  const kept: MaterialSession[] = [];
  for (const session of sessions) {
    const root = session.path ?? session.folder;
    if (
      (await readScriptsArtifacts(fs, isAbsolute(root) ? root : join(paths.workspaceDir(), root)))
        .length > 0
    )
      kept.push(session);
  }
  return kept;
}

async function sqlMaterial(
  fs: FileSystemPort,
  paths: PathsService,
  material: ComposedMaterial,
): Promise<unknown[]> {
  const entries: Array<{ origin: string; path: string; digest: string }> = [];
  for (const session of material.sessions) {
    const path = session.path ?? session.folder;
    const root = isAbsolute(path) ? path : join(paths.workspaceDir(), path);
    for (const sql of await readScriptsArtifacts(fs, root)) {
      entries.push({
        origin: session.folder,
        path: sql.name,
        digest: baseDigest(await fs.readText(sql.path)),
      });
    }
  }
  for (const file of material.standalone) {
    entries.push({
      origin: "standalone-sql",
      path: file.path,
      digest: baseDigest(await fs.readText(file.path)),
    });
  }
  for (const bundle of material.bundles) {
    for (const file of await collectFilesByExt(fs, bundle.path, "")) {
      entries.push({
        origin: basename(bundle.path),
        path: relative(bundle.path, file).split(sep).join("/"),
        digest: `sha256:${createHash("sha256")
          .update(await fs.readBytes(file))
          .digest("hex")}`,
      });
    }
  }
  return entries.sort((a, b) => `${a.origin}/${a.path}`.localeCompare(`${b.origin}/${b.path}`));
}

/** The category's policy with the folder this workspace actually publishes to. */
function resolvePolicy(category: ExportCategory, dir: string | undefined): ResolvedPolicy {
  const { overwritable, ...base } = POLICIES[category];
  const resolved = dir ?? base.dir;
  return {
    ...base,
    dir: resolved,
    overwritable: overwritable === undefined ? null : `${resolved}/${overwritable}`,
  };
}

// ── the material, composed ───────────────────────────────────────────────────

type MaterialSession = { folder: string; path?: string };

/** The material a preparation starts from, already composed and already subtracted. */
interface ComposedMaterial {
  origins: MaterialOrigin[];
  sessions: MaterialSession[];
  bundles: GraduatedBundle[];
  standalone: StandaloneSql[];
  excluded: ExcludedPiece[];
  /** Names `--exclude` gave that matched no piece of this material. */
  unmatched: string[];
  /** Present only when the invocation named a destination environment. */
  environment: EnvironmentFilter | null;
}

/**
 * The composable origin belongs to the SQL bundle and to nothing else.
 *
 * The other three categories publish documents an author writes; there is no
 * previous manual to re-consolidate and no environment a diagram ran against.
 * Accepting the flags there would answer a question those categories never ask.
 */
function checkComposableSelection(
  category: ExportCategory,
  selection: ExportSelection,
): SemanticFailure | null {
  // Belonging comes FIRST: telling a category that does not compose its origin
  // which bases exist would send it to fix a value that was never going to be
  // read, and it would be rejected again on the next invocation.
  const named = (["from", "exclude", "environment", "code", "catalog"] as const).filter(
    (key) => selection[key] !== undefined,
  );
  if (category !== "scripts" && named.length > 0) {
    return {
      code: "EXPORT_SCOPE_INVALID",
      message: `${named.map((k) => `--${k}`).join(", ")} es del bundle de SQL: export-${category} parte siempre del corpus de sesiones`,
      action: "quitá esos flags, o usá aw export-scripts si lo que querés componer es el bundle",
    };
  }
  // Rejected HERE and not when the base is read, for the same reason a malformed
  // `--date` is: the invocation that supplied it is the one that can fix it, and
  // an unknown base silently read as one of the three would compose a different
  // origin than the one that was asked for.
  if (selection.from !== undefined && !EXPORT_BASES.includes(selection.from)) {
    return {
      code: "EXPORT_SCOPE_INVALID",
      message: `--from '${selection.from}' no es una base: ${EXPORT_BASES.join(", ")}`,
      action:
        "repetí la invocación con una de las tres bases, o sin --from para partir de las sesiones",
    };
  }
  return null;
}

/**
 * The material this preparation covers, or the reason there is none.
 *
 * The three ways it can fail — a base that is not one, an origin this category
 * does not compose, and an origin that came back empty — answer the same
 * question and travel together, so `prepare` reads as the sequence it is.
 */
async function resolveMaterial(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  category: ExportCategory,
  selection: ExportSelection,
): Promise<SemanticParse<ComposedMaterial>> {
  const invalid = checkComposableSelection(category, selection);
  if (invalid !== null) return { ok: false, failure: invalid };
  const material = await composeMaterial(fs, env, paths, selection);
  if ("error" in material) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_CORPUS_UNAVAILABLE",
        message: material.error,
        action: "revisá el workspace y los filtros --sessions/--since/--source",
      },
    };
  }
  if (materialCount(material) === 0) return { ok: false, failure: emptyOrigin(material) };
  return { ok: true, value: material };
}

/**
 * Why the origin came back empty — and "everything already ran" is its own answer.
 *
 * Proposing a bundle with nothing in it would be the wrong outcome twice over:
 * there is nothing to deliver, and the reason there is nothing is good news the
 * person asked for. Folding it into the generic empty corpus would send them
 * looking for a filter to widen.
 */
function emptyOrigin(material: ComposedMaterial): SemanticFailure {
  const applied = material.excluded.filter((item) => item.reason === "applied");
  if (applied.length > 0 && material.environment !== null) {
    return {
      code: "EXPORT_ORIGIN_ALREADY_APPLIED",
      message: `todo el material que quedaba en el origen ya consta aplicado en '${material.environment.name}': no hay nada que consolidar`,
      action: `nada que hacer; si igual querés reconsolidarlo, repetí la invocación sin --environment ${material.environment.name}`,
    };
  }
  return {
    code: "EXPORT_CORPUS_EMPTY",
    message: `ningún material del origen (${material.origins.join(", ")}) coincide con los filtros`,
    action:
      "ampliá --since, quitá --sessions o --exclude, probá otro --from, o revisá que existan sesiones cerradas",
  };
}

/**
 * The material of this preparation: a base brings, the exclusions subtract.
 *
 * Both halves in one place, because "where did this come from" and "why is this
 * not here" are the two questions `prepare` has to answer together — and the
 * listings the bases read are the ones `release-data` already produces, walked
 * once by it rather than twice by this.
 */
async function composeMaterial(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  selection: ExportSelection,
): Promise<ComposedMaterial | { error: string }> {
  const base = selection.from ?? "sessions";
  const input: ReleaseDataInput = {
    includeClosed: true,
    // A base of `sessions` is the behavior that always was: graduated bundles are
    // previous exports and re-exporting them would duplicate what already lives
    // in docs/. The other bases are asking for exactly that material.
    includeGraduated: base !== "sessions",
    includeStandaloneSql: base === "workspace",
    ...(selection.sessions !== undefined ? { sessions: selection.sessions } : {}),
    ...(selection.since !== undefined ? { since: selection.since } : {}),
    ...(selection.source !== undefined ? { sourceAlias: selection.source } : {}),
  };
  const data = await runReleaseData(fs, env, paths, input);
  if ("error" in data) return { error: data.error };

  const sessions = base === "bundles" ? [] : (data.sessions as MaterialSession[]);
  const standalone = base === "workspace" ? (data.standalone_sql ?? []) : [];
  const bundles = base === "sessions" ? [] : (data.graduated_bundles ?? []);
  const origins: MaterialOrigin[] = [
    ...(base === "bundles" ? [] : (["sessions"] as const)),
    ...(base === "workspace" ? (["standalone-sql"] as const) : []),
    ...(base === "sessions" ? [] : (["bundles"] as const)),
  ];

  const named = new Set(selection.exclude ?? []);
  const manual: ExcludedPiece[] = [
    ...sessions.map((s) => piece("sessions", s.folder, s.path ?? s.folder)),
    ...standalone.map((f) => piece("standalone-sql", f.name, f.path)),
    ...bundles.map((b) => piece("bundles", bundleName(b), b.path)),
  ]
    .filter((item) => named.has(item.name))
    .map((item) => ({ ...item, reason: "manual" as const }));

  // A name that subtracted nothing is DECLARED, not rejected: the base or the
  // filters may have left that piece out already, and refusing an invocation
  // whose intent is served would be hostile. But a typo looks identical from
  // here, and staying silent would ship the very material the person believed
  // they had taken out — which is the failure this whole command exists against.
  const matched = new Set(manual.map((item) => item.name));
  const unmatched = [...named].filter((name) => !matched.has(name));

  // The environment subtracts from what the manual exclusions already left, and
  // by the SAME road: both are exclusions of pieces and differ only in the
  // reason the inventory declares, which is the whole of D-05.
  const kept = bundles.filter((b) => !named.has(bundleName(b)));
  const environment = await filterByEnvironment(fs, paths, selection.environment, kept);
  const excluded = [...manual, ...environment.excluded];
  const out = new Set(excluded.map((item) => item.name));

  return {
    origins,
    sessions: sessions.filter((s) => !out.has(s.folder)),
    bundles: bundles.filter((b) => !out.has(bundleName(b))),
    standalone: standalone.filter((f) => !out.has(f.name)),
    excluded,
    unmatched,
    environment: environment.filter,
  };
}

/**
 * Which of these bundles the book says already ran against this environment.
 *
 * The chain adds no new piece: a pass LINKS the bundle by workspace-relative
 * path and that same pass has an application for the environment. One record is
 * enough — a bundle linked to two passes where only one ran there did run, and
 * demanding unanimity would re-deliver SQL that is already in place, which is
 * the error this filter exists to prevent.
 */
async function filterByEnvironment(
  fs: FileSystemPort,
  paths: PathsService,
  environment: string | undefined,
  bundles: readonly GraduatedBundle[],
): Promise<{ excluded: ExcludedPiece[]; filter: EnvironmentFilter | null }> {
  if (environment === undefined) return { excluded: [], filter: null };
  const passes = derivePasses((await readReleasePasses(fs, paths)).events);
  const there = passes.filter(
    (derived) =>
      derived.application.axis === "applied" &&
      derived.application.environments.includes(environment),
  );
  // Both sides normalized to `/`: the book stores the path a person typed and
  // this one comes from the filesystem, so on Windows the same bundle would be
  // `docs/scripts/…` in one and `docs\\scripts\\…` in the other and nothing would
  // ever match — every bundle would read as pending and be delivered twice.
  const linked = new Set(there.flatMap((derived) => derived.artifacts).map(slashed));
  const excluded = bundles
    .filter((bundle) => linked.has(slashed(relative(paths.workspaceDir(), bundle.path))))
    .map((bundle) => ({
      ...piece("bundles", bundleName(bundle), bundle.path),
      reason: "applied" as const,
    }));
  return {
    excluded,
    filter: {
      name: environment,
      axis: there.length === 0 ? "no-record" : "applied",
      scanned: bundles.length,
      excluded: excluded.length,
    },
  };
}

async function environmentWarnings(
  fs: FileSystemPort,
  paths: PathsService,
  environment: string,
  bundles: readonly GraduatedBundle[],
): Promise<Array<{ code: string; bundle: string; detail: string }>> {
  const passes = derivePasses((await readReleasePasses(fs, paths)).events);
  const recorded = new Set(
    passes
      .filter(
        (pass) =>
          pass.application.axis === "applied" &&
          pass.application.environments.includes(environment),
      )
      .flatMap((pass) =>
        pass.artifacts.map((artifact) => basename(artifact.replaceAll("\\", "/"))),
      ),
  );
  const warnings: Array<{ code: string; bundle: string; detail: string }> = [];
  for (const bundle of bundles) {
    const name = basename(bundle.path);
    for (const newer of bundle.superseded_by ?? []) {
      warnings.push({ code: "BUNDLE_SUPERSEDED", bundle: name, detail: `superado por ${newer}` });
    }
    for (const requirement of bundle.requires ?? []) {
      if (!recorded.has(requirement))
        warnings.push({
          code: "BUNDLE_REQUIRES_UNRECORDED",
          bundle: name,
          detail: `${requirement} no consta aplicado en ${environment}`,
        });
    }
  }
  return warnings;
}

/** One spelling for a path that two different producers wrote. */
function slashed(path: string): string {
  return path.split(sep).join("/");
}

/** What names a bundle in `--exclude` and in the inventory: its directory. */
function bundleName(bundle: GraduatedBundle): string {
  return basename(bundle.path);
}

function piece(origin: MaterialOrigin, name: string, path: string): Omit<ExcludedPiece, "reason"> {
  return { origin, name, path };
}

/** How many pieces stayed in. Zero is an empty origin, whatever the base was. */
function materialCount(material: ComposedMaterial): number {
  return material.sessions.length + material.bundles.length + material.standalone.length;
}

/** Everything the composer has to read, across the three origins. */
function materialPaths(material: ComposedMaterial): string[] {
  return [
    ...material.sessions.map((s) => s.path ?? s.folder),
    ...material.standalone.map((f) => f.path),
    ...material.bundles.map((b) => b.path),
  ];
}

// ── the scope, travelling between stages ─────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The scope an answer echoes back, so `validate` and `apply` rebuild the
 * preparation the answer was written against.
 *
 * Three outcomes and no fourth: a scope that is there and well formed, no scope
 * at all (an answer written before this field existed — the invocation's own
 * flags still decide, exactly as they did), and a scope that is there but
 * malformed, which is a rejection. Reading a broken echo as "no echo" would
 * quietly export a different corpus than the one that was approved.
 */
export function readExportScope(raw: string): SemanticParse<ExportScope | null> {
  const echoed = readEnvelopeScope(raw);
  if (echoed === undefined || echoed === null) return { ok: true, value: null };
  if (typeof echoed !== "object" || Array.isArray(echoed)) return malformedScope("no es un objeto");

  const scope = echoed as Record<string, unknown>;
  const why = scopeShapeError(scope);
  if (why !== null) return malformedScope(why);
  return {
    ok: true,
    value: scopeFromRecord(scope),
  };
}

/** Why this echo is not the scope `prepare` emitted, or `null` when it is. */
function scopeShapeError(scope: Record<string, unknown>): string | null {
  const allowed = [
    "code",
    "catalog",
    "reservationOwner",
    "reservationMaterialDigest",
    "sessions",
    "since",
    "source",
    "from",
    "exclude",
    "environment",
    "date",
    "next",
    "seal",
  ];
  const unknown = Object.keys(scope).find((key) => !allowed.includes(key));
  if (unknown !== undefined) return `'${unknown}' no es una clave de scope`;
  const sealError = scopeSealError(scope);
  if (sealError !== null) return sealError;
  if (typeof scope.date !== "string" || !DATE_RE.test(scope.date)) {
    return "'date' tiene que ser YYYY-MM-DD";
  }
  if (typeof scope.next !== "string" || !isCorrelative(scope.next)) {
    return "'next' tiene que ser el correlativo de 3 dígitos";
  }
  if (scope.sessions !== undefined && !isStringArray(scope.sessions)) {
    return "'sessions' tiene que ser una lista de códigos de texto";
  }
  if (scope.exclude !== undefined && !isStringArray(scope.exclude)) {
    return "'exclude' tiene que ser una lista de nombres de texto";
  }
  if (scope.from !== undefined && !EXPORT_BASES.includes(scope.from as ExportBase)) {
    return `'from' tiene que ser ${EXPORT_BASES.join(", ")}`;
  }
  return scopeTextFieldError(scope);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function malformedScope(why: string): SemanticParse<ExportScope | null> {
  return {
    ok: false,
    failure: {
      code: "EXPORT_SCOPE_MISMATCH",
      message: `el 'scope' del sobre no tiene la forma que prepare emitió: ${why}`,
      action: "copiá el 'scope' del request TAL CUAL, sin reescribirlo",
    },
  };
}

/**
 * Scope flags the invocation repeated that CONTRADICT the echoed scope.
 *
 * Repeating them is still supported and still works — that is what every
 * existing invocation does. Repeating them with a different value is not the
 * same thing: one of the two answers is not the one the proposal was written
 * against, and picking either in silence hides which.
 */
export function conflictingScopeFlags(echoed: ExportScope, flags: ExportSelection): string[] {
  const same = (a: string[] | undefined, b: string[] | undefined): boolean =>
    (a ?? []).join(",") === (b ?? []).join(",");
  const conflicts: string[] = [];
  if (flags.sessions !== undefined && !same(flags.sessions, echoed.sessions)) {
    conflicts.push("--sessions");
  }
  if (flags.exclude !== undefined && !same(flags.exclude, echoed.exclude)) {
    conflicts.push("--exclude");
  }
  for (const [flag, key] of [
    ["--since", "since"],
    ["--source", "source"],
    ["--date", "date"],
    ["--from", "from"],
    ["--environment", "environment"],
    ["--code", "code"],
    ["--catalog", "catalog"],
  ] as const) {
    if (flags[key] !== undefined && flags[key] !== echoed[key]) conflicts.push(flag);
  }
  return conflicts;
}

// ── validate ─────────────────────────────────────────────────────────────────

export function validateExport(
  raw: string,
  prepared: ExportPrepared,
): SemanticParse<ExportValidation> {
  const scopeFailure = validateEchoedScope(raw, prepared);
  if (scopeFailure !== null) return scopeFailure;
  const parsed = parseSemanticResponse(raw, prepared.request);
  if (!parsed.ok) return parsed;

  const assembled = assembleExportArtifacts(parsed.value, prepared);
  if (!assembled.ok) return assembled;

  // From what was prepared, never from the policy table: the folder is the
  // workspace's, and re-reading it here would let the two stages disagree.
  const policy = resolvePolicy(prepared.category, prepared.dir);
  const artifacts = assembled.value;
  const inUnit = artifacts.filter((a) => a.path !== policy.overwritable);
  const manual =
    prepared.category === "manuals" ? manualShape(artifacts, policy, prepared.unit) : null;
  const replacements =
    manual === null
      ? []
      : artifacts
          .filter((artifact) => (prepared.existingManuals ?? []).includes(artifact.path))
          .map((artifact) => artifact.path);
  function overwrittenPath(): string | null {
    return manual === null
      ? artifacts.some((a) => a.path === policy.overwritable)
        ? policy.overwritable
        : null
      : replacements.includes(policy.overwritable ?? "")
        ? policy.overwritable
        : null;
  }
  const overwrites = overwrittenPath();
  const shape = manual === null ? checkShape(inUnit, policy, prepared.unit) : manual.failure;
  if (shape !== null) return { ok: false, failure: shape };
  if (invalidReportPath(policy, inUnit, prepared.next)) {
    return {
      ok: false,
      failure: reject(`el informe debe estar en ${policy.dir}/${prepared.next}-<slug>.md`),
    };
  }

  return {
    ok: true,
    value: {
      preview: {
        category: prepared.category,
        destination: manual !== null && manual.mode !== "regenerate" ? policy.dir : prepared.unit,
        files: artifacts.map((a) => ({
          path: a.path,
          bytes: Buffer.byteLength(a.content, "utf8"),
        })),
        overwrites,
        ...(manual === null ? {} : { mode: manual.mode, replacements }),
      },
      approval_digest: approvalDigest({ ...parsed.value, artifacts }),
    },
  };
}

/** When requested, the target catalog is consulted again over the proposed forwards. */
export async function validateExportWithCatalog(
  raw: string,
  prepared: ExportPrepared,
  catalog?: CatalogLookup,
): Promise<SemanticParse<ExportValidation>> {
  const validated = validateExport(raw, prepared);
  if (!validated.ok || prepared.scope.catalog === undefined) return validated;
  if (catalog === undefined)
    return {
      ok: false,
      failure: {
        code: "EXPORT_CATALOG_UNAVAILABLE",
        message: `no hay catálogo disponible para '${prepared.scope.catalog}'`,
        action: "revisá la conexión y repetí validate",
      },
    };
  const parsed = parseSemanticResponse(raw, prepared.request);
  if (!parsed.ok) return parsed;
  const assembled = assembleExportArtifacts(parsed.value, prepared);
  if (!assembled.ok) return assembled;
  const checked = await checkExportCatalog(
    assembled.value,
    prepared.unit,
    prepared.scope.catalog,
    catalog,
  );
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: {
      ...validated.value,
      preview: {
        ...validated.value.preview,
        unverified: checked.value.unverified,
      },
    },
  };
}

function manualShape(
  artifacts: readonly SemanticArtifact[],
  policy: ResolvedPolicy,
  unit: string,
): { mode: "complement" | "flat" | "regenerate"; failure: SemanticFailure | null } {
  const files = artifacts.filter((artifact) => artifact.path !== policy.overwritable);
  if (files.length === 0) return { mode: "complement", failure: null };
  const direct = files.every((artifact) => {
    const name = artifact.path.slice(policy.dir.length + 1);
    return (
      artifact.path.startsWith(`${policy.dir}/`) &&
      !name.includes("/") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)
    );
  });
  if (direct) return { mode: "flat", failure: null };
  if (files.every((artifact) => artifact.path.startsWith(`${unit}/`))) {
    return { mode: "regenerate", failure: checkShape(files, policy, unit) };
  }
  return {
    mode: "flat",
    failure: reject(
      "manuals admite sólo INDEX.md, archivos <slug>.md planos o un dossier numerado",
    ),
  };
}

function assembleExportArtifacts(
  response: { artifacts?: SemanticArtifact[]; decisions?: Record<string, unknown> },
  prepared: ExportPrepared,
): SemanticParse<SemanticArtifact[]> {
  const artifacts = response.artifacts ?? [];
  if (prepared.category !== "scripts") return { ok: true, value: artifacts };
  if (artifacts.some((a) => a.path === `${prepared.unit}/bundle.json`)) {
    return {
      ok: false,
      failure: reject("bundle.json lo genera el CLI; no lo incluyas en artifacts"),
    };
  }
  const decisions = readBundleDecisions(response, prepared);
  if (!decisions.ok) return decisions;
  const lists = decisions.value;
  const overlap = lists.supersedes.filter((name) => lists.requires.includes(name));
  if (overlap.length > 0)
    return {
      ok: false,
      failure: reject(`no se puede superar y requerir el mismo bundle: ${overlap.join(", ")}`),
    };
  const manifest = {
    version: 1,
    supersedes: lists.supersedes,
    requires: lists.requires,
    origin: prepared.bundleOrigin ?? { sessions: [], standalone_sql: [], bundles: [] },
  };
  return {
    ok: true,
    value: [
      ...artifacts,
      { path: `${prepared.unit}/bundle.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ],
  };
}

function checkShape(
  artifacts: SemanticArtifact[],
  policy: ResolvedPolicy,
  unit: string,
): SemanticFailure | null {
  if (artifacts.length === 0) return reject("la propuesta no trae ningún artefacto del dossier");
  if (policy.shape === "document" && artifacts.length > 1) {
    return reject(`esta categoría publica UN documento y llegaron ${artifacts.length}`);
  }

  const names = artifacts.map((a) => a.path.slice(unit.length + 1));
  for (const artifact of artifacts) {
    const failure = checkArtifactShape(artifact, policy, unit);
    if (failure !== null) return failure;
  }
  if (policy.required.includes("rollback/00-global/00-ROLLBACK.sql")) {
    return checkScriptsStructure(artifacts, unit);
  }
  for (const required of policy.required) {
    if (!names.includes(required)) return reject(`falta '${required}' en el dossier`);
  }
  return null;
}

/** Check all structural errors together, including broken citations in delivery instructions. */
function checkScriptsStructure(
  artifacts: SemanticArtifact[],
  unit: string,
): SemanticFailure | null {
  const names = new Set(artifacts.map((a) => a.path.slice(unit.length + 1)));
  // The CLI generates this file in the next phase; agents must not supply it.
  names.add("bundle.json");
  const failures = [
    ...["README.md", "rollback/00-global/00-ROLLBACK.sql"]
      .filter((required) => !names.has(required))
      .map((required) => `falta '${required}' en el dossier`),
    ...scriptLayoutFailures(names),
    ...scriptCitationFailures(artifacts, unit, names),
  ];
  return failures.length === 0 ? null : reject(failures.join("; "));
}

function scriptLayoutFailures(names: ReadonlySet<string>): string[] {
  const failures: string[] = [];
  const forwards = new Set<string>();
  const reverses = new Set<string>();
  for (const name of names) {
    const classified = classifyScriptPath(name);
    if (classified.kind === "forward") forwards.add(name);
    if (classified.kind === "reverse") reverses.add(classified.forward);
    if (classified.kind === "invalid") failures.push(classified.why);
  }
  if (forwards.size === 0) failures.push("el bundle no trae ningún forward NN-<nombre>.sql");
  for (const forward of forwards) {
    const inverse = `rollback/${forward.replace(/\.sql$/, ".rollback.sql")}`;
    if (!names.has(inverse)) failures.push(`falta '${inverse}' para '${forward}'`);
  }
  for (const reverse of reverses) {
    if (!forwards.has(reverse)) failures.push(`rollback huérfano para '${reverse}'`);
  }
  return [...failures, ...scriptNumberingFailures(forwards)];
}

function classifyScriptPath(
  path: string,
):
  | { kind: "forward" | "other" }
  | { kind: "reverse"; forward: string }
  | { kind: "invalid"; why: string } {
  if (!path.endsWith(".sql") || path === "rollback/00-global/00-ROLLBACK.sql")
    return { kind: "other" };
  if (path.startsWith("rollback/")) {
    const match =
      /^rollback\/(01-ddl-tablas|02-ddl-funciones|03-migracion|04-inserts|05-grants)\/(\d{2}-[^/]+)\.rollback\.sql$/.exec(
        path,
      );
    return match
      ? { kind: "reverse", forward: `${match[1]}/${match[2]}.sql` }
      : { kind: "invalid", why: `'${path}' no es un rollback acoplado válido` };
  }
  const [folder, filename, extra] = path.split("/");
  if (
    extra === undefined &&
    filename !== undefined &&
    SCRIPT_CATEGORIES.includes(folder as (typeof SCRIPT_CATEGORIES)[number]) &&
    FORWARD_RE.test(filename)
  )
    return { kind: "forward" };
  return {
    kind: "invalid",
    why: `'${path}' no es un forward NN-<nombre>.sql en una carpeta de categoría`,
  };
}

function scriptNumberingFailures(forwards: ReadonlySet<string>): string[] {
  const failures: string[] = [];
  for (const category of SCRIPT_CATEGORIES) {
    const numbers = [...forwards]
      .filter((name) => name.startsWith(`${category}/`))
      .map((name) => Number.parseInt(name.slice(category.length + 1, category.length + 3), 10))
      .sort((a, b) => a - b);
    if (numbers.some((n, i) => n !== i + 1))
      failures.push(
        `numeración de forwards no continua desde 01 en ${category}: ${numbers.join(", ")}`,
      );
  }
  return failures;
}

function scriptCitationFailures(
  artifacts: readonly SemanticArtifact[],
  unit: string,
  names: ReadonlySet<string>,
): string[] {
  const failures: string[] = [];
  for (const artifact of artifacts) {
    const name = artifact.path.slice(unit.length + 1);
    if (name !== "README.md" && !/(^|\/)RUNBOOK\.md$/i.test(name)) continue;
    for (const citation of citedBundleFiles(artifact.content)) {
      if (!names.has(citation))
        failures.push(`${name} cita '${citation}' que no existe en el bundle`);
    }
  }
  return failures;
}

function citedBundleFiles(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`|\[[^\]]+\]\(([^)]+)\)/g)) {
    const raw = match[1] ?? match[2] ?? "";
    if (/(?:^|\/)\d{3,}-[^/]+\//.test(raw)) continue; // another bundle is not an internal citation
    for (const token of raw.split(/\s+/)) {
      const candidate = token
        .trim()
        .replace(/^['"`]+|['"`,;]+$/g, "")
        .replace(/^\.\//, "");
      if (/^(?:[\w-]+\/)*[\w.-]+\.(?:sql|md|json)$/i.test(candidate)) names.add(candidate);
    }
  }
  return [...names];
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface ExportApplyInput {
  raw: string;
  prepared: ExportPrepared;
  approval: string;
  /** Explicit authorization to replace the category's overwritable file. */
  allowOverwrite?: boolean;
}

export async function applyExport(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
  input: ExportApplyInput,
  catalog?: CatalogLookup,
): Promise<SemanticParse<ExportApplied>> {
  const validated = await validateExportWithCatalog(input.raw, input.prepared, catalog);
  if (!validated.ok) return validated;
  if (validated.value.approval_digest !== input.approval) {
    return {
      ok: false,
      failure: {
        code: "APPROVAL_MISMATCH",
        message: "el approval digest no corresponde a esta propuesta",
        action: "volvé a correr validate y aprobá el digest que devuelve",
      },
    };
  }
  const replacing =
    validated.value.preview.replacements ??
    (validated.value.preview.overwrites === null ? [] : [validated.value.preview.overwrites]);
  if (replacing.length > 0 && input.allowOverwrite !== true) {
    return {
      ok: false,
      failure: {
        code: "OVERWRITE_NOT_AUTHORIZED",
        message: `la propuesta reemplaza ${replacing.join(", ")}`,
        action: "confirmá con --overwrite si querés reemplazarlo, o quitalo de la propuesta",
      },
    };
  }

  const parsed = parseSemanticResponse(input.raw, input.prepared.request);
  if (!parsed.ok) return parsed;
  const assembled = assembleExportArtifacts(parsed.value, input.prepared);
  if (!assembled.ok) return assembled;

  const preview = validated.value.preview;
  const policy = resolvePolicy(input.prepared.category, input.prepared.dir);
  const result = await withCwdLock(fs, paths, async () => {
    const number = input.prepared.next;
    const folderMarker =
      input.prepared.category === "scripts"
        ? join(paths.workspaceDir(), input.prepared.unit, FOLDER_RESERVATION_MARKER)
        : null;
    const expected =
      input.prepared.reservationOwner === undefined
        ? null
        : reservationMarker(
            input.prepared.reservationOwner,
            input.prepared.reservationMaterialDigest,
          );
    if (
      folderMarker !== null &&
      (!(await fs.exists(folderMarker)) || (await fs.readText(folderMarker)) !== expected)
    ) {
      return {
        ok: false as const,
        failure: {
          code: "EXPORT_NUMBER_TAKEN",
          message: `la reserva ${number} ya no pertenece a esta operación`,
          action: "volvé a correr prepare",
        },
      };
    }
    async function checkNumberAvailability(): Promise<SemanticParse<never> | null> {
      const entries = (await fs.exists(join(paths.workspaceDir(), policy.dir)))
        ? await fs.list(join(paths.workspaceDir(), policy.dir))
        : [];
      const usedNumbers = await exportUsedNumbers(fs, paths, policy.dir);
      const occupant = entries.find((entry) => {
        const found = leadingCorrelative(entry.name);
        return found !== null && sameCorrelative(found, number);
      });
      if (
        preview.mode !== "complement" &&
        preview.mode !== "flat" &&
        ((occupant !== undefined &&
          (folderMarker === null || occupant.name !== basename(input.prepared.unit))) ||
          [...usedNumbers].some((n) => sameCorrelative(n, number)))
      ) {
        return {
          ok: false as const,
          failure: {
            code: "EXPORT_NUMBER_TAKEN",
            message: `el correlativo ${number} ya está ocupado por '${occupant?.name ?? "una publicación registrada"}'`,
            action: "volvé a correr prepare y validate con un número nuevo",
          },
        };
      }
      return null;
    }
    const numberFailure = await checkNumberAvailability();
    if (numberFailure !== null) return numberFailure;
    const artifacts = assembled.value.map((artifact) => ({
      ...artifact,
      overwrite: input.allowOverwrite === true && replacing.includes(artifact.path),
    }));
    // Whole dossier or nothing: `publishArtifacts` restores every previous
    // state on the first failure.
    const alreadyWritten =
      folderMarker !== null &&
      (
        await Promise.all(
          artifacts.map(async (artifact) => {
            const target = join(paths.workspaceDir(), artifact.path);
            try {
              return (await fs.readText(target)) === artifact.content;
            } catch {
              return false;
            }
          }),
        )
      ).every(Boolean);
    const published = alreadyWritten
      ? { ok: true as const, value: { written: artifacts.map((artifact) => artifact.path) } }
      : await publishArtifacts(fs, paths.workspaceDir(), artifacts, { overwrite: false });
    // Under the SAME lock as the write, for the same reason as in `persist`: two
    // concurrent publications outside it would lose one of the two rows.
    if (published.ok) {
      await recordExportPublication(
        fs,
        paths,
        input.prepared,
        policy,
        number,
        folderMarker,
        published.value.written,
      );
    }
    return published;
  });

  if ("error" in result) {
    return {
      ok: false,
      failure: {
        code: "LOCK_BUSY",
        message: result.error,
        action: "esperá a que termine la otra operación y volvé a aplicar",
      },
    };
  }
  if (!result.ok) return result;
  return { ok: true, value: { category: input.prepared.category, written: result.value.written } };
}

function reject(message: string): SemanticFailure {
  return {
    code: "EXPORT_SHAPE_INVALID",
    message,
    action: "corregí la propuesta según el 'contract' del request y reenviala",
  };
}

async function checkSelectedCatalog(
  selection: ExportSelection,
  catalog: CatalogLookup | undefined,
): Promise<SemanticParse<never> | null> {
  if (selection.catalog !== undefined) {
    if (catalog === undefined)
      return {
        ok: false,
        failure: {
          code: "EXPORT_CATALOG_UNAVAILABLE",
          message: `--catalog ${selection.catalog} no tiene catálogo de sólo lectura disponible`,
          action: "revisá la conexión y repetí prepare",
        },
      };
    const read = await catalog.lookupColumns(selection.catalog, ["public"]);
    if (!read.ok)
      return {
        ok: false,
        failure: {
          code: "EXPORT_CATALOG_UNAVAILABLE",
          message: `no se pudo consultar '${selection.catalog}' (${read.code}): ${read.message}`,
          action: "revisá la conexión de sólo lectura y repetí prepare",
        },
      };
  }
  return null;
}

function scopeFromRecord(scope: Record<string, unknown>): ExportScope {
  return {
    ...(scope.code !== undefined ? { code: scope.code as string } : {}),
    ...(scope.catalog !== undefined ? { catalog: scope.catalog as string } : {}),
    ...(scope.reservationOwner !== undefined
      ? { reservationOwner: scope.reservationOwner as string }
      : {}),
    ...(scope.reservationMaterialDigest !== undefined
      ? { reservationMaterialDigest: scope.reservationMaterialDigest as string }
      : {}),
    ...(scope.sessions !== undefined ? { sessions: scope.sessions as string[] } : {}),
    ...(scope.since !== undefined ? { since: scope.since as string } : {}),
    ...(scope.source !== undefined ? { source: scope.source as string } : {}),
    ...(scope.from !== undefined ? { from: scope.from as ExportBase } : {}),
    ...(scope.exclude !== undefined ? { exclude: scope.exclude as string[] } : {}),
    ...(scope.environment !== undefined ? { environment: scope.environment as string } : {}),
    date: scope.date as string,
    next: scope.next as string,
    ...(scope.seal !== undefined ? { seal: scope.seal as Record<string, string> } : {}),
  };
}

function scopeSealError(scope: Record<string, unknown>): string | null {
  if (scope.seal !== undefined) {
    if (typeof scope.seal !== "object" || scope.seal === null || Array.isArray(scope.seal))
      return "'seal' debe contener los sellos por clave";
    const seals = scope.seal as Record<string, unknown>;
    for (const key of new Set([
      ...Object.keys(scope).filter((k) => k !== "seal"),
      ...Object.keys(seals),
    ])) {
      if (
        !(key in scope) ||
        typeof seals[key] !== "string" ||
        seals[key] !== baseDigest(JSON.stringify(scope[key]))
      )
        return `'${key}' no coincide con scope.seal`;
    }
  }
  return null;
}

function validateEchoedScope(raw: string, prepared: ExportPrepared): SemanticParse<never> | null {
  const echoed = readExportScope(raw);
  if (!echoed.ok) return echoed;
  if (echoed.value === null && prepared.scope.seal !== undefined) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_SCOPE_MISMATCH",
        message: "falta 'scope' en el sobre",
        action: "copiá el scope completo del request",
      },
    };
  }
  if (echoed.value !== null) {
    const keys = new Set([...Object.keys(prepared.scope), ...Object.keys(echoed.value)]);
    for (const key of keys) {
      if (
        JSON.stringify(prepared.scope[key as keyof ExportScope]) !==
        JSON.stringify(echoed.value[key as keyof ExportScope])
      ) {
        return {
          ok: false,
          failure: {
            code: "EXPORT_SCOPE_MISMATCH",
            message: `el alcance cambió en '${key}'`,
            action: "copiá scope y scope.seal del request original sin modificar ninguna clave",
          },
        };
      }
    }
  }
  return null;
}

function readBundleDecisions(
  response: { decisions?: Record<string, unknown> },
  prepared: ExportPrepared,
): SemanticParse<Record<"supersedes" | "requires", string[]>> {
  const decisions = response.decisions ?? {};
  const bundles = new Set(prepared.availableBundles ?? []);
  const lists: Record<"supersedes" | "requires", string[]> = { supersedes: [], requires: [] };
  for (const key of ["supersedes", "requires"] as const) {
    const value = decisions[key];
    if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
      return {
        ok: false,
        failure: reject(`decisions.${key} debe ser una lista de nombres de bundles`),
      };
    }
    const names = value as string[];
    if (names.includes(basename(prepared.unit)))
      return { ok: false, failure: reject(`${key} incluye el bundle que se está publicando`) };
    const missing = names.filter((name) => !bundles.has(name));
    if (missing.length > 0)
      return {
        ok: false,
        failure: reject(`${key}: bundle(s) inexistente(s): ${missing.join(", ")}`),
      };
    if (new Set(names).size !== names.length)
      return { ok: false, failure: reject(`${key} repite un bundle`) };
    lists[key] = [...names].sort();
  }
  return { ok: true, value: lists };
}

function checkArtifactShape(
  artifact: SemanticArtifact,
  policy: ResolvedPolicy,
  unit: string,
): SemanticFailure | null {
  const name = artifact.path.slice(unit.length + 1);
  const indivisible =
    policy.shape === "document" ||
    ["README.md", "RUNBOOK.md", "00-ROLLBACK.sql", "rollback/00-global/00-ROLLBACK.sql"].includes(
      name,
    );
  const bytes = Buffer.byteLength(artifact.content, "utf8");
  if (!indivisible && bytes > FORWARD_MAX_BYTES) {
    return {
      code: "EXPORT_LIMIT_EXCEEDED",
      message: `'${artifact.path}' pesa ${bytes} B y el máximo por pieza divisible es ${FORWARD_MAX_BYTES} B`,
      action: "partí el forward en archivos NN-<nombre>.sql consecutivos y repetí validate",
    };
  }
  if (!policy.extensions.some((ext) => artifact.path.endsWith(ext))) {
    return reject(
      `'${artifact.path}' no usa una extensión permitida (${policy.extensions.join(", ")})`,
    );
  }
  if (artifact.content.trim().length === 0) {
    return reject(`'${artifact.path}' está vacío`);
  }
  return null;
}

async function exportUsedNumbers(
  fs: FileSystemPort,
  paths: PathsService,
  dir: string,
): Promise<Set<string>> {
  const usedNumbers = await publishedCorrelatives(fs, paths.cwdHistoryFile(), dir);
  for (const pass of (await readReleasePasses(fs, paths)).events) {
    if (pass.event !== "linked" || !pass.artifact.startsWith(`${dir}/`)) continue;
    const recorded = leadingCorrelative(pass.artifact.slice(dir.length + 1).split("/")[0] ?? "");
    if (recorded !== null) usedNumbers.add(recorded);
  }
  return usedNumbers;
}

function buildExportScope(
  selection: ExportSelection,
  owner: string | null,
  materialDigest: string,
  date: string,
  next: string,
): ExportScope {
  return {
    ...(selection.code !== undefined ? { code: selection.code } : {}),
    ...(selection.catalog !== undefined ? { catalog: selection.catalog } : {}),
    ...(owner === null
      ? {}
      : { reservationOwner: owner, reservationMaterialDigest: materialDigest }),
    ...(selection.sessions !== undefined ? { sessions: selection.sessions } : {}),
    ...(selection.since !== undefined ? { since: selection.since } : {}),
    ...(selection.source !== undefined ? { source: selection.source } : {}),
    ...(selection.from !== undefined ? { from: selection.from } : {}),
    ...(selection.exclude !== undefined ? { exclude: selection.exclude } : {}),
    ...(selection.environment !== undefined ? { environment: selection.environment } : {}),
    date,
    next,
  };
}

async function listExistingManuals(
  fs: FileSystemPort,
  paths: PathsService,
  category: ExportCategory,
  dir: string,
): Promise<string[]> {
  return category === "manuals" && (await fs.exists(join(paths.workspaceDir(), dir)))
    ? (await fs.list(join(paths.workspaceDir(), dir)))
        .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
        .map((entry) => `${dir}/${entry.name}`)
    : [];
}

function scopeTextFieldError(scope: Record<string, unknown>): string | null {
  for (const key of [
    "since",
    "source",
    "environment",
    "code",
    "catalog",
    "reservationOwner",
    "reservationMaterialDigest",
  ] as const) {
    if (scope[key] !== undefined && typeof scope[key] !== "string") {
      return `'${key}' tiene que ser texto`;
    }
  }
  return null;
}

function invalidReportPath(
  policy: ResolvedPolicy,
  inUnit: SemanticArtifact[],
  next: string,
): boolean {
  return (
    policy.shape === "document" &&
    !(
      inUnit[0]?.path.startsWith(`${policy.dir}/${next}-`) &&
      /^[^/]+\.md$/.test(inUnit[0].path.slice(`${policy.dir}/${next}-`.length))
    )
  );
}

async function recordExportPublication(
  fs: FileSystemPort,
  paths: PathsService,
  prepared: ExportPrepared,
  policy: ResolvedPolicy,
  number: string,
  folderMarker: string | null,
  written: string[],
): Promise<void> {
  if (folderMarker !== null && prepared.reservationOwner !== undefined) {
    await appendClaimEvent(fs, paths, {
      at: new Date().toISOString(),
      event: "published",
      claim: {
        category: basename(policy.dir),
        correlative: number,
        name: basename(prepared.unit).slice(number.length + 1),
        owner: prepared.reservationOwner,
      },
      cause: "aw export-scripts apply: dossier aprobado publicado",
    });
    await fs.remove(folderMarker);
  }
  await appendPublications(
    fs,
    paths.cwdHistoryFile(),
    publicationRows(written, `export-${prepared.category}`),
  );
}
