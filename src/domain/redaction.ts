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
