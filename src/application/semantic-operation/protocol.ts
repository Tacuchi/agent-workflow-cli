import { createHash } from "node:crypto";

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
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
}

export function buildSemanticRequest(input: BuildRequestInput): SemanticRequest {
  const request: SemanticRequest = {
    version: SEMANTIC_PROTOCOL_VERSION,
    operation: input.operation,
    input_digest: semanticDigest(input.inputs),
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

  const artifacts = checkArtifacts(envelope.artifacts, request);
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
  if (envelope.version !== SEMANTIC_PROTOCOL_VERSION) {
    return invalid(`versión de protocolo no soportada: ${String(envelope.version)}`);
  }
  if (envelope.operation !== request.operation) {
    return invalid(
      `la respuesta dice operación '${String(envelope.operation)}' y esta es '${request.operation}'`,
    );
  }
  // The staleness seal: the world moved between prepare and this answer, so the
  // inventory, the numbering and the duplicate check it reasoned over are gone.
  if (envelope.input_digest !== request.input_digest) {
    return {
      code: "SEMANTIC_STALE",
      message: "la respuesta responde a un estado anterior del workspace",
      action: "volvé a correr prepare y respondé sobre el request nuevo",
    };
  }
  const state = envelope.state;
  if (state !== "proposed" && state !== "ambiguous" && state !== "unsupported") {
    return invalid(`estado desconocido: ${String(state)}`);
  }
  return null;
}

function checkArtifacts(raw: unknown, request: SemanticRequest): SemanticParse<SemanticArtifact[]> {
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

  if (path.length === 0) return reject("está vacío");
  if (path.includes("\\")) return reject("usa separador de Windows");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return reject("es absoluto");

  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "." || s.length === 0)) {
    return reject("contiene segmentos relativos o vacíos");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
