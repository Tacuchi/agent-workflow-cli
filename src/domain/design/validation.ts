/**
 * The shared machinery every design validator is built on.
 *
 * Three properties hold across the manifest, the flow and the screen validators,
 * and they live here so no validator can quietly drop one:
 *
 * - **Every diagnostic names an artifact and a corrective action.** A rejection
 *   that only says "invalid" is a dead end for whoever has to fix it.
 * - **Objects are closed.** The published JSON Schemas declare
 *   `additionalProperties: false`, so a key the contract does not declare is a
 *   typo of a real one, never an extension.
 * - **Coverage is measured, not promised.** Every property read is recorded, and
 *   the drift guard compares that set against the published schema. A property
 *   declared in the schema and forgotten in the validator cannot ship.
 */

export interface DesignFailure {
  code: string;
  /** What is wrong — a field path, or the offending file path. */
  artifact: string;
  message: string;
  /** The one corrective action. A diagnostic without it is a dead end. */
  action: string;
}

/** Property path (`""` root, `[]` array item) → the keys that object admits. */
export type AllowedKeys = Readonly<Record<string, readonly string[]>>;

export class Reader {
  readonly touched = new Set<string>();
  readonly failures: DesignFailure[] = [];

  constructor(private readonly allowedKeys: AllowedKeys) {}

  /** Read `path`'s last segment off `node`, recording the property as covered. */
  read(node: Record<string, unknown>, path: string): unknown {
    this.touched.add(path);
    const segments = path.split(".");
    const key = (segments[segments.length - 1] as string).replace("[]", "");
    return node[key];
  }

  fail(code: string, artifact: string, message: string, action: string): void {
    this.failures.push({ code, artifact, message, action });
  }

  invalid(artifact: string, message: string, action: string): void {
    this.fail("DESIGN_FIELD_INVALID", artifact, message, action);
  }

  /** Reject anything the contract does not declare at `path` (closed objects). */
  closed(node: Record<string, unknown>, path: string, artifact: string): void {
    const allowed = this.allowedKeys[path];
    if (allowed === undefined) return;
    for (const key of Object.keys(node)) {
      if (allowed.includes(key)) continue;
      this.fail(
        "DESIGN_KEY_UNKNOWN",
        artifact,
        `${path === "" ? "el documento" : `'${path}'`} no admite la clave '${key}'`,
        `quitala o corregí el nombre; las claves válidas son: ${allowed.join(", ")}`,
      );
    }
  }
}

/**
 * Walk an array-of-objects field. Every list in the contract shares the same
 * three failure modes — not an array, an item that is not an object, an item
 * carrying a key the schema does not declare — so they are stated once here and
 * each reader stays about ITS own fields.
 */
export function* eachRecord(
  r: Reader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
  emptyMeans = "",
): Generator<Record<string, unknown>> {
  const list = r.read(node, path);
  if (!Array.isArray(list)) {
    r.invalid(artifact, `'${path}' debe ser un array${emptyMeans}`, `escribí '${path}': []`);
    return;
  }
  for (const entry of list) {
    if (!isRecord(entry)) {
      r.invalid(
        artifact,
        `cada entrada de '${path}' debe ser un objeto`,
        `revisá el array '${path}'`,
      );
      continue;
    }
    r.closed(entry, `${path}[]`, artifact);
    yield entry;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
