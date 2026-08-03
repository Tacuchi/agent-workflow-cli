import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import {
  type DispatchContext,
  dispatchCapability,
  registeredCapabilities,
} from "../../src/application/capability/dispatcher.js";
import {
  CAPABILITY_SKILL_MARKER,
  descriptorLocatorValue,
  inspectCapabilityDir,
  installCapabilitySkill,
  renderCapabilitySkill,
  uninstallCapabilitySkill,
} from "../../src/application/capability/wrapper.js";
import { PathsService } from "../../src/application/paths-service.js";
import { CAPABILITY_DESCRIPTOR_METADATA_KEY } from "../../src/domain/capability/descriptor.js";
import { validateCapabilityDescriptor } from "../../src/domain/capability/descriptor.js";
import { DESIGN_DESCRIPTOR } from "../../src/domain/design/capability.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import { parseSkillFrontmatter } from "../../src/domain/skill-frontmatter.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const WORKSPACE = "/work";

function context(fs: MemFs = new MemFs()): DispatchContext {
  return {
    fs,
    env: new FakeEnv("/home/u", WORKSPACE),
    paths: new PathsService(normalizeNamespace("workflow"), "/home/u", WORKSPACE),
    workspace: WORKSPACE,
    host: "claude-code",
  };
}

describe("el dispatcher es la única puerta y las dos rutas la comparten", () => {
  it("design está registrada", () => {
    expect(registeredCapabilities()).toContain("design");
  });

  it("un nombre retirado falla con la acción para adoptar el vigente, sin fallback", async () => {
    for (const name of ["ui-design", "ui-spec"]) {
      const result = await dispatchCapability(
        { verb: "prepare", capability: name, operation: "validate", route: "direct" },
        context(),
      );
      expect(result.ok, name).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("CAPABILITY_NAME_RETIRED");
      expect(result.failure.action).toContain("design");
    }
  });

  it("una capacidad que nadie registró no se improvisa", async () => {
    const result = await dispatchCapability(
      { verb: "prepare", capability: "c4", operation: "create", route: "direct" },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("CAPABILITY_UNKNOWN");
  });

  it("una operación fuera del catálogo se rechaza", async () => {
    const result = await dispatchCapability(
      { verb: "prepare", capability: "design", operation: "consume", route: "direct" },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("CAPABILITY_OPERATION_UNKNOWN");
  });

  it("directo y compuesto piden el mismo trabajo: mismo digest semántico, distinto sobre", async () => {
    const inputs = [
      {
        name: "package",
        value: "DES-001",
        provenance: {
          kind: "reference" as const,
          origin: "docs/designs",
          seal: null,
          sensitivity: "public" as const,
        },
      },
    ];
    const direct = await dispatchCapability(
      { verb: "prepare", capability: "design", operation: "validate", route: "direct", inputs },
      context(),
    );
    const composed = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "validate",
        route: "compose",
        flow: "spec-refine",
        inputs,
      },
      context(),
    );
    expect(direct.ok && composed.ok).toBe(true);
    if (!direct.ok || !composed.ok) return;
    expect(composed.attempt.request.semantic_inputs_digest).toBe(
      direct.attempt.request.semantic_inputs_digest,
    );
    expect(composed.attempt.request.request_digest).not.toBe(direct.attempt.request.request_digest);
    expect(composed.attempt.request.caller.flow).toBe("spec-refine");
    expect(direct.attempt.request.caller.flow).toBeNull();
  });
});

describe("la ruta directa conversa y no toca ningún flow", () => {
  it("design.create devuelve envelope, receipt y needs_input sin escribir nada", async () => {
    const fs = new MemFs();
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        target: "docs/designs",
        inputs: ["title", "sources", "target"].map((name) => ({
          name,
          value: "x",
          provenance: {
            kind: "text" as const,
            origin: "caller",
            seal: null,
            sensitivity: "public" as const,
          },
        })),
      },
      context(fs),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("needs_input");
    expect(result.attempt.receipt.gaps.length).toBeGreaterThan(0);
    expect(result.attempt.request.attempt).toBe(1);
    // Ni sesión, ni documento, ni `.workflow/`: la ruta directa no abre un flow.
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("needs_input → continue enlaza dos intentos del mismo invocation_id", async () => {
    const ctx = context();
    const inputs = ["title", "sources", "target"].map((name) => ({
      name,
      value: "x",
      provenance: {
        kind: "text" as const,
        origin: "caller",
        seal: null,
        sensitivity: "public" as const,
      },
    }));
    const first = await dispatchCapability(
      { verb: "prepare", capability: "design", operation: "create", route: "direct", inputs },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await dispatchCapability(
      {
        verb: "continue",
        capability: "design",
        route: "direct",
        inputs: [
          ...inputs,
          {
            name: "profile",
            value: "portable-html",
            provenance: {
              kind: "selection" as const,
              origin: "respuesta",
              seal: null,
              sensitivity: "public" as const,
            },
          },
        ],
        parent: first.attempt.request,
      },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.attempt.request.invocation_id).toBe(first.attempt.request.invocation_id);
    expect(second.attempt.request.attempt).toBe(2);
    expect(second.attempt.receipt.parent_request_digest).toBe(first.attempt.request.request_digest);
  });

  it("un padre alterado no continúa nada", async () => {
    const ctx = context();
    const first = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "validate",
        route: "direct",
        inputs: [
          {
            name: "package",
            value: "DES-001",
            provenance: {
              kind: "reference" as const,
              origin: "docs/designs",
              seal: null,
              sensitivity: "public" as const,
            },
          },
        ],
      },
      ctx,
    );
    if (!first.ok) throw new Error("prepare falló");
    const tampered = { ...first.attempt.request, operation: "create" };
    const second = await dispatchCapability(
      { verb: "continue", capability: "design", route: "direct", parent: tampered },
      ctx,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.code).toBe("CAPABILITY_PARENT_ALTERED");
  });
});

describe("el entrypoint físico se instala, se reinstala y se retira", () => {
  function tempRoot(): string {
    return mkdtempSync(join(tmpdir(), "aw-wrapper-"));
  }

  it("el wrapper generado es una Agent Skill válida que localiza su descriptor", () => {
    const text = renderCapabilitySkill(DESIGN_DESCRIPTOR);
    const fm = parseSkillFrontmatter(text);
    expect(fm?.fields.name).toBe("design");
    expect(fm?.metadata[CAPABILITY_DESCRIPTOR_METADATA_KEY]).toBe(
      descriptorLocatorValue(DESIGN_DESCRIPTOR),
    );
    expect(text).toContain(CAPABILITY_SKILL_MARKER);
    // Llama al dispatcher compartido; no re-describe el contrato.
    expect(text).toContain("aw capability prepare");
    expect(text).not.toContain("off:");
  });

  it("install escribe el par y el descriptor publicado valida", async () => {
    const root = tempRoot();
    try {
      const out = await installCapabilitySkill(root, DESIGN_DESCRIPTOR);
      expect(out.ok).toBe(true);
      expect(readdirSync(join(root, "design")).sort()).toEqual([
        "SKILL.md",
        "workline-capability.json",
      ]);
      const published = JSON.parse(
        readFileSync(join(root, "design", "workline-capability.json"), "utf8"),
      );
      expect(validateCapabilityDescriptor(published).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reinstalar es idempotente en contenido", async () => {
    const root = tempRoot();
    try {
      await installCapabilitySkill(root, DESIGN_DESCRIPTOR);
      const before = readFileSync(join(root, "design", "SKILL.md"), "utf8");
      await installCapabilitySkill(root, DESIGN_DESCRIPTOR);
      expect(readFileSync(join(root, "design", "SKILL.md"), "utf8")).toBe(before);
      expect((await inspectCapabilityDir(join(root, "design"))).state).toBe("ours");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uninstall es simétrico y no deja nada", async () => {
    const root = tempRoot();
    try {
      await installCapabilitySkill(root, DESIGN_DESCRIPTOR);
      const out = await uninstallCapabilitySkill(root, "design");
      expect(out).toMatchObject({ ok: true, removed: true });
      expect(readdirSync(root)).toEqual([]);
      // Y retirar dos veces no es un error: no había nada que retirar.
      expect(await uninstallCapabilitySkill(root, "design")).toMatchObject({
        ok: true,
        removed: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("una skill extranjera con el mismo nombre detiene install y uninstall, byte a byte", async () => {
    const root = tempRoot();
    try {
      const dir = join(root, "design");
      mkdirSync(dir, { recursive: true });
      const foreign = "---\nname: design\ndescription: skill ajena\n---\nno la tocamos\n";
      writeFileSync(join(dir, "SKILL.md"), foreign);

      const install = await installCapabilitySkill(root, DESIGN_DESCRIPTOR);
      expect(install.ok).toBe(false);
      if (install.ok) return;
      expect(install.failure.code).toBe("CAPABILITY_WRAPPER_CONFLICT");
      expect(install.failure.action.length).toBeGreaterThan(0);

      const uninstall = await uninstallCapabilitySkill(root, "design");
      expect(uninstall.ok).toBe(false);
      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(foreign);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("la proyección de invocación es la que el host soporta de verdad", () => {
  it("cada host declara una forma o dice que no puede cargar la skill", () => {
    for (const harness of HARNESSES) {
      const invocation = harness.invocation;
      if (invocation === null) continue;
      expect(invocation.template, harness.id).toContain("<name>");
      expect(invocation.note.length, harness.id).toBeGreaterThan(0);
    }
  });

  it("ningún host anuncia una forma inventada de slash command", () => {
    const slashes = HARNESSES.filter((h) => h.invocation?.kind === "slash");
    // Solo se anuncia lo verificado: hoy, la forma de Kimi Code.
    expect(slashes.map((h) => h.id)).toEqual(["kimi"]);
    for (const harness of HARNESSES) {
      expect(harness.invocation?.template, harness.id).not.toBe("/design");
    }
  });

  it("un host sin slash command muestra su forma real, no la de otro", () => {
    const claude = HARNESSES.find((h) => h.id === "claude-code");
    expect(claude?.invocation?.kind).toBe("mention");
    expect(claude?.invocation?.template).toBe("<name>");
  });
});
