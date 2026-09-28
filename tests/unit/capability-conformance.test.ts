import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import { composeCapability } from "../../src/application/capability/compose.js";
import type { WorklineFlow } from "../../src/application/capability/compose.js";
import type { DispatchContext } from "../../src/application/capability/dispatcher.js";
import { dispatchCapability } from "../../src/application/capability/dispatcher.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import { DESIGN_DESCRIPTOR, DESIGN_OPERATIONS } from "../../src/domain/design/capability.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The v1 conformance matrix — explicit, and deliberately NOT a cartesian
 * product.
 *
 * Five operations at least once, two routes over at least one operation, and
 * the three resolutions. Multiplying them out would produce sixty cases that
 * prove the same three things sixty times; what the contract asks for is that
 * nothing is left unexercised, not that everything is exercised together.
 *
 * None of it depends on a second skill or on C4: the improvement cases run
 * against a fixture descriptor, which is what "conformance without a second
 * skill" means.
 */

const HOME = "/home/u";
const WORKSPACE = "/work";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function context(fs: MemFs = new MemFs()): DispatchContext {
  return {
    fs,
    env: new FakeEnv(HOME, WORKSPACE),
    paths: new PathsService(normalizeNamespace("workflow"), HOME, WORKSPACE),
    workspace: WORKSPACE,
    host: "claude-code",
  };
}

const text = (name: string, value: string): CapabilityInputValue => ({
  name,
  value,
  provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
});

/** The minimum inputs each operation declares as required. */
const REQUIRED: Record<string, CapabilityInputValue[]> = {
  create: [text("title", "Alta"), text("sources", "docs/specs"), text("target", "docs/designs")],
  update: [text("package", "DES-001"), text("base", "DES-001@r1")],
  validate: [text("package", "DES-001")],
  render: [text("package", "DES-001"), text("profile", "portable-html")],
  record: [text("package", "DES-001"), text("revision", "r1"), text("decision", "approved")],
};

describe("C1 · las cinco operaciones se ejercen al menos una vez", () => {
  it.each([...DESIGN_OPERATIONS])("'%s' entra al dispatcher y devuelve receipt", async (op) => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: op,
        route: "direct",
        target: "docs/designs",
        inputs: REQUIRED[op] as CapabilityInputValue[],
      },
      context(),
    );
    expect(result.ok, op).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.operation).toBe(op);
    expect(result.attempt.receipt.next_action.length).toBeGreaterThan(0);
    // Ningún intento vuelve sin correlación con su request.
    expect(result.attempt.receipt.request_digest).toBe(result.attempt.request.request_digest);
  });

  it("y el catálogo son exactamente cinco, sin una sexta improvisada", () => {
    expect([...DESIGN_OPERATIONS]).toHaveLength(5);
    expect(DESIGN_DESCRIPTOR.operations.map((o) => o.name)).toEqual([...DESIGN_OPERATIONS]);
  });
});

describe("C2 · una operación por las dos rutas, con el mismo contrato", () => {
  const inputs = REQUIRED.validate as CapabilityInputValue[];

  it("directo y compuesto comparten builder, digest semántico, output y forma de receipt", async () => {
    const ctx = context();
    const direct = await dispatchCapability(
      { verb: "prepare", capability: "design", operation: "validate", route: "direct", inputs },
      ctx,
    );
    const composed = await composeCapability(
      {
        verb: "prepare",
        flow: "plan-exec" as WorklineFlow,
        capability: "design",
        operation: "validate",
        inputs,
      },
      ctx,
    );
    expect(direct.ok && composed.ok).toBe(true);
    if (!direct.ok || !composed.ok) return;

    // Invariantes: iguales.
    expect(composed.attempt.request.semantic_inputs_digest).toBe(
      direct.attempt.request.semantic_inputs_digest,
    );
    expect(composed.attempt.request.capability).toBe(direct.attempt.request.capability);
    expect(composed.attempt.request.operation).toBe(direct.attempt.request.operation);
    expect(composed.attempt.request.contract_version).toBe(direct.attempt.request.contract_version);
    expect(composed.attempt.receipt.outcome).toBe(direct.attempt.receipt.outcome);
    expect(composed.attempt.output).toEqual(direct.attempt.output);
    expect(Object.keys(composed.attempt.receipt).sort()).toEqual(
      Object.keys(direct.attempt.receipt).sort(),
    );

    // Campos de ruta/caller: distintos por contrato, no por accidente.
    expect(composed.attempt.request.caller.route).toBe("compose");
    expect(direct.attempt.request.caller.route).toBe("direct");
    expect(composed.attempt.request.request_digest).not.toBe(direct.attempt.request.request_digest);
  });
});

describe("C3 · selección pre-efecto por intento, floor y degradación", () => {
  const selection = {
    token: "host-selection-1",
    contributors: [
      {
        name: "ayuda-host-native",
        order: 1,
        digest: "a".repeat(64),
        metadata_source: "host" as const,
        improves: { capability: "design", operations: ["create"], contract_version: 1 },
      },
    ],
  };

  it("floor: sin nada instalado corre el incorporado y el receipt no atribuye a nadie", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "validate",
        route: "direct",
        inputs: REQUIRED.validate as CapabilityInputValue[],
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.floor).toBe(true);
    expect(result.attempt.receipt.selection).toEqual([]);
    expect(result.attempt.receipt.degradations).toEqual([]);
  });

  it("el host fija un candidato antes del contenido sin acreditarlo por metadata sola", async () => {
    const ctx = context();
    const first = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        target: "docs/designs",
        inputs: REQUIRED.create as CapabilityInputValue[],
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const next = await dispatchCapability(
      {
        verb: "continue",
        capability: "design",
        route: "direct",
        operation: "create",
        target: "docs/designs",
        inputs: REQUIRED.create as CapabilityInputValue[],
        parent: first.attempt.request,
        hostSelection: selection,
      },
      ctx,
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.attempt.receipt.selection).toEqual([]);
    expect(next.attempt.pin.instances).toMatchObject([{ name: "ayuda-host-native", order: 1 }]);
  });

  it("selección opaca degrada antes de contribuir incluso con un directorio externo instalado", async () => {
    const first = selection.contributors[0];
    if (!first) throw new Error("la fixture necesita un contribuyente");
    const fs = new MemFs().file(
      join(HOME, ".claude/skills/ayuda-host-native/SKILL.md"),
      "external",
    );
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "validate",
        route: "direct",
        inputs: REQUIRED.validate as CapabilityInputValue[],
        hostSelection: {
          ...selection,
          contributors: [{ ...first, order: 2 }],
        },
      },
      context(fs),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.floor).toBe(true);
    expect(result.attempt.receipt.selection).toEqual([]);
    expect(result.attempt.receipt.degradations[0]?.cause).toBe("opaque_selection");
    expect(result.attempt.receipt.degradations[0]?.loss.length).toBeGreaterThan(0);
  });

  it("un cambio de selección entre intento previo y siguiente impide crédito", async () => {
    const ctx = context();
    const first = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        target: "docs/designs",
        inputs: REQUIRED.create as CapabilityInputValue[],
      },
      ctx,
    );
    if (!first.ok) throw new Error("prepare falló");
    const preselected = await dispatchCapability(
      {
        verb: "continue",
        capability: "design",
        operation: "create",
        route: "direct",
        target: "docs/designs",
        inputs: REQUIRED.create as CapabilityInputValue[],
        parent: first.attempt.request,
        hostSelection: selection,
      },
      ctx,
    );
    if (!preselected.ok) throw new Error("continue falló");
    expect(preselected.attempt.pin.instances).toHaveLength(1);
    const changed = await dispatchCapability(
      {
        verb: "continue",
        capability: "design",
        operation: "create",
        route: "direct",
        target: "docs/designs",
        inputs: REQUIRED.create as CapabilityInputValue[],
        parent: preselected.attempt.request,
        pin: preselected.attempt.pin,
        hostSelection: { ...selection, token: "host-selection-2" },
      },
      ctx,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.attempt.receipt.outcome).toBe("blocked");
    expect(changed.attempt.receipt.error?.code).toBe("CAPABILITY_SELECTION_CHANGED");
  });
});

describe("C4 · el modelo impide ramas por nombre de capacidad", () => {
  function sources(dir: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (path.endsWith(".ts"))
        out.push([path.slice(repoRoot.length), readFileSync(path, "utf8")]);
    }
    return out;
  }

  // Una comparación contra el nombre literal de una capacidad dentro de un flow
  // es exactamente lo que haría que incorporar otra exigiera tocar los flows.
  it("ningún módulo compara contra el literal 'design' para decidir un camino", () => {
    const offenders: string[] = [];
    for (const [path, code] of sources(join(repoRoot, "src"))) {
      if (path.includes("domain/design/") || path.includes("application/design/")) continue;
      if (/(?:if|\?|&&|\|\|)\s*\(?[^\n]*[=!]==\s*["']design["']/.test(code)) {
        offenders.push(path);
      }
    }
    expect(offenders, "ramas por nombre de capacidad").toEqual([]);
  });

  it("el mapa de composición es DATO, no código: sumar una capacidad agrega filas", () => {
    const code = readFileSync(join(repoRoot, "src/application/capability/compose.ts"), "utf8");
    expect(code).toContain(
      "COMPOSED_OPERATIONS: Readonly<Record<WorklineFlow, readonly string[]>>",
    );
    // El adaptador consulta la tabla; no ramifica por capacidad.
    expect(code).not.toMatch(/if\s*\([^)]*capability\s*===\s*["']design["']/);
  });

  it("los handlers viven en un registro por nombre, no en un switch", () => {
    const code = readFileSync(join(repoRoot, "src/application/capability/dispatcher.ts"), "utf8");
    expect(code).toContain("HANDLERS.get(name)");
    expect(code).not.toMatch(/switch\s*\(\s*\w*capability/);
  });
});

/**
 * C5 · The caller sweep, as a standing list.
 *
 * Everything this plan added has a production caller EXCEPT the entries below,
 * and each of them is a normative interface the spec requires whose producer
 * does not exist yet in this process model. They are enumerated here — not
 * hidden — each with the conformance caller that exercises it and the
 * production fallback that covers the same ground today.
 */
describe("C5 · barrido de llamadores: nada interno queda sin caller ni sin explicación", () => {
  const NORMATIVE_WITHOUT_HOST_PRODUCER = [
    {
      symbol: "AttemptLedger",
      module: "src/domain/capability/protocol.ts",
      why: "distingue retry idempotente de divergencia dentro de UNA sesión viva; el CLI es un proceso por invocación, así que hoy ningún host lo alimenta",
      conformanceCaller: "tests/unit/capability-protocol.test.ts",
      productionFallback:
        "la cadena parent_request_digest: continueInvocation re-sella el padre y el dispatcher rechaza un padre alterado o no inmediato",
    },
    {
      symbol: "baseDigest",
      // Se mudó con el sello: la propuesta local es de las dos superficies —la
      // capacidad y el motor de flujos— así que su digest de base vive donde
      // ambas lo alcanzan, no dentro del adaptador de una de ellas.
      module: "src/domain/proposal.ts",
      why: "sella la base de compare-and-swap; el floor de design todavía no resuelve una base a ruta (payload del plan 013)",
      conformanceCaller: "tests/unit/capability-effects.test.ts",
      productionFallback:
        "checkBases la usa al aplicar, y el guardado de spec/plan ya sella la base del documento que sobrescribe",
    },
  ] as const;

  it("cada interfaz normativa sin productor host está enumerada con caller y fallback", () => {
    for (const entry of NORMATIVE_WITHOUT_HOST_PRODUCER) {
      const code = readFileSync(join(repoRoot, entry.module), "utf8");
      expect(code, entry.symbol).toContain(entry.symbol);
      expect(entry.conformanceCaller.length).toBeGreaterThan(0);
      expect(entry.productionFallback.length).toBeGreaterThan(0);
      // El caller de conformidad existe de verdad.
      expect(readFileSync(join(repoRoot, entry.conformanceCaller), "utf8")).toContain(entry.symbol);
    }
  });

  it("y la lista es corta a propósito: dos entradas, no un cajón de sastre", () => {
    expect(NORMATIVE_WITHOUT_HOST_PRODUCER.length).toBeLessThanOrEqual(3);
  });

  // Lo que SÍ se cableó durante el barrido, probado por su camino de producción.
  it("el adaptador compuesto es el que el CLI usa cuando llega --flow", () => {
    const cli = readFileSync(join(repoRoot, "src/cli/commands/capability.ts"), "utf8");
    expect(cli).toContain("composeCapability(");
    expect(cli).toContain("isWorklineFlow");
  });

  it("el pin y la persistencia viajan en cada intento", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "validate",
        route: "direct",
        inputs: REQUIRED.validate as CapabilityInputValue[],
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.pin.capability).toBe("design");
    expect(result.attempt.persistence).toBe("none");
  });
});
