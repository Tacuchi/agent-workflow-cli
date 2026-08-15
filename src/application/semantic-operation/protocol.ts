import { createHash } from "node:crypto";
import { checkSafeRelativePath } from "../../domain/safe-path.js";

/**
 * The bounded CLI↔AI handshake shared by every hybrid command.
 *
 * The split is the whole point: the CLI owns inventory, numbering, validation,
 * authorization and writing; the AI owns exactly one semantic step —
 * classification, synthesis or intent — and its answer is data to be validated,
 * never an instruction to be trusted.
 *
 * Three stages, and only the third can touch the filesystem:
 *
 * - `prepare` builds a {@link SemanticRequest}: what was read, where writing is
 *   allowed, the limits, and an `input_digest` sealing the state it saw.
 * - `validate` parses the answer against that request and, if it survives,
 *   returns a preview plus an `approval_digest` over the exact bytes proposed.
 * - `apply` recomputes the input digest, checks the approval still matches, and
 *   only then publishes.
 *
 * Validation is manual (DEC-001: no Zod) and **fail-closed**: anything absent,
 * malformed, stale, oversized or outside the allowlist stops before the first
 * write and comes back with a next action.
 */

export const SEMANTIC_PROTOCOL_VERSION = 1;

export interface SemanticLimits {
  max_artifacts: number;
  max_artifact_bytes: number;
}

export interface SemanticRequest {
  version: number;
  operation: string;
  /** SHA-256 over the inputs this request was built from — the staleness seal. */
  input_digest: string;
  /**
   * The scope this request was prepared over, opaque to the protocol and
   * meaningful only to the operation.
   *
   * It exists because the three stages are stateless: `validate` and `apply`
   * rebuild the request from the workspace, and anything the rebuild derives
   * from the invocation (which sessions, which day, which pending number) is a
   * seal input the invoker would otherwise have to reproduce by hand. Copied
   * back VERBATIM in the answer, it lets the later stages rebuild THIS request
   * instead of one made from whatever flags the invocation happened to repeat.
   *
   * It is sealed by `input_digest`, so an altered echo does not pass as the
   * original: the rebuilt request digests differently and the answer is stale.
   */
  scope?: unknown;
  /**
   * What the seal covers, in prose — so a stale rejection can name the concrete
   * cause instead of only stating that two digests differ.
   */
  sealed?: string;
  /** What a valid answer must contain, in prose the model reads. */
  contract: string;
  /** Operation-specific consultative data (never authoritative). */
  inventory: unknown;
  /** Workspace-relative directories an artifact may land in. */
  allowed_destinations: string[];
  limits: SemanticLimits;
  /** Everything the CLI read to build this — visible, so the cost is auditable. */
  read_set: string[];
  metrics: { request_bytes: number; read_set_bytes: number };
}

export type SemanticState = "proposed" | "ambiguous" | "unsupported";

export interface SemanticArtifact {
  /** Workspace-relative path inside one of `allowed_destinations`. */
  path: string;
  content: string;
}

export interface SemanticResponse {
  version: number;
  operation: string;
  input_digest: string;
  state: SemanticState;
  /** The request's `scope`, copied back verbatim. See {@link SemanticRequest.scope}. */
  scope?: unknown;
  decisions?: Record<string, unknown>;
  artifacts?: SemanticArtifact[];
  reason?: string;
}

export interface SemanticFailure {
  code: string;
  message: string;
  /** One valid next action — never a dead end. */
  action: string;
}

export type SemanticParse<T> = { ok: true; value: T } | { ok: false; failure: SemanticFailure };

/** Stable SHA-256 of a value: object keys sorted so equal state digests equally. */
export function semanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted BY CODE UNIT, `undefined` dropped.
 *
 * Exported because a design baseline seals its revision with a digest over
 * exactly this form — one canonicalization for the whole system, or two digests
 * of the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // Code units, NOT `localeCompare`: collation is locale- and ICU-dependent
    // (sv-SE orders `a,o,z,ä,ö`; de-DE orders `a,ä,o,ö,z`), so the same document
    // would digest differently on two machines and a published baseline would
    // read as tampered. RFC 8785 sorts by code units for exactly this reason.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export interface BuildRequestInput {
  operation: string;
  inputs: unknown;
  contract: string;
  inventory: unknown;
  allowedDestinations: string[];
  limits: SemanticLimits;
  readSet: string[];
  readSetBytes: number;
  /** See {@link SemanticRequest.scope}. Operations with no scope omit it. */
  scope?: unknown;
  /** See {@link SemanticRequest.sealed}. */
  sealed?: string;
}

export function buildSemanticRequest(input: BuildRequestInput): SemanticRequest {
  const request: SemanticRequest = {
    version: SEMANTIC_PROTOCOL_VERSION,
    operation: input.operation,
    input_digest: semanticDigest(input.inputs),
    // Spread-on-defined, not `scope: input.scope`: an operation without a scope
    // must produce the same bytes it produced before the field existed, or its
    // `request_bytes` (a budgeted figure) moves for a field it never uses.
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.sealed !== undefined ? { sealed: input.sealed } : {}),
    contract: input.contract,
    inventory: input.inventory,
    allowed_destinations: input.allowedDestinations,
    limits: input.limits,
    read_set: input.readSet,
    metrics: { request_bytes: 0, read_set_bytes: input.readSetBytes },
  };
  // Measured after the shape is final, then written back: the number describes
  // the payload actually sent, which is what the spec 009 budgets will consume.
  request.metrics.request_bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  return request;
}

/**
 * Parse and validate an answer against the request that produced it. Every
 * rejection names the problem and a next action; none of them writes.
 */
export function parseSemanticResponse(
  raw: string,
  request: SemanticRequest,
): SemanticParse<SemanticResponse> {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;

  const envelope = parsed.value as Partial<SemanticResponse>;
  const header = checkHeader(envelope, request);
  if (header !== null) return { ok: false, failure: header };

  const state = envelope.state;
  if (state === "ambiguous" || state === "unsupported") {
    return {
      ok: false,
      failure: {
        code: state === "ambiguous" ? "SEMANTIC_AMBIGUOUS" : "SEMANTIC_UNSUPPORTED",
        message: envelope.reason ?? `la respuesta se declaró '${state}' sin explicar por qué`,
        action:
          state === "ambiguous"
            ? "resolvé la ambigüedad y volvé a responder, o acotá la operación"
            : "la operación no aplica a este contenido: no hay nada que escribir",
      },
    };
  }

  const artifacts = parseSemanticArtifacts(envelope.artifacts, request);
  if (!artifacts.ok) return artifacts;

  return {
    ok: true,
    value: {
      version: SEMANTIC_PROTOCOL_VERSION,
      operation: request.operation,
      input_digest: request.input_digest,
      state: "proposed",
      ...(isRecord(envelope.decisions) ? { decisions: envelope.decisions } : {}),
      artifacts: artifacts.value,
    },
  };
}

/**
 * The `scope` an answer echoes, read BEFORE the request it will be checked
 * against exists — a stage needs it to rebuild that very request.
 *
 * `undefined` covers both "the answer carries no scope" (a pre-scope answer,
 * which falls back to the invocation's own flags) and "the answer is not
 * readable JSON": diagnosing the second is `parseSemanticResponse`'s job and it
 * runs a moment later, so failing here would only move the same error earlier
 * and word it worse.
 */
export function readEnvelopeScope(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed.scope : undefined;
  } catch {
    return undefined;
  }
}

function parseJson(raw: string): SemanticParse<unknown> {
  if (raw.trim().length === 0) {
    return {
      ok: false,
      failure: {
        code: "SEMANTIC_RESPONSE_MISSING",
        message: "no llegó respuesta semántica por stdin",
        action: "volvé a invocar pasando el JSON de respuesta por stdin",
      },
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      failure: {
        code: "SEMANTIC_RESPONSE_INVALID",
        message: "la respuesta semántica no es JSON válido",
        action: "reenviá la respuesta como un único objeto JSON completo",
      },
    };
  }
}

function checkHeader(
  envelope: Partial<SemanticResponse>,
  request: SemanticRequest,
): SemanticFailure | null {
  if (!isRecord(envelope)) {
    return invalid("la respuesta no es un objeto JSON");
  }
  // Absence is checked BEFORE value, header by header. Folding the two together
  // makes the error name the missing value (`estado desconocido: undefined`)
  // instead of the missing FIELD, and an executor who never saw the envelope
  // cannot tell `state` from `status` by reading that.
  if (envelope.version === undefined) {
    return missing("version", `el número ${SEMANTIC_PROTOCOL_VERSION}`);
  }
  if (envelope.version !== SEMANTIC_PROTOCOL_VERSION) {
    return invalid(`versión de protocolo no soportada: ${String(envelope.version)}`);
  }
  if (envelope.operation === undefined) {
    return missing("operation", `'${request.operation}', copiado del request`);
  }
  if (envelope.operation !== request.operation) {
    return invalid(
      `la respuesta dice operación '${String(envelope.operation)}' y esta es '${request.operation}'`,
    );
  }
  if (envelope.input_digest === undefined) {
    return missing("input_digest", `'${request.input_digest}', copiado del request`);
  }
  // The staleness seal: the world moved between prepare and this answer, so the
  // inventory, the numbering and the duplicate check it reasoned over are gone.
  // The message names WHAT the seal covers — the digests alone say two hashes
  // differ, which is true of every cause and diagnostic of none.
  if (envelope.input_digest !== request.input_digest) {
    return {
      code: "SEMANTIC_STALE",
      message: `${request.sealed ?? "el estado que el request selló"} cambió entre preparar y responder: la respuesta trae 'input_digest' ${String(envelope.input_digest)} y este request selló ${request.input_digest}`,
      // Conditioned like the message above: this module is shared by persist,
      // fix-git, the flow and the design capability, and none of them carries a
      // `scope`. Promising an envelope that will bring the scope back would send
      // those callers looking for something that does not exist there.
      action:
        request.scope === undefined
          ? `volvé a correr prepare y respondé sobre el request nuevo, con 'input_digest': '${request.input_digest}'`
          : "volvé a correr prepare —el alcance con el que se preparó viaja en el sobre, así que no hace falta repetir los flags— y respondé sobre el request nuevo",
    };
  }
  if (envelope.state === undefined) {
    return missing("state", "proposed | ambiguous | unsupported");
  }
  const state = envelope.state;
  if (state !== "proposed" && state !== "ambiguous" && state !== "unsupported") {
    return invalid(`estado desconocido: ${String(state)}`);
  }
  return null;
}

/**
 * The candidate artifacts, checked against the request that asked for them.
 *
 * Exported because the flow engine receives artifacts on an answer that is NOT a
 * full semantic envelope, and a second implementation of "is this destination
 * legal, is it a duplicate, does it fit the limits" is how one caller ends up
 * enforcing the allowlist and the other not.
 */
export function parseSemanticArtifacts(
  raw: unknown,
  request: SemanticRequest,
): SemanticParse<SemanticArtifact[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, failure: invalid("una respuesta 'proposed' debe traer artifacts") };
  }
  if (raw.length > request.limits.max_artifacts) {
    return {
      ok: false,
      failure: invalid(
        `${raw.length} artefactos exceden el máximo de ${request.limits.max_artifacts}`,
      ),
    };
  }

  const seen = new Set<string>();
  const out: SemanticArtifact[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.content !== "string") {
      return { ok: false, failure: invalid("cada artefacto necesita 'path' y 'content' de texto") };
    }
    const path = checkPath(entry.path, request.allowed_destinations);
    if (!path.ok) return path;
    if (seen.has(path.value)) {
      return { ok: false, failure: invalid(`el artefacto '${path.value}' viene repetido`) };
    }
    const bytes = Buffer.byteLength(entry.content, "utf8");
    if (bytes > request.limits.max_artifact_bytes) {
      return {
        ok: false,
        failure: invalid(
          `'${path.value}' pesa ${bytes} B y el máximo es ${request.limits.max_artifact_bytes} B`,
        ),
      };
    }
    seen.add(path.value);
    out.push({ path: path.value, content: entry.content });
  }
  return { ok: true, value: out };
}

/**
 * A destination is only legal if it is workspace-relative and lands INSIDE one
 * of the declared directories. Absolute paths, `..`, backslashes and bare
 * prefix matches (`docs/specs-evil`) are all rejected — the allowlist is the
 * write boundary, so it is checked on normalized segments, never on a string
 * `startsWith`.
 */
function checkPath(raw: string, allowed: string[]): SemanticParse<string> {
  const path = raw.trim();
  const reject = (why: string): SemanticParse<string> => ({
    ok: false,
    failure: {
      code: "SEMANTIC_PATH_REJECTED",
      message: `destino no permitido ('${raw}'): ${why}`,
      action: `escribí solo dentro de: ${allowed.join(", ")}`,
    },
  });

  const safe = checkSafeRelativePath(path);
  if (!safe.ok) return reject(safe.why);
  const segments = safe.segments;
  // A destination is either a directory to write INSIDE (persist, exports) or an
  // exact file already identified as writable (fix-git's conflict set). Both are
  // compared on segments, so `docs/research-evil` never passes as `docs/research`.
  const inside = allowed.some((dest) => {
    const destSegments = dest.split("/").filter((s) => s.length > 0);
    if (segments.length < destSegments.length) return false;
    if (!destSegments.every((segment, i) => segments[i] === segment)) return false;
    return segments.length > destSegments.length || path === dest;
  });
  if (!inside) return reject("cae fuera de los destinos declarados");
  return { ok: true, value: path };
}

/**
 * Seal over the exact artifacts shown to the human. `apply` refuses anything
 * whose digest differs, so what gets approved is what gets written — not a
 * later edit of the same proposal.
 */
export function approvalDigest(response: SemanticResponse): string {
  return semanticDigest({
    operation: response.operation,
    input_digest: response.input_digest,
    artifacts: (response.artifacts ?? []).map((a) => ({
      path: a.path,
      content_digest: semanticDigest(a.content),
    })),
  });
}

function invalid(message: string): SemanticFailure {
  return {
    code: "SEMANTIC_RESPONSE_INVALID",
    message,
    action: "corregí la respuesta según el 'contract' del request y reenviala",
  };
}

/** A header that is absent names itself, with the value the request expects there. */
function missing(field: string, expected: string): SemanticFailure {
  return invalid(`falta el campo obligatorio '${field}' del sobre: esperaba ${expected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
