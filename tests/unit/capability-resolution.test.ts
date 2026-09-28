import { describe, expect, it } from "vitest";
import {
  type HostSelection,
  checkPin,
  pinSelection,
  resolveCapability,
} from "../../src/application/capability/resolution.js";
import { DESIGN_DESCRIPTOR } from "../../src/domain/design/capability.js";
import { classifyCapabilityBinding } from "../../src/domain/skills.js";
import type { ResolvedSkill } from "../../src/domain/skills.js";

const binding = (skill: string | null): ReturnType<typeof classifyCapabilityBinding> =>
  classifyCapabilityBinding(
    { role: "design", skill, source: "workspace", enabled: skill !== null } as ResolvedSkill,
    "design",
  );

const selected = (): HostSelection => ({
  token: "selección-del-host-1",
  contributors: [
    {
      name: "ayuda-host-native",
      order: 1,
      digest: "a".repeat(64),
      metadata_source: "host",
      improves: { capability: "design", operations: ["create"], contract_version: 1 },
    },
  ],
});

function contributor() {
  const first = selected().contributors[0];
  if (!first) throw new Error("la fixture necesita un contribuyente");
  return first;
}

function resolve(hostSelection?: HostSelection) {
  return resolveCapability({
    descriptor: DESIGN_DESCRIPTOR,
    binding: binding("design"),
    operation: "create",
    ...(hostSelection === undefined ? {} : { hostSelection }),
  });
}

describe("atribución provisional, sin inventario", () => {
  it("sin ayuda corre el floor y sus operaciones están disponibles", () => {
    const result = resolve();
    expect(result.state).toBe("ready");
    expect(result.floor).toBe(true);
    expect(result.selection).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("la metadata compatible nombra candidatos, sin darles crédito antes del output", () => {
    const result = resolve(selected());
    expect(result.floor).toBe(true);
    expect(result.selection).toEqual([]);
    expect(result.candidates).toMatchObject([
      { name: "ayuda-host-native", order: 1, digest: "a".repeat(64) },
    ]);
    const pin = pinSelection(result, DESIGN_DESCRIPTOR, selected());
    expect(checkPin(pin, selected())).toEqual({ ok: true });
    expect(checkPin(pin, { ...selected(), token: "otro intento" }).ok).toBe(false);
    expect(checkPin(pin, null).ok).toBe(false);
  });

  it.each([
    ["duplicado", { ...selected(), contributors: [contributor(), contributor()] }],
    ["orden variable", { ...selected(), contributors: [{ ...contributor(), order: 2 }] }],
    [
      "versión distinta",
      {
        ...selected(),
        contributors: [
          {
            ...contributor(),
            improves: { capability: "design", operations: ["create"], contract_version: 9 },
          },
        ],
      },
    ],
    [
      "operación ajena",
      {
        ...selected(),
        contributors: [
          {
            ...contributor(),
            improves: { capability: "design", operations: ["render"], contract_version: 1 },
          },
        ],
      },
    ],
  ] as const)("%s degrada sin atribución", (_name, selection) => {
    const result = resolve(selection as HostSelection);
    expect(result.state).toBe("degraded");
    expect(result.floor).toBe(true);
    expect(result.selection).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("un host opaco sin digest no resulta identificable aunque anuncie una skill", () => {
    const candidate = selected();
    const first = candidate.contributors[0];
    if (!first) throw new Error("la fixture necesita un contribuyente");
    first.digest = "";
    expect(resolve(candidate).degradations[0]?.cause).toBe("opaque_selection");
  });
});

it("off preserva validate y bloquea autoría, incluso con ayuda declarada", () => {
  const result = resolveCapability({
    descriptor: DESIGN_DESCRIPTOR,
    binding: binding(null),
    operation: "create",
    hostSelection: selected(),
  });
  expect(result.state).toBe("disabled");
  expect(result.candidates).toEqual([]);
  expect(
    result.operations
      .filter((op) => !op.available)
      .map((op) => op.operation)
      .sort(),
  ).toEqual(["create", "record", "render", "update"]);
  expect(result.operations.find((op) => op.operation === "validate")?.available).toBe(true);
});
