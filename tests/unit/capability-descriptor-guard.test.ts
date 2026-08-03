import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_KEYS,
  CAPABILITY_DESCRIPTOR_SCHEMA_ID,
  CAPABILITY_GRAMMAR,
  validateCapabilityDescriptor,
} from "../../src/domain/capability/descriptor.js";
import { EFFECT_CLASSES } from "../../src/domain/capability/effects.js";
import { CANONICAL_SCHEMAS } from "../../src/domain/design/capability.js";

/**
 * The drift guard of the capability contract — its own, deliberately.
 *
 * `design-schema-guard` covers the UI Design Package formats and enumerates
 * everything published under `skills/w/schemas/design/`. The capability
 * descriptor is NOT one of those: it is the cross-cutting contract any
 * capability declares, design included. Sharing that guard would have meant
 * cataloguing it next to `workline.ui-screen/v1`, which is exactly the coupling
 * the contract is supposed to avoid — so it gets the same mechanical check under
 * its own roof.
 *
 * The check runs in both directions: every property the schema declares is READ
 * by the hand-written validator, and every object the schema closes is closed by
 * the validator with the same key set.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(`${repoRoot}${rel}`, "utf8");

const SCHEMA_PATH = "skills/w/schemas/capability-descriptor.schema.json";
const FIXTURE_PATH = "tests/fixtures/capability/descriptor-maximal.json";

interface SchemaNode {
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
}

function walk(
  node: SchemaNode,
  prefix: string,
  properties: Set<string>,
  objects: Map<string, string[]>,
  required: Set<string>,
): void {
  if (node.items !== undefined) {
    walk(node.items, `${prefix}[]`, properties, objects, required);
    return;
  }
  if (node.properties === undefined) return;
  if (node.additionalProperties === false) {
    objects.set(prefix, Object.keys(node.properties).sort());
  }
  for (const key of node.required ?? []) {
    required.add(prefix === "" ? key : `${prefix}.${key}`);
  }
  for (const [key, child] of Object.entries(node.properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    properties.add(path);
    walk(child, path, properties, objects, required);
  }
}

function analyze(): {
  declared: Set<string>;
  closed: Map<string, string[]>;
  required: Set<string>;
} {
  const schema = JSON.parse(read(SCHEMA_PATH)) as SchemaNode;
  const declared = new Set<string>();
  const closed = new Map<string, string[]>();
  const required = new Set<string>();
  walk(schema, "", declared, closed, required);
  return { declared, closed, required };
}

const maximal = (): Record<string, unknown> => JSON.parse(read(FIXTURE_PATH));

describe("el schema publicado del descriptor y su validador no derivan", () => {
  it("el fixture maximal ejerce el contrato entero", () => {
    const result = validateCapabilityDescriptor(maximal());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    // Un schema ilegible o vacío haría pasar la cobertura midiendo cero, así que
    // el piso se ancla contra la tabla de claves del validador — otra fuente.
    expect(analyze().declared.size).toBeGreaterThanOrEqual((ALLOWED_KEYS[""] ?? []).length);
    expect(result.touched.size, "el validador leyó algo").toBeGreaterThan(0);
  });

  it("el validador lee cada propiedad que el schema declara", () => {
    const { declared } = analyze();
    const touched = validateCapabilityDescriptor(maximal()).touched;
    const unchecked = [...declared].filter((p) => !touched.has(p)).sort();
    expect(unchecked, "propiedades del schema que el validador nunca mira").toEqual([]);
  });

  it("el validador no inventa propiedades que el schema no declara", () => {
    const { declared } = analyze();
    const touched = validateCapabilityDescriptor(maximal()).touched;
    const undeclared = [...touched].filter((p) => !declared.has(p)).sort();
    expect(undeclared, "propiedades que el validador lee y el schema no declara").toEqual([]);
  });

  it("cada objeto que el schema cierra está cerrado con el mismo juego de claves", () => {
    const { closed } = analyze();
    const validatorKeys = Object.fromEntries(
      Object.entries(ALLOWED_KEYS).map(([path, keys]) => [path, [...keys].sort()]),
    );
    expect(validatorKeys).toEqual(Object.fromEntries(closed));
  });

  // La cobertura prueba que el validador LEE la propiedad. La obligatoriedad
  // prueba que RECLAMA cuando falta: dos promesas distintas, y la segunda es
  // donde un validador se afloja sin que nada lo note.
  it("omitir una clave obligatoria de primer nivel produce un fallo", () => {
    const tolerated: string[] = [];
    let checked = 0;
    for (const key of analyze().required) {
      if (key.includes(".") || key.includes("[")) continue;
      checked += 1;
      const doc = maximal();
      delete doc[key];
      if (!validateCapabilityDescriptor(doc).ok) continue;
      tolerated.push(key);
    }
    const validatorRootKeys = (ALLOWED_KEYS[""] ?? []).length;
    expect(validatorRootKeys, "el validador declara claves de raíz").toBeGreaterThan(0);
    expect(checked, "claves obligatorias probadas vs claves de raíz del validador").toBe(
      validatorRootKeys,
    );
    expect(tolerated, "claves que el schema exige y el validador acepta ausentes").toEqual([]);
  });
});

/** Every `pattern` anywhere in the schema, however deeply nested. */
function collectPatterns(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectPatterns(v, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (typeof record.pattern === "string") out.push(record.pattern);
  for (const v of Object.values(record)) collectPatterns(v, out);
}

/** Every `enum` array anywhere in the schema. */
function collectEnums(node: unknown, out: string[][]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectEnums(v, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.enum)) out.push(record.enum as string[]);
  for (const v of Object.values(record)) collectEnums(v, out);
}

describe("la gramática publicada es la misma que la del código", () => {
  const patterns = (): string[] => {
    const out: string[] = [];
    collectPatterns(JSON.parse(read(SCHEMA_PATH)), out);
    return out;
  };

  it("cada patrón del schema se construye con un fragmento de CAPABILITY_GRAMMAR", () => {
    const fragments = Object.values(CAPABILITY_GRAMMAR);
    const offenders = patterns().filter((p) => !fragments.some((f) => p.includes(f)));
    expect(offenders, "patrones con una gramática distinta de la del código").toEqual([]);
  });

  it("y el guard mira patrones de verdad, no un array vacío", () => {
    expect(patterns().length).toBeGreaterThan(3);
  });

  // La taxonomía de efectos vive en el código y se publica en el schema. Agregar
  // una clase en un solo lado deja el contrato normativo describiendo algo que
  // el runtime no reconoce, que es la misma deriva que el resto del guard cierra.
  it("la taxonomía de clases de efecto publicada es la del código", () => {
    const enums: string[][] = [];
    collectEnums(JSON.parse(read(SCHEMA_PATH)), enums);
    const published = enums.find((e) => e.includes("read_only"));
    expect(published?.slice().sort()).toEqual([...EFFECT_CLASSES].sort());
  });
});

describe("el contrato transversal no es un formato de diseño", () => {
  it("no aparece en CANONICAL_SCHEMAS", () => {
    expect(Object.values(CANONICAL_SCHEMAS)).not.toContain(CAPABILITY_DESCRIPTOR_SCHEMA_ID);
    expect(Object.values(CANONICAL_SCHEMAS).some((id) => id.includes("capability"))).toBe(false);
  });

  it("no se publica dentro del bundle de schemas de diseño", () => {
    const designSchemas = readdirSync(`${repoRoot}skills/w/schemas/design`);
    expect(designSchemas).not.toContain("capability-descriptor.schema.json");
    // Y sí existe donde corresponde: fuera de ese directorio.
    expect(readdirSync(`${repoRoot}skills/w/schemas`)).toContain(
      "capability-descriptor.schema.json",
    );
  });

  it("el descriptor no importa nada de domain/design", () => {
    const source = read("src/domain/capability/descriptor.ts");
    expect(source).not.toMatch(/from "\.\.\/design\//);
    expect(read("src/domain/capability/protocol.ts")).not.toMatch(/from "\.\.\/design\//);
    expect(read("src/domain/capability/effects.ts")).not.toMatch(/from "\.\.\/design\//);
  });
});
