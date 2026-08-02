import type { DesignFailure } from "./validation.js";

/**
 * Credentials never enter a package.
 *
 * A package records an ACCESS CLASSIFICATION — `private`, `team`, `public` —
 * and never the thing that grants access. The distinction matters because a
 * package is a durable, committed, shareable dossier: a token that lands in one
 * is a token in every clone of the repo, forever, and rotating it does not
 * remove it from history.
 *
 * The repo's `code-scan-service` greps source trees with regexes; this walks an
 * already-parsed document instead, which is a different shape — the values are
 * structured, so the key is as much a signal as the value.
 */

/** Keys that hold a secret by definition. Their presence is the finding. */
const SECRET_KEYS =
  /^(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api_?key|apikey|private_?key|secret_?key|access_?key|credential|credentials|auth_?token|bearer|session_?id|cookie)$/i;

/** Shapes that are a credential wherever they appear, whatever the key. */
const SECRET_VALUES: Array<{ test: RegExp; what: string }> = [
  { test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "una clave privada PEM" },
  { test: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, what: "un token de GitHub" },
  { test: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, what: "un token de GitHub" },
  { test: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: "un token de Slack" },
  { test: /\bAKIA[0-9A-Z]{16}\b/, what: "una access key de AWS" },
  { test: /\bsk-[A-Za-z0-9]{20,}\b/, what: "una API key" },
  // Los proveedores que la spec declara obligatorios para v1 tienen su propio
  // prefijo, y no reconocerlos dejaba a AC-SEC-02 sin cubrir justo donde importa.
  { test: /\bfigd_[A-Za-z0-9_-]{20,}\b/, what: "un token de Figma" },
  { test: /\bfigu_[A-Za-z0-9_-]{20,}\b/, what: "un token de Figma" },
  { test: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "una API key de Google" },
  { test: /\bya29\.[0-9A-Za-z_-]{20,}\b/, what: "un token OAuth de Google" },
  { test: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, what: "una API key de Anthropic" },
  { test: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: "un JWT" },
  { test: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/, what: "un header de autorización" },
  // `https://user:password@host` — the one credential form that hides in a URL.
  {
    test: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
    what: "una URL con usuario y contraseña",
  },
];

export interface SecretFinding {
  /** Dotted path to the offending value, e.g. `catalog.renditions[0].locator`. */
  at: string;
  what: string;
}

/**
 * Walk a parsed document for credentials. Returns every finding: a document
 * with two leaked tokens should report two, not stop at the first.
 */
export function findSecrets(document: unknown, at = ""): SecretFinding[] {
  if (typeof document === "string") {
    const shape = SECRET_VALUES.find((s) => s.test.test(document));
    return shape === undefined ? [] : [{ at, what: shape.what }];
  }
  if (Array.isArray(document)) {
    return document.flatMap((v, i) => findSecrets(v, `${at}[${i}]`));
  }
  if (typeof document !== "object" || document === null) return [];

  const findings: SecretFinding[] = [];
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    const path = at.length === 0 ? key : `${at}.${key}`;
    // A key named `token` with ANY content is the finding — there is no value of
    // that field a package may carry, and wrapping it in an object
    // (`token: { value: … }`) does not make it a different field.
    if (SECRET_KEYS.test(key) && !isEmpty(value)) {
      findings.push({ at: path, what: `un campo '${key}'` });
      continue;
    }
    findings.push(...findSecrets(value, path));
  }
  return findings;
}

export function secretFailures(document: unknown, artifact: string): DesignFailure[] {
  return findSecrets(document).map((finding) => ({
    code: "DESIGN_SECRET_PRESENT",
    artifact,
    message: `'${finding.at}' parece contener ${finding.what}`,
    action:
      "un package registra la CLASIFICACIÓN de acceso, nunca la credencial: quitala y rotala, ya está en el historial de git",
  }));
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}
