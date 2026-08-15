import { CORRELATIVE_SOURCE, isCorrelative } from "../domain/correlative.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { runNextNumber } from "./dev-only-services.js";
import { resolveDocsCanon } from "./docs-canon-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { type ReleaseDataInput, runReleaseData } from "./release-data-service.js";
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
  "Un dossier con 00-ROLLBACK.sql y README.md obligatorios, más los forwards NN-<nombre>.sql numerados de forma continua desde 01. El CLI NUNCA ejecuta SQL. El bundle publica el ESTADO FINAL NETO de la secuencia, no una réplica por sesión: lo que nace y muere dentro de la secuencia se omite; lo migrado va directo a su forma final; lo que el contexto declara retirado se omite aunque ningún script lo elimine. 00-ROLLBACK.sql invierte ese ESTADO FINAL en orden seguro para las dependencias, no el reverso literal de los forwards. Reconciliá contra el código además de las sesiones y la base. Excluí identidades concretas y semillas de prueba; conservá sólo objetos compartidos y necesarios para el estado final.";

export const SCRIPTS_FINAL_STATE_CONTRACT_ANCHORS = [
  "ESTADO FINAL NETO",
  "orden seguro para las dependencias",
  "objetos compartidos y necesarios para el estado final",
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

const LIMITS = { max_artifacts: 64, max_artifact_bytes: 512 * 1024 };
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
  /** The day that names the unit. */
  date: string;
  /** Consultative number that named the unit; `apply` mints the real one. */
  next: string;
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
  const corpus = await readCorpus(fs, env, paths, selection);
  if ("error" in corpus) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_CORPUS_UNAVAILABLE",
        message: corpus.error,
        action: "revisá el workspace y los filtros --sessions/--since/--source",
      },
    };
  }
  if (corpus.sessions.length === 0) {
    return {
      ok: false,
      failure: {
        code: "EXPORT_CORPUS_EMPTY",
        message: "ninguna sesión coincide con los filtros",
        action: "ampliá --since, quitá --sessions, o revisá que existan sesiones cerradas",
      },
    };
  }

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
    sessions: corpus.sessions,
    date,
  };

  const readSet = corpus.sessions.map((s) => s.path ?? s.folder);
  const request = buildSemanticRequest({
    operation: `export-${category}`,
    // What the seal defends is workspace state: the corpus the scope covers (a
    // session appearing or closing changes what the dossier should have
    // contained) and the folder this workspace publishes to. The scope rides
    // along so an altered echo cannot pass as the original one.
    inputs: { corpus: corpus.sessions, dir: policy.dir, scope },
    sealed: "el corpus de sesiones del alcance o el destino declarado de la categoría",
    scope,
    contract: `${policy.contract} Respondé artifacts con paths dentro de ${unit}${policy.overwritable === null ? "" : ` (o exactamente ${policy.overwritable})`}. El NNN es consultivo: el CLI reasigna el número dentro del lock. Copiá 'scope' TAL CUAL en tu respuesta: validate y apply lo leen en vez de re-derivarlo.`,
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

async function readCorpus(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  selection: ExportSelection,
): Promise<{ sessions: Array<{ folder: string; path?: string }> } | { error: string }> {
  const input: ReleaseDataInput = {
    includeClosed: true,
    // Graduated bundles are previous exports: re-exporting them would duplicate
    // what already lives in docs/.
    includeGraduated: false,
    ...(selection.sessions !== undefined ? { sessions: selection.sessions } : {}),
    ...(selection.since !== undefined ? { since: selection.since } : {}),
    ...(selection.source !== undefined ? { sourceAlias: selection.source } : {}),
  };
  const data = await runReleaseData(fs, env, paths, input);
  if ("error" in data) return { error: data.error };
  return { sessions: data.sessions as Array<{ folder: string; path?: string }> };
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
  for (const key of ["since", "source"] as const) {
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
  for (const [flag, key] of [
    ["--since", "since"],
    ["--source", "source"],
    ["--date", "date"],
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
    return await publishArtifacts(fs, paths.workspaceDir(), artifacts, {
      overwrite: input.allowOverwrite === true,
    });
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
