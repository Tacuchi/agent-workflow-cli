/**
 * Pure last-line defense for values that may be reflected in operational logs
 * or CLI errors. Domain validation still avoids echoing untrusted values; this
 * catches URI and assignment-shaped credentials from unexpected call paths.
 */
const CONNECTION_URI = /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)[^\s"'<>]+/gi;
const SECRET_ASSIGNMENT =
  /((?:--?(?:token|secret|password|passwd|pwd|api[-_]?key|key|auth(?:orization)?|dsn|database[-_]?url|pgpassword|pgpassfile)|["']?(?:token|secret|password|passwd|pwd|api[-_]?key|key|auth(?:orization)?|dsn|database[-_]?url|pgpassword|pgpassfile)["']?)\s*(?:=|:|\s+)\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi;
const SENSITIVE_KEY =
  /(?:^|_)(?:access_key|api_key|auth(?:orization)?|client_secret|connection_string|connection_url|connectionstring|connectionurl|credential(?:s)?|database_url|databaseurl|dsn|key|password|passwd|pgpassfile|pgpassword|private_key|pwd|secret|secrets|token|tokens)(?:_|$)/i;

export function redactSensitiveText(text: string): string {
  return text
    .replace(CONNECTION_URI, "$1***")
    .replace(SECRET_ASSIGNMENT, "$1***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");
}

/** Detect semantic secret fields even when their opaque value has no recognizable syntax. */
export function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return SENSITIVE_KEY.test(normalized);
}

/**
 * Whether one string carries credential-shaped material.
 *
 * The boolean core of the MCP receipt's `assertSecretFree`, lifted here because
 * a second caller appeared — the custody gate over a declared authentication
 * flow's `argv` — and two copies of this expression is how one surface starts
 * accepting what the other rejects. The extra pattern beside the redactor's own
 * is deliberate: `redactSensitiveText` only rewrites an assignment when it can
 * see a VALUE after it, and a bare `--token=` with nothing behind it is still a
 * request for a credential.
 */
export function carriesSecretMaterial(value: string): boolean {
  return (
    redactSensitiveText(value) !== value ||
    /(?:^|[?&;\s-])(?:password|passwd|secret|token|api[-_]?key|dsn|pgpassword|pgpassfile)\s*=/i.test(
      value,
    )
  );
}

/**
 * Whether one argument is a flag ASKING for a credential, value or not.
 *
 * Two expressions, and the union is the point: neither list alone is the answer.
 * The literal one catches the spellings written without a separator (`--apikey`),
 * which the normalized key list cannot see; `isSensitiveKey` catches the compound
 * names (`--access-token`, `--client-secret`, `--credentials`, `--private-key`,
 * `--connection-string`) that the literal list missed — and those were being let
 * through by the custody gate, which is the whole reason this is not one list any
 * more. Deriving the second half from `SENSITIVE_KEY` also means a name added
 * there is a name blocked here, instead of a third list to keep in sync.
 *
 * What no name list can cover is a flag that does not say what it carries
 * (`--pat`, `-t`). Those still pass, and the caller's docblock says so rather
 * than implying this predicate is a complete defense.
 */
export function isSecretFlag(value: string): boolean {
  if (
    /^--?(?:token|secret|password|passwd|pwd|api[-_]?key|key|auth|dsn|database[-_]?url|pgpassword|pgpassfile)(?:=|$)/i.test(
      value,
    )
  ) {
    return true;
  }
  if (!value.startsWith("-")) return false;
  const name = value.replace(/^-+/, "").split("=")[0] ?? "";
  return name.length > 0 && isSensitiveKey(name);
}

/** Safe predicate for configuration shapes that must never reflect credentials. */
export function containsSensitiveData(value: unknown): boolean {
  if (typeof value === "string") return redactSensitiveText(value) !== value;
  if (Array.isArray(value)) return value.some(containsSensitiveData);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, nested]) => isSensitiveKey(key) || containsSensitiveData(nested),
    );
  }
  return false;
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSensitiveKey(key) ? "***" : redactSensitiveValue(nested),
      ]),
    );
  }
  return value;
}
