/**
 * The numeric identity used by Workline sessions and documents.
 *
 * A correlative is a filename-safe decimal string with a minimum display width
 * of three digits. The width is a presentation floor, not a ceiling: `1000`
 * follows `999` and must never be read as `100` just because older readers
 * sliced three characters from a name.
 *
 * Design-package identifiers deliberately do not use this module. They have
 * their own grammar (`DES-…`, revisions, criteria) and are not document or
 * session correlatives.
 */
export const CORRELATIVE_RE = /^\d{3,}$/;

/**
 * A human-supplied decimal identity before it is made durable.
 *
 * Persisted document and session names stay bound to `CORRELATIVE_RE`: accepting
 * `7` on disk would reintroduce two spellings for one record. Command input is
 * different. Older invocations used short numbers, so a boundary may normalize
 * that unambiguous decimal spelling to the durable three-digit floor.
 */
const CORRELATIVE_INPUT_RE = /^\d+$/;

/** The matching source is exported for callers that need to compose a regex. */
export const CORRELATIVE_SOURCE = "\\d{3,}";

/** Whether a value is a complete Workline correlative. */
export function isCorrelative(value: unknown): value is string {
  return typeof value === "string" && CORRELATIVE_RE.test(value);
}

/**
 * Read a correlative numerically without the precision loss of `Number`.
 *
 * `null` means the string is not a correlative; callers should not silently
 * coerce a short or mixed identifier into one.
 */
export function correlativeValue(value: string): bigint | null {
  return isCorrelative(value) ? BigInt(value) : null;
}

/** The canonical spelling of a numeric identity, or `null` for an invalid one. */
export function normalizeCorrelative(value: string): string | null {
  const parsed = correlativeValue(value);
  return parsed === null ? null : formatCorrelative(parsed);
}

/**
 * Normalize a decimal value supplied at an input boundary, including legacy
 * short spellings such as `7` and `24`. Never use this while discovering names
 * on disk: those names must already satisfy `isCorrelative`.
 */
export function normalizeCorrelativeInput(value: string): string | null {
  const trimmed = value.trim();
  return CORRELATIVE_INPUT_RE.test(trimmed) ? formatCorrelative(BigInt(trimmed)) : null;
}

/** Render a non-negative integer with Workline's minimum display width. */
export function formatCorrelative(value: bigint | number): string {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n) throw new Error("un correlativo no puede ser negativo");
  return parsed.toString().padStart(3, "0");
}

/** The immediate successor, preserving the three-digit minimum and no maximum. */
export function nextCorrelative(value: string): string {
  const parsed = correlativeValue(value);
  if (parsed === null) throw new Error(`'${value}' no es un correlativo válido`);
  return formatCorrelative(parsed + 1n);
}

/** Numeric order for two valid correlatives, independent of their width. */
export function compareCorrelatives(left: string, right: string): number {
  const leftValue = correlativeValue(left);
  const rightValue = correlativeValue(right);
  if (leftValue === null || rightValue === null) {
    throw new Error("solo se pueden comparar correlativos válidos");
  }
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

/** Whether two valid spellings carry the same numeric identity. */
export function sameCorrelative(left: string, right: string): boolean {
  return compareCorrelatives(left, right) === 0;
}

/** The numerically largest valid item, or `null` when the input has none. */
export function maxCorrelative(values: Iterable<string>): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (!isCorrelative(value)) continue;
    if (max === null || compareCorrelatives(value, max) > 0) max = value;
  }
  return max;
}

/**
 * A correlative at the start of a filename/folder, bounded by its own `-`.
 * `100` therefore cannot consume the first three digits of `1000-plan.md`.
 */
export function leadingCorrelative(name: string): string | null {
  return new RegExp(`^(${CORRELATIVE_SOURCE})(?:-|$)`).exec(name)?.[1] ?? null;
}

/** A leading correlative after a fixed legacy prefix such as `session`. */
export function prefixedCorrelative(name: string, prefix: string): string | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(${CORRELATIVE_SOURCE})(?:-|$)`).exec(name)?.[1] ?? null;
}

/**
 * Input counterpart of `leadingCorrelative`: accepts a legacy short spelling
 * and returns its canonical durable identity. It intentionally does not change
 * the strict matcher used for persisted folder and document names.
 */
export function leadingCorrelativeInput(value: string): string | null {
  const digits = /^(\d+)(?:-|$)/.exec(value.trim())?.[1];
  return digits === undefined ? null : normalizeCorrelativeInput(digits);
}

/** Input counterpart of `prefixedCorrelative`, for e.g. `session7`. */
export function prefixedCorrelativeInput(value: string, prefix: string): string | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const digits = new RegExp(`^${escaped}(\\d+)(?:-|$)`).exec(value.trim())?.[1];
  return digits === undefined ? null : normalizeCorrelativeInput(digits);
}
