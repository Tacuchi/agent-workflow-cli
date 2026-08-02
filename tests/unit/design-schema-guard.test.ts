import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_KEYS as ARTIFACT_ALLOWED_KEYS,
  validateDesignArtifact,
} from "../../src/domain/design/artifact.js";
import {
  ALLOWED_KEYS as MANIFEST_ALLOWED_KEYS,
  validateDesignManifest,
} from "../../src/domain/design/manifest.js";
import type { AllowedKeys } from "../../src/domain/design/validation.js";

/**
 * The schema↔validator drift guard (plan 012, T1.4 and T2.1–T2.2).
 *
 * The JSON Schemas are the NORMATIVE contract and every validator is written by
 * hand (same call as DEC-001: no schema engine, no new dependency), so the two
 * can silently separate. Nothing else prevents that — this is the barrier, and
 * it checks both directions mechanically for EVERY contract at once:
 *
 *  1. every property the schema declares is READ by the validator (proved by the
 *     property paths a full run touches, not by a hand-kept list); and
 *  2. every object the schema closes is closed by the validator with the SAME
 *     key set.
 *
 * A property added to a schema and forgotten in its validator fails here before
 * it can ship. Adding a contract without adding it to CONTRACTS fails too — the
 * count is asserted against the schemas actually published on disk.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(`${repoRoot}${rel}`, "utf8");

interface SchemaNode {
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
}

interface Contract {
  name: string;
  schemaPath: string;
  allowedKeys: AllowedKeys;
  /** Runs the real validator over a maximal fixture. */
  run: () => { ok: boolean; touched: ReadonlySet<string> };
  /** The same, with one top-level key removed from the fixture. */
  runWithout: (key: string) => { ok: boolean };
}

const CONTRACTS: Contract[] = [
  {
    name: "design-manifest/v1",
    schemaPath: "skills/w/schemas/design/design-manifest.v1.schema.json",
    allowedKeys: MANIFEST_ALLOWED_KEYS,
    run: () =>
      validateDesignManifest(JSON.parse(read("tests/fixtures/design/manifest-maximal.json"))),
    runWithout: (key) => {
      const doc = JSON.parse(read("tests/fixtures/design/manifest-maximal.json"));
      delete doc[key];
      return validateDesignManifest(doc);
    },
  },
  {
    name: "ui-flow/v1",
    schemaPath: "skills/w/schemas/design/ui-flow.v1.schema.json",
    allowedKeys: ARTIFACT_ALLOWED_KEYS.flow,
    run: () =>
      validateDesignArtifact(
        read("tests/fixtures/design/FLW-001-r002-alta-miembro.md"),
        "flow",
        "flows/FLW-001-r002-alta-miembro.md",
      ),
    runWithout: (key) =>
      validateDesignArtifact(
        dropFrontmatterKey(read("tests/fixtures/design/FLW-001-r002-alta-miembro.md"), key),
        "flow",
        "flows/x.md",
      ),
  },
  {
    name: "ui-screen/v1",
    schemaPath: "skills/w/schemas/design/ui-screen.v1.schema.json",
    allowedKeys: ARTIFACT_ALLOWED_KEYS.screen,
    run: () =>
      validateDesignArtifact(
        read("tests/fixtures/design/SCR-001-r002-formulario-alta.md"),
        "screen",
        "screens/SCR-001-r002-formulario-alta.md",
      ),
    runWithout: (key) =>
      validateDesignArtifact(
        dropFrontmatterKey(read("tests/fixtures/design/SCR-001-r002-formulario-alta.md"), key),
        "screen",
        "screens/x.md",
      ),
  },
];

/** Remove one top-level frontmatter key from a design document. */
function dropFrontmatterKey(text: string, key: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l, i) => i > 0 && l.startsWith(`${key}:`));
  if (start === -1) throw new Error(`el fixture no declara '${key}'`);
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end] as string)) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function deref(node: SchemaNode, root: SchemaNode): SchemaNode {
  if (node.$ref === undefined) return node;
  const name = node.$ref.replace("#/$defs/", "");
  const target = root.$defs?.[name];
  if (target === undefined) throw new Error(`$ref sin destino: ${node.$ref}`);
  return deref(target, root);
}

/** Property paths (`catalog.flows[].id`) and closed objects (path → keys). */
function walk(
  node: SchemaNode,
  prefix: string,
  root: SchemaNode,
  properties: Set<string>,
  objects: Map<string, string[]>,
  required: Set<string>,
): void {
  const here = deref(node, root);
  if (here.items !== undefined) {
    walk(here.items, `${prefix}[]`, root, properties, objects, required);
    return;
  }
  if (here.properties === undefined) return;
  if (here.additionalProperties === false) {
    objects.set(prefix, Object.keys(here.properties).sort());
  }
  if (here.required !== undefined) {
    for (const key of here.required) {
      required.add(prefix === "" ? key : `${prefix}.${key}`);
    }
  }
  for (const [key, child] of Object.entries(here.properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    properties.add(path);
    walk(child, path, root, properties, objects, required);
  }
}

function analyze(contract: Contract): {
  declared: Set<string>;
  closed: Map<string, string[]>;
  required: Set<string>;
} {
  const schema = JSON.parse(read(contract.schemaPath)) as SchemaNode;
  const declared = new Set<string>();
  const closed = new Map<string, string[]>();
  const required = new Set<string>();
  walk(schema, "", schema, declared, closed, required);
  return { declared, closed, required };
}

describe("los schemas de diseño publicados y sus validadores no derivan", () => {
  // Publicar un schema sin declararlo acá lo dejaría fuera del guard: existiría
  // como contrato normativo y nadie comprobaría que su validador lo sigue.
  it("hay un contrato declarado por cada schema publicado en el bundle", () => {
    const published = readdirSync(`${repoRoot}skills/w/schemas/design`)
      .filter((f) => f.endsWith(".schema.json"))
      .sort();
    const covered = CONTRACTS.map((c) => c.schemaPath.split("/").pop() as string).sort();
    expect(covered).toEqual(published);
  });

  it.each(CONTRACTS.map((c) => [c.name, c] as const))(
    "%s — el fixture maximal ejerce el contrato entero",
    (_name, contract) => {
      const result = contract.run();
      expect(result.ok).toBe(true);
      expect(analyze(contract).declared.size).toBeGreaterThan(10);
    },
  );

  it.each(CONTRACTS.map((c) => [c.name, c] as const))(
    "%s — el validador lee cada propiedad que el schema declara",
    (_name, contract) => {
      const { declared } = analyze(contract);
      const touched = contract.run().touched;
      const unchecked = [...declared].filter((p) => !touched.has(p)).sort();
      expect(unchecked, "propiedades del schema que el validador nunca mira").toEqual([]);
    },
  );

  it.each(CONTRACTS.map((c) => [c.name, c] as const))(
    "%s — el validador no inventa propiedades que el schema no declara",
    (_name, contract) => {
      const { declared } = analyze(contract);
      const touched = contract.run().touched;
      const undeclared = [...touched].filter((p) => !declared.has(p)).sort();
      expect(undeclared, "propiedades que el validador lee y el schema no declara").toEqual([]);
    },
  );

  it.each(CONTRACTS.map((c) => [c.name, c] as const))(
    "%s — cada objeto que el schema cierra está cerrado con el mismo juego de claves",
    (_name, contract) => {
      const { closed } = analyze(contract);
      const validatorKeys = Object.fromEntries(
        Object.entries(contract.allowedKeys).map(([path, keys]) => [path, [...keys].sort()]),
      );
      expect(validatorKeys).toEqual(Object.fromEntries(closed));
    },
  );

  // Coverage proves the validator READS a property. Requiredness proves it
  // COMPLAINS when the property is absent — two different promises, and the
  // second is where the validator quietly diverged before the review gate.
  it.each(CONTRACTS.map((c) => [c.name, c] as const))(
    "%s — omitir una clave obligatoria de primer nivel produce un fallo",
    (_name, contract) => {
      const tolerated: string[] = [];
      let checked = 0;
      for (const key of analyze(contract).required) {
        if (key.includes(".") || key.includes("[")) continue;
        checked += 1;
        if (!contract.runWithout(key).ok) continue;
        tolerated.push(key);
      }
      // Sin esto, un `required` vacío o un helper que no borra nada dejaría el
      // guard en verde sin haber comprobado absolutamente nada.
      expect(checked, "claves obligatorias efectivamente probadas").toBeGreaterThan(9);
      expect(tolerated, "claves que el schema exige y el validador acepta ausentes").toEqual([]);
    },
  );
});
