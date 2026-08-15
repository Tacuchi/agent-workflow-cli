/**
 * The document a design revision repoints as part of the SAME publication.
 *
 * A package and the spec or plan that consumes its next baseline have to move
 * together when the caller asks for that relationship.  Keeping the parsing,
 * compare-and-swap base, exact-reference check and manifest backreference here
 * gives both the simple and package routes one interface instead of making
 * either route remember half of an atomic publication.
 */

import { join } from "node:path";
import type { CapabilityInputValue } from "../../domain/capability/protocol.js";
import type { DesignBaseline } from "../../domain/design/baseline.js";
import type { DesignManifest, DesignRelations } from "../../domain/design/manifest.js";
import { parseSpecDesignReferences } from "../../domain/design/reference.js";
import type { DesignFailure } from "../../domain/design/validation.js";
import {
  type CoreDocsCanon,
  type CoreDocumentKind,
  DEFAULT_CORE_DOCS_CANON,
  coreDocumentKindForPath,
  coreDocumentLocations,
} from "../../domain/docs-canon.js";
import type { ProposalBase } from "../../domain/proposal.js";
import { baseDigest } from "../../domain/proposal.js";
import { checkSafeRelativePath } from "../../domain/safe-path.js";
import type { FileSystemPort } from "../../ports/file-system.js";

export type ConsumerDocumentKind = CoreDocumentKind;

/**
 * Final consumer bytes plus the exact document they replace.
 *
 * `base` is deliberately a ProposalBase rather than a separate digest field:
 * callers that publish this object cannot forget to include the consumer in
 * the proposal-wide compare-and-swap set.
 */
export interface ConsumerDocument {
  kind: ConsumerDocumentKind;
  path: string;
  content: string;
  base: ProposalBase;
}

export type ConsumerDocumentRead =
  | { ok: true; value: ConsumerDocument | null }
  | { ok: false; failure: DesignFailure };

/**
 * Read the optional attachment from the capability request without trusting
 * its caller-provided provenance. The filesystem comparison happens later,
 * against the candidate's workspace, but path/kind/seal shape is fixed here.
 */
export function readConsumerDocument(
  input: CapabilityInputValue | undefined,
  canon: Pick<CoreDocsCanon, "spec" | "plan"> = DEFAULT_CORE_DOCS_CANON,
): ConsumerDocumentRead {
  if (input === undefined) return { ok: true, value: null };
  const artifact = input.provenance.origin || "consumer_document";

  if (input.provenance.kind !== "attachment") {
    return failure(
      "DESIGN_CONSUMER_INVALID",
      artifact,
      "'consumer_document' debe llegar como attachment",
      "pasá los bytes finales con provenance.kind = 'attachment'",
    );
  }
  if (typeof input.value !== "string") {
    return failure(
      "DESIGN_CONSUMER_INVALID",
      artifact,
      "'consumer_document' debe contener los bytes de un documento Markdown",
      "pasá el contenido final de la spec o el plan como texto",
    );
  }

  const safe = checkSafeRelativePath(input.provenance.origin);
  if (!safe.ok) {
    return failure(
      "DESIGN_PATH_UNSAFE",
      artifact,
      `consumer_document: '${input.provenance.origin}' ${safe.why}`,
      "usá el path relativo de una spec o un plan dentro del workspace",
    );
  }
  const kind = coreDocumentKindForPath(safe.path, canon);
  if (kind === null) {
    return failure(
      "DESIGN_CONSUMER_PATH_INVALID",
      safe.path,
      `'consumer_document' sólo puede reemplazar una spec bajo ${canon.spec}/ o un plan bajo ${canon.plan}/`,
      `usá un archivo .md existente bajo ${coreDocumentLocations(canon)}/`,
    );
  }

  const digest = input.provenance.seal;
  if (!isBaseDigest(digest)) {
    return failure(
      "DESIGN_CONSUMER_BASE_INVALID",
      safe.path,
      "'consumer_document' necesita en provenance.seal el digest de la versión que reemplaza",
      "releé el documento consumidor y pasá su digest base sha256 en hex",
    );
  }

  return {
    ok: true,
    value: { kind, path: safe.path, content: input.value, base: { path: safe.path, digest } },
  };
}

/**
 * Re-read the consumer before the candidate is accepted. A later re-read in
 * `applyLocalProposal` is still necessary; this earlier check makes a stale
 * attachment a candidate error rather than a surprising apply-time conflict.
 */
export async function checkConsumerBase(
  fs: FileSystemPort,
  workspace: string,
  consumer: ConsumerDocument,
): Promise<DesignFailure | null> {
  const absolute = join(workspace, consumer.path);
  if (!(await fs.exists(absolute))) {
    return {
      code: "DESIGN_CONSUMER_BASE_GONE",
      artifact: consumer.path,
      message: `el documento consumidor '${consumer.path}' ya no existe`,
      action: "releelo o publicalo primero antes de preparar esta revisión de diseño",
    };
  }
  let current: string;
  try {
    current = await fs.readText(absolute);
  } catch {
    return {
      code: "DESIGN_CONSUMER_BASE_UNREADABLE",
      artifact: consumer.path,
      message: `no se pudo leer el documento consumidor '${consumer.path}'`,
      action: "revisá el acceso al documento antes de preparar la publicación atómica",
    };
  }
  if (baseDigest(current) !== consumer.base.digest) {
    return {
      code: "DESIGN_CONSUMER_BASE_STALE",
      artifact: consumer.path,
      message: `'${consumer.path}' cambió después de obtener el attachment`,
      action: "releé el documento, actualizá sus bytes y prepará de nuevo la revisión",
    };
  }
  return null;
}

/**
 * Re-check the object at the candidate seam too. The handler is the normal
 * caller, but `build*Proposal` is public and must not trust a typed object that
 * arrived through a different adapter.
 */
export function checkConsumerShape(
  consumer: ConsumerDocument,
  canon: Pick<CoreDocsCanon, "spec" | "plan"> = DEFAULT_CORE_DOCS_CANON,
): DesignFailure | null {
  if (typeof consumer.path !== "string" || typeof consumer.content !== "string") {
    return {
      code: "DESIGN_CONSUMER_INVALID",
      artifact: "consumer_document",
      message: "el documento consumidor debe declarar path y bytes de texto",
      action: "reconstruí el attachment desde la spec o el plan final",
    };
  }
  const safe = checkSafeRelativePath(consumer.path);
  if (!safe.ok) {
    return {
      code: "DESIGN_PATH_UNSAFE",
      artifact: consumer.path,
      message: `consumer_document: '${consumer.path}' ${safe.why}`,
      action: `usá una ruta relativa segura bajo ${coreDocumentLocations(canon)}/`,
    };
  }
  const kind = coreDocumentKindForPath(safe.path, canon);
  if (
    kind === null ||
    consumer.kind !== kind ||
    typeof consumer.base !== "object" ||
    consumer.base === null ||
    typeof consumer.base.path !== "string" ||
    consumer.base.path !== safe.path
  ) {
    return {
      code: "DESIGN_CONSUMER_PATH_INVALID",
      artifact: safe.path,
      message: "el consumidor y su base deben señalar la misma spec o plan dentro del workspace",
      action: `usá el mismo path seguro bajo ${coreDocumentLocations(canon)}/ para el attachment y su base`,
    };
  }
  if (!isBaseDigest(consumer.base.digest)) {
    return {
      code: "DESIGN_CONSUMER_BASE_INVALID",
      artifact: safe.path,
      message: "la base del consumidor no tiene un digest sha256 hexadecimal válido",
      action: "releé el documento consumidor y usá su digest base",
    };
  }
  return null;
}

/**
 * The consumer must pin THIS candidate, never an approximate or older revision.
 * Other packages may legitimately appear in the same document, but every
 * reference to the package being published has to agree with this baseline.
 */
export function checkConsumerReference(
  consumer: ConsumerDocument,
  baseline: Pick<DesignBaseline, "package" | "revision" | "digest">,
): DesignFailure | null {
  const parsed = parseSpecDesignReferences(consumer.content, consumer.path);
  const malformed = parsed.failures[0];
  if (malformed !== undefined) return malformed;

  const references = parsed.references.filter(
    (reference) => reference.baseline.package === baseline.package,
  );
  if (references.length === 0) {
    return {
      code: "DESIGN_CONSUMER_REFERENCE_MISSING",
      artifact: consumer.path,
      message: `'${consumer.path}' no fija el baseline ${baseline.package}@r${baseline.revision} que esta publicación acuña`,
      action: "agregá la referencia exacta bajo '## Design references' antes de publicar",
    };
  }
  const stale = references.find(
    (reference) =>
      reference.baseline.revision !== baseline.revision || reference.digest !== baseline.digest,
  );
  if (stale !== undefined) {
    return {
      code: "DESIGN_CONSUMER_REFERENCE_STALE",
      artifact: consumer.path,
      message: `'${consumer.path}' fija ${baseline.package}@r${stale.baseline.revision} con un digest que no corresponde al candidato`,
      action: `actualizá la referencia a ${baseline.package}@r${baseline.revision} y ${baseline.digest}`,
    };
  }
  return null;
}

/** Add the deterministic package → consumer backreference to a candidate manifest. */
export function withConsumerRelation(
  manifest: DesignManifest,
  consumer: ConsumerDocument | null | undefined,
): DesignManifest {
  if (consumer === null || consumer === undefined) return manifest;
  const key = consumer.kind === "spec" ? "specs" : "plans";
  const relations: DesignRelations = {
    ...manifest.relations,
    [key]: [...new Set([...manifest.relations[key], consumer.path])].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
  return { ...manifest, relations };
}

/** `ProposalBase` is sealed by `baseDigest`, which deliberately has no prefix. */
function isBaseDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function failure(
  code: string,
  artifact: string,
  message: string,
  action: string,
): ConsumerDocumentRead {
  return { ok: false, failure: { code, artifact, message, action } };
}
