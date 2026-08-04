import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLOW_BOUNDARY_KINDS,
  FLOW_DIRECTIVE_KEYS,
  type FlowBoundaryKind,
} from "../../src/domain/flow/directive.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

/**
 * A host surface invokes, transports and presents — and that is proved over the
 * documents themselves, because the surfaces ARE documents: wrappers, skills and
 * command doctrine.
 *
 * Two failures are what this guards against. One is silent loss: a presentation
 * that drops the alternatives, the explanation, the effects or the evidence that
 * lets the boundary be answered from another host. The other is a surface that
 * quietly decides — re-deriving a transition the engine already resolved. The
 * first is checked by demanding the contract name the directive's real fields;
 * the second by demanding the contract exist at all and carry no per-host
 * semantics, since a per-host rule is a second authority by construction.
 */

const BUNDLE = resolve(__dirname, "..", "..", "skills", "w");
const HARNESS_PATH = join(BUNDLE, "harness", "HARNESS.md");

const SECTION = "## Directive presentation (flow boundaries)";

async function harness(): Promise<string> {
  return readFile(HARNESS_PATH, "utf8");
}

/** The presentation section alone: the next `## ` heading ends it. */
async function presentation(): Promise<string> {
  const body = await harness();
  const start = body.indexOf(SECTION);
  expect(start, "falta el contrato de presentación en HARNESS.md").toBeGreaterThan(-1);
  const rest = body.slice(start + SECTION.length);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Rows of the presentation table, by boundary kind. */
async function rows(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const line of (await presentation()).split(/\r?\n/)) {
    const match = line.match(/^\|\s*\*\*([a-z]+)\*\*\s*\|(.+)\|\s*$/);
    if (match?.[1] !== undefined && match[2] !== undefined) out.set(match[1], match[2]);
  }
  return out;
}

describe("la superficie de host solo invoca, transporta y presenta", () => {
  it("el contrato existe y nombra los dos verbos del motor, no una derivación propia", async () => {
    const section = await presentation();
    expect(section).toContain("aw flow advance");
    expect(section).toContain("aw flow submit");
    expect(section).toMatch(/never re-derives a transition/);
  });

  it("cada motivo de frontera del protocolo tiene su fila de presentación", async () => {
    const table = await rows();
    const missing = FLOW_BOUNDARY_KINDS.filter((kind) => !table.has(kind));
    expect(missing).toEqual([]);
    // And no invented boundary: a row for something the engine cannot emit would
    // send a host to present a state that never happens.
    const known = new Set<string>(FLOW_BOUNDARY_KINDS);
    expect([...table.keys()].filter((kind) => !known.has(kind))).toEqual([]);
  });

  it("cada fila declara la capacidad que usa, y esa capacidad existe en el catálogo", async () => {
    const body = await harness();
    // The catalog is the table above: its first column names each capability in
    // bold. A presentation row may only point at one of those, or declare it needs
    // no host mechanism — never invent a capability nobody bound per host.
    const catalog = new Set(
      [...body.matchAll(/^\|\s*\*\*([a-z-]+)\*\*\s*\|/gm)].map((match) => match[1] ?? ""),
    );
    expect(catalog.size).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const [kind, cells] of await rows()) {
      const named = [...cells.matchAll(/\*([a-z-]+)\*/g)].map((match) => match[1] ?? "");
      const plain = /—\s*\(plain report\)|no human mechanism/.test(cells);
      if (named.length === 0 && !plain) offenders.push(`${kind}: no declara capacidad ni reporte`);
      for (const capability of named) {
        if (!catalog.has(capability))
          offenders.push(`${kind} → capacidad inexistente ${capability}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lo que la presentación no puede perder son campos reales de la directiva", async () => {
    const section = await presentation();
    const keys = new Set<string>(FLOW_DIRECTIVE_KEYS);
    // The four AC-HOST-01 names, each pinned to the field that carries it: a
    // requirement written against a field that does not exist would be prose.
    const required: Array<[string, string]> = [
      ["choices", "las opciones con su consecuencia"],
      ["request", "la explicación de lo que se pide"],
      ["effects", "los efectos en juego"],
      ["state_digest", "la evidencia de reanudación"],
    ];
    for (const [key, what] of required) {
      expect(keys.has(key), `${key} no es un campo de la directiva`).toBe(true);
      expect(section, what).toContain(`\`${key}\``);
    }
    expect(section).toContain("`session`");
    expect(section).toContain("`authorizations`");
  });

  it("el contrato de presentación no lleva semántica de un host concreto", async () => {
    // Per-host mechanisms live in the binding matrix and nowhere else: a rule
    // written per host in this section would be a second authority on what a
    // boundary means. Same check the chassis gets for structured-choice.
    const section = await presentation();
    for (const spec of HARNESSES) {
      expect(section, spec.id).not.toContain(spec.label);
    }
    expect(section).not.toMatch(/AskUserQuestion|request_user_input|ask_user|\/compact/);
    // It points at the matrix instead of copying a column out of it.
    expect(section).toMatch(/see the matrix|binding matrix/);
  });

  it("degradar el mecanismo nunca es degradar el contenido, y la pérdida se declara", async () => {
    const section = await presentation();
    expect(section).toMatch(/does not merge, truncate or drop alternatives/);
    expect(section).toMatch(/declared as one|is declared/);
  });

  it("ninguna superficie presenta como propia una transición que el CLI ya posee", async () => {
    const section = await presentation();
    expect(section).toContain("cli-owned");
    expect(section).toMatch(/the only place ownership changes/);
  });
});

describe("el vocabulario de fronteras no se bifurca entre código y doctrina", () => {
  it("toda frontera que el protocolo declara es presentable, y ninguna sobra", async () => {
    const table = await rows();
    const documented = [...table.keys()].sort();
    expect(documented).toEqual([...FLOW_BOUNDARY_KINDS].sort());
  });

  it("la frontera legacy es la única que manda a leer un documento", async () => {
    const table = await rows();
    const legacy = table.get("legacy" satisfies FlowBoundaryKind) ?? "";
    expect(legacy).toContain("boundary.document");
    for (const [kind, cells] of table) {
      if (kind === "legacy") continue;
      expect(cells, kind).not.toContain("boundary.document");
    }
  });
});
