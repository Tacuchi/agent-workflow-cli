import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_KEYS, validateDesignManifest } from "../../src/domain/design/manifest.js";

/**
 * The schema↔validator drift guard (plan 012, T1.4).
 *
 * The JSON Schema is the NORMATIVE contract and the validator is hand-written
 * (same call as DEC-001: no schema engine, no new dependency), so the two can
 * silently separate. Nothing else prevents that — this test is the barrier, and
 * it checks both directions mechanically:
 *
 *  1. every property the schema declares is READ by the validator (proved by the
 *     property paths a full run touches, not by a hand-kept list); and
 *  2. every object the schema closes is closed by the validator with the SAME
 *     key set.
 *
 * A property added to the schema and forgotten in the validator fails here
 * before it can ship.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const schema = JSON.parse(
  readFileSync(`${repoRoot}skills/w/schemas/design/design-manifest.v1.schema.json`, "utf8"),
) as SchemaNode;
const maximal = JSON.parse(
  readFileSync(`${repoRoot}tests/fixtures/design/manifest-maximal.json`, "utf8"),
) as unknown;

interface SchemaNode {
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean;
}

function deref(node: SchemaNode): SchemaNode {
  if (node.$ref === undefined) return node;
  const name = node.$ref.replace("#/$defs/", "");
  const target = schema.$defs?.[name];
  if (target === undefined) throw new Error(`$ref sin destino: ${node.$ref}`);
  return deref(target);
}

/** Property paths (`catalog.flows[].id`) and closed objects (path → keys). */
function walk(
  node: SchemaNode,
  prefix: string,
  properties: Set<string>,
  objects: Map<string, string[]>,
): void {
  const here = deref(node);
  if (here.items !== undefined) {
    walk(here.items, `${prefix}[]`, properties, objects);
    return;
  }
  if (here.properties === undefined) return;
  if (here.additionalProperties === false) {
    objects.set(prefix, Object.keys(here.properties).sort());
  }
  for (const [key, child] of Object.entries(here.properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    properties.add(path);
    walk(child, path, properties, objects);
  }
}

const declaredProperties = new Set<string>();
const closedObjects = new Map<string, string[]>();
walk(schema, "", declaredProperties, closedObjects);

describe("design-manifest v1 — el schema publicado y el validador no derivan", () => {
  it("el fixture maximal ejerce el schema completo (si no, el guard mediría de menos)", () => {
    expect(validateDesignManifest(maximal).ok).toBe(true);
    expect(declaredProperties.size).toBeGreaterThan(30);
  });

  it("el validador lee cada propiedad que el schema declara", () => {
    const touched = validateDesignManifest(maximal).touched;
    const unchecked = [...declaredProperties].filter((p) => !touched.has(p)).sort();
    expect(unchecked, "propiedades del schema que el validador nunca mira").toEqual([]);
  });

  it("el validador no inventa propiedades que el schema no declara", () => {
    const touched = validateDesignManifest(maximal).touched;
    const undeclared = [...touched].filter((p) => !declaredProperties.has(p)).sort();
    expect(undeclared, "propiedades que el validador lee y el schema no declara").toEqual([]);
  });

  it("cada objeto que el schema cierra está cerrado con el mismo juego de claves", () => {
    const validatorKeys = Object.fromEntries(
      Object.entries(ALLOWED_KEYS).map(([path, keys]) => [path, [...keys].sort()]),
    );
    expect(validatorKeys).toEqual(Object.fromEntries(closedObjects));
  });
});
