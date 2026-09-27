import { basename, relative, sep } from "node:path";
import { CORRELATIVE_SOURCE, isCorrelative } from "../domain/correlative.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { runNextNumber } from "./dev-only-services.js";
import { resolveDocsCanon } from "./docs-canon-service.js";
import { appendPublications, publicationRows } from "./history-publications.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { type ReleaseDataInput, runReleaseData } from "./release-data-service.js";
import type { GraduatedBundle, StandaloneSql } from "./release-data/bundles.js";
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
} from "./semantic-operation/protocol.js";
import { publishArtifacts } from "./semantic-operation/publish.js";

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
  "Un dossier con 00-ROLLBACK.sql y README.md obligatorios, más los forwards NN-<nombre>.sql numerados de forma continua desde 01. El CLI NUNCA ejecuta SQL. El bundle publica el ESTADO FINAL NETO de la secuencia, no una réplica por sesión: lo que nace y muere dentro de la secuencia se omite; lo migrado va directo a su forma final; lo que el contexto declara retirado se omite aunque ningún script lo elimine. 00-ROLLBACK.sql invierte ese ESTADO FINAL en orden seguro para las dependencias, no el reverso literal de los forwards. Reconciliá contra el código además de las sesiones y la base. Excluí identidades concretas y semillas de prueba; conservá sólo objetos compartidos y necesarios para el estado final. Un bundle previo que entra al origen es MATERIAL A RECONCILIAR, no historia intocable: dos bundles que se contradicen publican el estado final neto resultante, nunca su suma cronológica.";

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
    extensions: [".md", ".dsl", ".puml", ".mmd"],
    contract:
      "Un dossier con README.md obligatorio, los diagramas en Markdown y, opcionalmente, su DSL (.dsl/.puml/.mmd).",
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
    required: ["00-ROLLBACK.sql", "README.md"],
    extensions: [".sql", ".md"],
    contract: SCRIPTS_FINAL_STATE_CONTRACT,
  },
};

const FORWARD_MAX_BYTES = 512 * 1024;
const LIMITS = { max_artifacts: 64, max_artifact_bytes: 4 * 1024 * 1024 };
const FORWARD_RE = /^(\d{2})-[^/]+\.sql$/;

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
  /** Consultative number that named the unit; `apply` mints the real one. */
  next: string;
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
  /** Consultative — `apply` mints the real one inside the lock. */
  next: string;
  unit: string;
}

export interface ExportPreview {
  category: ExportCategory;
  destination: string;
  files: Array<{ path: string; bytes: number }>;
  /** Present when the proposal replaces the category's overwritable file. */
  overwrites: string | null;
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
  const resolved = await resolveMaterial(fs, env, paths, category, selection);
  if (!resolved.ok) return resolved;
  const material = resolved.value;

  // Pinned when the answer echoed them, derived only on a first preparation:
  // re-deriving either at `validate` renames the very unit the answer wrote to,
  // and neither is workspace state that a stale check should be defending.
  const next =
    selection.next ??
    (await runNextNumber(fs, env, paths, { directory: policy.dir, dryRun: true })).next;
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
  const unit =
    policy.shape === "dossier" ? `${policy.dir}/${next}-export-${category}-${date}` : policy.dir;
  const scope: ExportScope = {
    ...(selection.sessions !== undefined ? { sessions: selection.sessions } : {}),
    ...(selection.since !== undefined ? { since: selection.since } : {}),
    ...(selection.source !== undefined ? { source: selection.source } : {}),
    ...(selection.from !== undefined ? { from: selection.from } : {}),
    ...(selection.exclude !== undefined ? { exclude: selection.exclude } : {}),
    ...(selection.environment !== undefined ? { environment: selection.environment } : {}),
    date,
    next,
  };

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
    date,
  };

  const readSet = materialPaths(material);
  const request = buildSemanticRequest({
    operation: `export-${category}`,
    // What the seal defends is workspace state: the MATERIAL the scope covers —
    // sessions, loose SQL and previously published bundles alike, since any of
    // them appearing or changing changes what the dossier should have contained
    // — and the folder this workspace publishes to. The scope rides along so an
    // altered echo cannot pass as the original one.
    inputs: {
      corpus: material.sessions,
      bundles: material.bundles,
      standalone: material.standalone,
      dir: policy.dir,
      scope,
    },
    sealed: "el material del alcance o el destino declarado de la categoría",
    scope,
    contract: `${policy.contract} Cada pieza divisible (incluidos forwards) admite ${FORWARD_MAX_BYTES} B y se divide en más archivos; un informe, README.md, RUNBOOK.md o 00-ROLLBACK.sql admite hasta ${LIMITS.max_artifact_bytes} B. Respondé artifacts con paths dentro de ${unit}${policy.overwritable === null ? "" : ` (o exactamente ${policy.overwritable})`}. El NNN es consultivo: el CLI reasigna el número dentro del lock. Copiá 'scope' TAL CUAL en tu respuesta: validate y apply lo leen en vez de re-derivarlo.`,
    inventory,
    allowedDestinations: [unit, ...(policy.overwritable === null ? [] : [policy.overwritable])],
    limits: LIMITS,
    readSet,
    readSetBytes: readSet.length,
  });

  return { ok: true, value: { category, request, dir: policy.dir, scope, next, unit } };
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
  const named = (["from", "exclude", "environment"] as const).filter(
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
    value: {
      ...(scope.sessions !== undefined ? { sessions: scope.sessions as string[] } : {}),
      ...(scope.since !== undefined ? { since: scope.since as string } : {}),
      ...(scope.source !== undefined ? { source: scope.source as string } : {}),
      ...(scope.from !== undefined ? { from: scope.from as ExportBase } : {}),
      ...(scope.exclude !== undefined ? { exclude: scope.exclude as string[] } : {}),
      ...(scope.environment !== undefined ? { environment: scope.environment as string } : {}),
      date: scope.date as string,
      next: scope.next as string,
    },
  };
}

/** Why this echo is not the scope `prepare` emitted, or `null` when it is. */
function scopeShapeError(scope: Record<string, unknown>): string | null {
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
  for (const key of ["since", "source", "environment"] as const) {
    if (scope[key] !== undefined && typeof scope[key] !== "string") {
      return `'${key}' tiene que ser texto`;
    }
  }
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function malformedScope(why: string): SemanticParse<ExportScope | null> {
  return {
    ok: false,
    failure: {
      code: "SEMANTIC_RESPONSE_INVALID",
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
  const parsed = parseSemanticResponse(raw, prepared.request);
  if (!parsed.ok) return parsed;

  // From what was prepared, never from the policy table: the folder is the
  // workspace's, and re-reading it here would let the two stages disagree.
  const policy = resolvePolicy(prepared.category, prepared.dir);
  const artifacts = parsed.value.artifacts ?? [];
  const inUnit = artifacts.filter((a) => a.path !== policy.overwritable);
  const overwrites = artifacts.some((a) => a.path === policy.overwritable)
    ? policy.overwritable
    : null;

  const shape = checkShape(inUnit, policy, prepared.unit);
  if (shape !== null) return { ok: false, failure: shape };

  return {
    ok: true,
    value: {
      preview: {
        category: prepared.category,
        destination: prepared.unit,
        files: artifacts.map((a) => ({
          path: a.path,
          bytes: Buffer.byteLength(a.content, "utf8"),
        })),
        overwrites,
      },
      approval_digest: approvalDigest(parsed.value),
    },
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
    const name = artifact.path.slice(unit.length + 1);
    const indivisible =
      policy.shape === "document" || ["README.md", "RUNBOOK.md", "00-ROLLBACK.sql"].includes(name);
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
  }
  for (const required of policy.required) {
    if (!names.includes(required)) return reject(`falta '${required}' en el dossier`);
  }
  return policy.required.includes("00-ROLLBACK.sql") ? checkForwards(names) : null;
}

/** Forwards numbered continuously from 01 — a gap makes the apply order unreadable. */
function checkForwards(names: string[]): SemanticFailure | null {
  const forwards = names
    .map((name) => FORWARD_RE.exec(name)?.[1])
    .filter((n): n is string => n !== undefined && n !== "00")
    .map((n) => Number.parseInt(n, 10))
    .sort((a, b) => a - b);
  if (forwards.length === 0) return reject("el bundle no trae ningún forward NN-<nombre>.sql");
  for (let i = 0; i < forwards.length; i++) {
    if (forwards[i] !== i + 1) {
      return reject(`la numeración de forwards no es continua desde 01: ${forwards.join(", ")}`);
    }
  }
  return null;
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
  env: EnvPort,
  paths: PathsService,
  input: ExportApplyInput,
): Promise<SemanticParse<ExportApplied>> {
  const validated = validateExport(input.raw, input.prepared);
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
  if (validated.value.preview.overwrites !== null && input.allowOverwrite !== true) {
    return {
      ok: false,
      failure: {
        code: "OVERWRITE_NOT_AUTHORIZED",
        message: `la propuesta reemplaza '${validated.value.preview.overwrites}'`,
        action: "confirmá con --overwrite si querés reemplazarlo, o quitalo de la propuesta",
      },
    };
  }

  const parsed = parseSemanticResponse(input.raw, input.prepared.request);
  if (!parsed.ok) return parsed;

  const policy = resolvePolicy(input.prepared.category, input.prepared.dir);
  const result = await withCwdLock(fs, paths, async () => {
    const minted = (await runNextNumber(fs, env, paths, { directory: policy.dir })).next;
    const artifacts = (parsed.value.artifacts ?? []).map((artifact) =>
      renumber(artifact, input.prepared, minted, policy),
    );
    // Whole dossier or nothing: `publishArtifacts` restores every previous
    // state on the first failure.
    const published = await publishArtifacts(fs, paths.workspaceDir(), artifacts, {
      overwrite: input.allowOverwrite === true,
    });
    // Under the SAME lock as the write, for the same reason as in `persist`: two
    // concurrent publications outside it would lose one of the two rows.
    if (published.ok) {
      await appendPublications(
        fs,
        paths.cwdHistoryFile(),
        publicationRows(published.value.written, `export-${input.prepared.category}`),
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

/**
 * The number in the answer was consultative. The real one is minted inside the
 * lock, so the destination is rebuilt here — never trusted from the proposal.
 */
function renumber(
  artifact: SemanticArtifact,
  prepared: ExportPrepared,
  minted: string,
  policy: ResolvedPolicy,
): SemanticArtifact {
  if (artifact.path === policy.overwritable) return artifact;
  if (policy.shape === "document") {
    const name = artifact.path
      .slice(policy.dir.length + 1)
      .replace(new RegExp(`^${CORRELATIVE_SOURCE}-`), "");
    return { path: `${policy.dir}/${minted}-${name}`, content: artifact.content };
  }
  // The number to move is the UNIT's own, which is its LAST segment — never the
  // first `/NNN-` of the path. Since the category's folder became configurable,
  // a canon that is itself numbered (`docs/003-manuales`) would eat the
  // replacement: the export would be approved into `docs/003-manuales/…` and
  // written into `docs/001-manuales/…`, a folder outside `allowed_destinations`
  // that nothing downstream re-checks.
  const unitName = prepared.unit
    .slice(policy.dir.length + 1)
    .replace(new RegExp(`^${CORRELATIVE_SOURCE}-`), `${minted}-`);
  const unit = `${policy.dir}/${unitName}`;
  return {
    path: `${unit}/${artifact.path.slice(prepared.unit.length + 1)}`,
    content: artifact.content,
  };
}

function reject(message: string): SemanticFailure {
  return {
    code: "EXPORT_SHAPE_INVALID",
    message,
    action: "corregí la propuesta según el 'contract' del request y reenviala",
  };
}
