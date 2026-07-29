import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { runNextNumber } from "./dev-only-services.js";
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

interface CategoryPolicy {
  /** The single `docs/` folder this export may write. */
  dir: string;
  /** `dossier` = a numbered directory of files; `document` = one numbered file. */
  shape: "dossier" | "document";
  /** Files that MUST be present in a dossier. */
  required: string[];
  /** Allowed extensions inside the destination. */
  extensions: string[];
  /** A fixed path outside the numbered unit this export may replace, if any. */
  overwritable?: string;
  contract: string;
}

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
    overwritable: "docs/manuals/INDEX.md",
    contract:
      "Un dossier con README.md obligatorio y los manuales en Markdown. Podés incluir docs/manuals/INDEX.md para actualizar el índice: es el ÚNICO archivo sobrescribible y exige aprobación explícita.",
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
    contract:
      "Un dossier con 00-ROLLBACK.sql y README.md obligatorios, más los forwards NN-<nombre>.sql numerados de forma continua desde 01. El CLI NUNCA ejecuta SQL.",
  },
};

const LIMITS = { max_artifacts: 64, max_artifact_bytes: 512 * 1024 };
const FORWARD_RE = /^(\d{2})-[^/]+\.sql$/;

export interface ExportSelection {
  sessions?: string[];
  since?: string;
  source?: string;
  /** Deterministic date for the unit's name; defaults to today. */
  date?: string;
}

export interface ExportPrepared {
  category: ExportCategory;
  request: SemanticRequest;
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
): Promise<SemanticParse<ExportPrepared>> {
  const policy = POLICIES[category];
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

  const next = (await runNextNumber(fs, env, { directory: policy.dir, dryRun: true })).next;
  const date = selection.date ?? localDateIso(new Date());
  const unit =
    policy.shape === "dossier" ? `${policy.dir}/${next}-export-${category}-${date}` : policy.dir;

  const inventory = {
    category,
    destination: unit,
    shape: policy.shape,
    required: policy.required,
    extensions: policy.extensions,
    overwritable: policy.overwritable ?? null,
    sessions: corpus.sessions,
    date,
  };

  const readSet = corpus.sessions.map((s) => s.path ?? s.folder);
  const request = buildSemanticRequest({
    operation: `export-${category}`,
    // The corpus seals the request: a session appearing or closing between
    // prepare and apply changes what the dossier should have contained.
    inputs: { corpus: corpus.sessions, next, date },
    contract: `${policy.contract} Respondé artifacts con paths dentro de ${unit}${policy.overwritable ? ` (o exactamente ${policy.overwritable})` : ""}. El NNN es consultivo: el CLI reasigna el número dentro del lock.`,
    inventory,
    allowedDestinations: [unit, ...(policy.overwritable ? [policy.overwritable] : [])],
    limits: LIMITS,
    readSet,
    readSetBytes: readSet.length,
  });

  return { ok: true, value: { category, request, next, unit } };
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

// ── validate ─────────────────────────────────────────────────────────────────

export function validateExport(
  raw: string,
  prepared: ExportPrepared,
): SemanticParse<ExportValidation> {
  const parsed = parseSemanticResponse(raw, prepared.request);
  if (!parsed.ok) return parsed;

  const policy = POLICIES[prepared.category];
  const artifacts = parsed.value.artifacts ?? [];
  const inUnit = artifacts.filter((a) => a.path !== policy.overwritable);
  const overwrites = artifacts.some((a) => a.path === policy.overwritable)
    ? (policy.overwritable ?? null)
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
  policy: CategoryPolicy,
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

  const policy = POLICIES[input.prepared.category];
  const result = await withCwdLock(fs, paths, async () => {
    const minted = (await runNextNumber(fs, env, { directory: policy.dir })).next;
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
  policy: CategoryPolicy,
): SemanticArtifact {
  if (artifact.path === policy.overwritable) return artifact;
  if (policy.shape === "document") {
    const name = artifact.path.slice(policy.dir.length + 1).replace(/^\d{3}-/, "");
    return { path: `${policy.dir}/${minted}-${name}`, content: artifact.content };
  }
  const unit = prepared.unit.replace(/\/\d{3}-/, `/${minted}-`);
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
