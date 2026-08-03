import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  loadDescriptor,
  readSkillHead,
} from "../../src/application/capability/descriptor-loader.js";
import { buildCapabilityInventory } from "../../src/application/capability/installed-inventory.js";
import type { CapabilityInventory } from "../../src/application/capability/installed-inventory.js";
import {
  checkPin,
  pinSelection,
  resolveCapability,
} from "../../src/application/capability/resolution.js";
import {
  CAPABILITY_DESCRIPTOR_METADATA_KEY,
  type CapabilityDescriptor,
} from "../../src/domain/capability/descriptor.js";
import { DESIGN_DESCRIPTOR } from "../../src/domain/design/capability.js";
import { classifyCapabilityBinding } from "../../src/domain/skills.js";
import type { ResolvedSkill } from "../../src/domain/skills.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/** An improvement descriptor that legitimately claims to improve `design`. */
function improvement(over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    contract_version: 1,
    name: "acme-design-lab",
    purpose: "mejora la autoría de packages de diseño",
    exposure: ["compose"],
    default_operation: null,
    operations: [
      {
        name: "create",
        summary: "autoría asistida",
        exposure: ["compose"],
        workspace: "required",
        interaction: "single_pass",
        inputs: [],
        output: { kind: "value", schema: null, completeness: ["complete"] },
        effects: [
          { class: "read_only", idempotent: true, authorization: "invocation", approval: "none" },
        ],
        off: "blocked",
      },
    ],
    floor: { builtin: false, kind: "feature", improvements: "none" },
    degradations: [],
    compatibility: {
      status: "active",
      minimum_contract_version: 1,
      improves: { capability: "design", operations: ["create"], contract_version: 1 },
      retired_names: [],
      retired_formats: [],
    },
    ...over,
  };
}

function skillMd(name: string, locator: string): string {
  return `---\nname: ${name}\ndescription: fixture\nmetadata:\n  version: 1.0.0\n  ${CAPABILITY_DESCRIPTOR_METADATA_KEY}: "${locator}"\n---\n\ncuerpo\n`;
}

function seal(descriptor: CapabilityDescriptor): { bytes: string; digest: string } {
  const bytes = JSON.stringify(descriptor);
  return { bytes, digest: createHash("sha256").update(bytes, "utf8").digest("hex") };
}

const ROOT = "/home/u/.claude/skills";

/** Install one capability skill into a MemFs at `root/<dir>`. */
function install(
  fs: MemFs,
  root: string,
  dir: string,
  name: string,
  descriptor: CapabilityDescriptor,
): MemFs {
  const { bytes, digest } = seal(descriptor);
  return fs
    .file(join(root, dir, "SKILL.md"), skillMd(name, `workline-capability.json#sha256=${digest}`))
    .file(join(root, dir, "workline-capability.json"), bytes);
}

const env = new FakeEnv("/home/u", "/work");

async function inventoryOf(fs: MemFs): Promise<CapabilityInventory> {
  return buildCapabilityInventory(fs, env);
}

const bound = (skill: string | null): ResolvedSkill => ({
  role: "design",
  skill,
  source: "workspace",
  enabled: skill !== null,
});

describe("el inventario identifica instancias exactas", () => {
  it("una instalación conformante entra con nombre, scope, locators, versión y digest", async () => {
    const fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    const inventory = await inventoryOf(fs);
    expect(inventory.capabilities).toHaveLength(1);
    const instance = inventory.capabilities[0];
    expect(instance?.name).toBe("acme-design-lab");
    expect(instance?.state).toBe("ready");
    expect(instance?.version).toBe("1.0.0");
    expect(instance?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(instance?.locations[0]?.scope).toBe(ROOT);
    expect(instance?.locations[0]?.descriptorPath).toBe("workline-capability.json");
  });

  it("una skill sin descriptor no entra: instalarla no la vuelve capacidad", async () => {
    const fs = new MemFs().file(
      join(ROOT, "some-linter", "SKILL.md"),
      "---\nname: some-linter\ndescription: ambiental\n---\n\ncuerpo\n",
    );
    expect((await inventoryOf(fs)).capabilities).toEqual([]);
  });

  it("réplicas de igual digest en dos raíces conservan cada locator", async () => {
    const other = "/work/.claude/skills";
    let fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    fs = install(fs, other, "acme-design-lab", "acme-design-lab", improvement());
    const inventory = await inventoryOf(fs);
    const instance = inventory.capabilities[0];
    expect(instance?.state).toBe("ready");
    expect(instance?.locations.map((l) => l.scope).sort()).toEqual([other, ROOT].sort());
  });

  it("el mismo nombre con bytes distintos es misconfigured, no una precedencia a resolver", async () => {
    const other = "/work/.claude/skills";
    let fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    fs = install(fs, other, "acme-design-lab", "acme-design-lab", improvement({ purpose: "otra" }));
    const instance = (await inventoryOf(fs)).capabilities[0];
    expect(instance?.state).toBe("misconfigured");
    expect(instance?.digest).toBeNull();
    expect(instance?.failure?.code).toBe("CAPABILITY_INSTANCE_COLLISION");
  });

  it("un digest que no corresponde a los bytes deja la instancia misconfigured", async () => {
    const fs = new MemFs()
      .file(
        join(ROOT, "acme-design-lab", "SKILL.md"),
        skillMd("acme-design-lab", `workline-capability.json#sha256=${"0".repeat(64)}`),
      )
      .file(join(ROOT, "acme-design-lab", "workline-capability.json"), seal(improvement()).bytes);
    const instance = (await inventoryOf(fs)).capabilities[0];
    expect(instance?.state).toBe("misconfigured");
    expect(instance?.failure?.code).toBe("CAPABILITY_DESCRIPTOR_DIGEST_MISMATCH");
  });

  it("un descriptor que es un symlink no se lee: la ruta confinada no basta", async () => {
    const base = mkdtempSync(join(tmpdir(), "aw-cap-"));
    try {
      const outside = join(base, "outside.json");
      writeFileSync(outside, seal(improvement()).bytes);
      const skillDir = join(base, "skills", "acme-design-lab");
      mkdirSync(skillDir, { recursive: true });
      const { digest } = seal(improvement());
      writeFileSync(
        join(skillDir, "SKILL.md"),
        skillMd("acme-design-lab", `workline-capability.json#sha256=${digest}`),
      );
      symlinkSync(outside, join(skillDir, "workline-capability.json"));

      const realFs = new NodeFileSystem();
      const head = await readSkillHead(realFs, skillDir, "acme-design-lab");
      expect(head).not.toBeNull();
      const load = await loadDescriptor(realFs, skillDir, head as NonNullable<typeof head>);
      expect(load.state).toBe("invalid");
      if (load.state !== "invalid") return;
      expect(load.failure.code).toBe("CAPABILITY_DESCRIPTOR_NOT_CONFINED");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("el binding de una capacidad con floor es cerrado y exhaustivo", () => {
  it("sin declarar resuelve al nombre canónico y habilita floor + mejoras", () => {
    const unset: ResolvedSkill = {
      role: "design",
      skill: "design",
      source: "default",
      enabled: true,
    };
    expect(classifyCapabilityBinding(unset, "design").state).toBe("floor_and_improvements");
  });

  it("el nombre canónico explícito es lo mismo", () => {
    expect(classifyCapabilityBinding(bound("design"), "design").state).toBe(
      "floor_and_improvements",
    );
  });

  it("off es off", () => {
    expect(classifyCapabilityBinding(bound(null), "design").state).toBe("off");
  });

  it("cualquier reemplazo queda misconfigured con acción, y no se reescribe el archivo", () => {
    const policy = classifyCapabilityBinding(bound("acme-design-lab"), "design");
    expect(policy.state).toBe("misconfigured");
    expect(policy.action).toContain("design");
    expect(policy.reason).toContain("acme-design-lab");
  });
});

describe("la resolución entrega floor o una selección verificada", () => {
  const emptyInventory: CapabilityInventory = { roots: [], capabilities: [] };
  const canonical = classifyCapabilityBinding(bound("design"), "design");

  it("sin mejora instalada corre el floor y eso es 'ready', no una degradación", () => {
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory: emptyInventory,
    });
    expect(r.state).toBe("ready");
    expect(r.floor).toBe(true);
    expect(r.degradations).toEqual([]);
    expect(r.selection).toEqual([]);
  });

  it("una selección verificable queda fijada por instancia, orden y digest", async () => {
    const fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    const inventory = await inventoryOf(fs);
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory,
      hostSelection: { contributors: [{ name: "acme-design-lab", order: 1 }] },
      operation: "create",
    });
    expect(r.state).toBe("ready");
    expect(r.floor).toBe(false);
    expect(r.selection).toHaveLength(1);
    expect(r.selection[0]?.digest).toBe(inventory.capabilities[0]?.digest);
    expect(r.selection[0]?.order).toBe(1);

    const pin = pinSelection(r, DESIGN_DESCRIPTOR);
    expect(checkPin(pin, inventory)).toEqual({ ok: true });
  });

  it("una selección name-only entre dos raíces queda opaca y corre el floor sin atribuir", async () => {
    const other = "/work/.claude/skills";
    let fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    fs = install(fs, other, "acme-design-lab", "acme-design-lab", improvement());
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory: await inventoryOf(fs),
      hostSelection: { contributors: [{ name: "acme-design-lab", order: 1 }] },
      operation: "create",
    });
    expect(r.state).toBe("degraded");
    expect(r.floor).toBe(true);
    expect(r.selection, "no se atribuye lo que no se pudo identificar").toEqual([]);
    expect(r.degradations[0]?.cause).toBe("opaque_selection");
    expect(r.degradations[0]?.loss.length).toBeGreaterThan(0);
  });

  it("nombrando el locator, la misma réplica sí se identifica", async () => {
    const other = "/work/.claude/skills";
    let fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    fs = install(fs, other, "acme-design-lab", "acme-design-lab", improvement());
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory: await inventoryOf(fs),
      hostSelection: {
        contributors: [
          { name: "acme-design-lab", order: 1, locator: join(other, "acme-design-lab") },
        ],
      },
      operation: "create",
    });
    expect(r.state).toBe("ready");
    expect(r.selection[0]?.locator).toBe(join(other, "acme-design-lab"));
  });

  it("un contribuyente que el host nombra y no está instalado es opaco", async () => {
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory: emptyInventory,
      hostSelection: { contributors: [{ name: "fantasma", order: 1 }] },
    });
    expect(r.state).toBe("degraded");
    expect(r.degradations[0]?.cause).toBe("opaque_selection");
  });

  it("un digest declarado que ya no coincide degrada por cambio de bytes", async () => {
    const fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory: await inventoryOf(fs),
      hostSelection: {
        contributors: [{ name: "acme-design-lab", order: 1, digest: "f".repeat(64) }],
      },
    });
    expect(r.degradations[0]?.cause).toBe("digest_changed");
    expect(r.floor).toBe(true);
  });

  it("un pin deja de valer cuando la instancia cambia entre attempts", async () => {
    const fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", improvement());
    const inventory = await inventoryOf(fs);
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory,
      hostSelection: { contributors: [{ name: "acme-design-lab", order: 1 }] },
      operation: "create",
    });
    const pin = pinSelection(r, DESIGN_DESCRIPTOR);

    const updated = install(
      new MemFs(),
      ROOT,
      "acme-design-lab",
      "acme-design-lab",
      improvement({ purpose: "otra cosa" }),
    );
    const check = checkPin(pin, await inventoryOf(updated));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.degradation.cause).toBe("digest_changed");
  });

  it.each([
    [
      "no declara mejorar nada",
      improvement({ compatibility: { ...improvement().compatibility, improves: null } }),
    ],
    [
      "mejora otra capacidad",
      improvement({
        compatibility: {
          ...improvement().compatibility,
          improves: { capability: "diagrams", operations: ["create"], contract_version: 1 },
        },
      }),
    ],
    [
      "no mejora la operación invocada",
      improvement({
        compatibility: {
          ...improvement().compatibility,
          improves: { capability: "design", operations: ["render"], contract_version: 1 },
        },
      }),
    ],
  ])("una mejora que %s se rechaza ANTES de contribuir y corre el floor", async (_case, desc) => {
    const fs = install(new MemFs(), ROOT, "acme-design-lab", "acme-design-lab", desc);
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: canonical,
      inventory: await inventoryOf(fs),
      hostSelection: { contributors: [{ name: "acme-design-lab", order: 1 }] },
      operation: "create",
    });
    expect(r.degradations[0]?.cause).toBe("incompatible_improvement");
    expect(r.selection).toEqual([]);
    expect(r.floor).toBe(true);
  });

  it("un binding de reemplazo es misconfigured y cae al floor por ser seguro", () => {
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: classifyCapabilityBinding(bound("acme-design-lab"), "design"),
      inventory: emptyInventory,
    });
    expect(r.state).toBe("degraded");
    expect(r.floor).toBe(true);
    expect(r.degradations[0]?.cause).toBe("invalid_binding");
  });
});

describe("off e indisponibilidad se aíslan", () => {
  it("off bloquea create/update/render/record y conserva validate", () => {
    const r = resolveCapability({
      descriptor: DESIGN_DESCRIPTOR,
      binding: classifyCapabilityBinding(bound(null), "design"),
      inventory: { roots: [], capabilities: [] },
    });
    expect(r.state).toBe("disabled");
    const blocked = r.operations.filter((o) => !o.available).map((o) => o.operation);
    expect(blocked.sort()).toEqual(["create", "record", "render", "update"]);
    expect(r.operations.find((o) => o.operation === "validate")?.available).toBe(true);
    // Y sigue habiendo algo que implemente `validate`: consumo conservado.
    expect(r.floor).toBe(true);
  });

  it("una capacidad feature-only sin floor queda unavailable y bloquea solo lo suyo", () => {
    const featureOnly = improvement({
      name: "acme-lab",
      exposure: ["compose"],
      compatibility: { ...improvement().compatibility, improves: null },
    });
    const r = resolveCapability({
      descriptor: featureOnly,
      binding: classifyCapabilityBinding(
        { role: "design", skill: "acme-lab", source: "default", enabled: true },
        "acme-lab",
      ),
      inventory: { roots: [], capabilities: [] },
    });
    expect(r.state).toBe("unavailable");
    expect(r.operations.every((o) => !o.available)).toBe(true);
    // El bloqueo se confina a SUS operaciones: no aparece ninguna de design.
    expect(r.operations.map((o) => o.operation)).toEqual(["create"]);
  });
});
