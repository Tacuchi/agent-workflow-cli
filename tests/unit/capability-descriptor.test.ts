import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CONTRACT_VERSION,
  CAPABILITY_DESCRIPTOR_METADATA_KEY,
  exposes,
  findOperation,
  parseDescriptorLocator,
  validateCapabilityDescriptor,
  verifyDescriptorPayload,
} from "../../src/domain/capability/descriptor.js";
import {
  CANONICAL_SCHEMAS,
  DESIGN_CAPABILITY,
  DESIGN_DESCRIPTOR,
  DESIGN_OPERATIONS,
} from "../../src/domain/design/capability.js";
import { BUILTIN_DEFAULT_SKILLS, SKILL_ROLES } from "../../src/domain/skills.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const maximal = (): Record<string, unknown> =>
  JSON.parse(readFileSync(`${repoRoot}tests/fixtures/capability/descriptor-maximal.json`, "utf8"));

describe("una capacidad conformante declara su contrato", () => {
  it("el descriptor genérico maximal es válido", () => {
    const result = validateCapabilityDescriptor(maximal());
    expect(result.failures).toEqual([]);
    expect(result.value?.name).toBe("example-capability");
  });

  it("el descriptor de design es válido y declara sus cinco operaciones", () => {
    const result = validateCapabilityDescriptor(
      DESIGN_DESCRIPTOR,
      "design/workline-capability.json",
    );
    expect(result.failures).toEqual([]);
    expect(DESIGN_DESCRIPTOR.operations.map((o) => o.name)).toEqual([...DESIGN_OPERATIONS]);
  });

  it("create y update admiten el attachment opcional del documento consumidor", () => {
    for (const operation of ["create", "update"]) {
      const input = findOperation(DESIGN_DESCRIPTOR, operation)?.inputs.find(
        (candidate) => candidate.name === "consumer_document",
      );
      expect(input).toMatchObject({ kind: "attachment", required: false, sensitivity: "public" });
    }
  });

  // El descriptor REFERENCIA los formatos del package; no los redefine ni se
  // convierte en otro. Un schema inventado acá sería un segundo formato de
  // diseño entrando por la puerta de atrás.
  it("cada schema que design referencia es un formato canónico ya publicado", () => {
    const canonical = new Set<string>(Object.values(CANONICAL_SCHEMAS));
    const referenced = DESIGN_DESCRIPTOR.operations.flatMap((op) => [
      op.output.schema,
      ...op.inputs.map((i) => i.schema),
    ]);
    const invented = referenced.filter((s) => s !== null && !canonical.has(s));
    expect(invented, "schemas referenciados que no son formatos canónicos").toEqual([]);
    expect(
      referenced.some((s) => s !== null),
      "referencia al menos un formato",
    ).toBe(true);
  });

  it("omitir un campo obligatorio se rechaza nombrando el campo", () => {
    const { floor, ...doc } = maximal();
    expect(floor, "el fixture sí declaraba el campo que se omite").toBeDefined();
    const result = validateCapabilityDescriptor(doc);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.message).join(" ")).toContain("floor");
    // Un diagnóstico sin acción correctiva es un callejón sin salida.
    expect(result.failures.every((f) => f.action.trim().length > 0)).toBe(true);
  });

  it("una versión de contrato desconocida detiene la lectura antes de cualquier campo", () => {
    const doc = { ...maximal(), contract_version: 99 };
    const result = validateCapabilityDescriptor(doc);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("CAPABILITY_CONTRACT_VERSION_UNSUPPORTED");
    expect(result.failures).toHaveLength(1);
  });

  it("una clave que el contrato no declara se rechaza como typo, no como extensión", () => {
    const doc = { ...maximal(), extras: true };
    const result = validateCapabilityDescriptor(doc);
    expect(result.failures.map((f) => f.code)).toContain("CAPABILITY_KEY_UNKNOWN");
  });

  it("una operación no puede exponer una ruta que la capacidad no abre", () => {
    const doc = maximal();
    doc.exposure = ["compose"];
    const result = validateCapabilityDescriptor(doc);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.message).join(" ")).toContain("direct");
  });

  it("una capacidad core sin floor incorporado se rechaza", () => {
    const doc = maximal();
    doc.floor = { builtin: false, kind: "core", improvements: "host_selected" };
    const result = validateCapabilityDescriptor(doc);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.message).join(" ")).toContain("core");
  });

  it("una operación sin efectos declarados se rechaza: read_only también se declara", () => {
    const doc = maximal();
    const operations = (doc.operations as Record<string, unknown>[]).map((op) => ({
      ...op,
      effects: [],
    }));
    expect(validateCapabilityDescriptor({ ...doc, operations }).ok).toBe(false);
  });

  it("el nombre vigente no puede figurar entre los retirados", () => {
    const doc = maximal();
    (doc.compatibility as Record<string, unknown>).retired_names = ["example-capability"];
    expect(validateCapabilityDescriptor(doc).ok).toBe(false);
  });
});

describe("la identidad pública es el name y no hay un ID de rol paralelo", () => {
  it("design como capacidad y design como slot de binding son el mismo string", () => {
    expect(DESIGN_DESCRIPTOR.name).toBe(DESIGN_CAPABILITY);
    expect(SKILL_ROLES).toContain(DESIGN_DESCRIPTOR.name);
    expect(BUILTIN_DEFAULT_SKILLS[DESIGN_CAPABILITY]).toBe(DESIGN_DESCRIPTOR.name);
  });

  it("los nombres retirados no son aliases: se declaran para rechazarlos", () => {
    expect(DESIGN_DESCRIPTOR.compatibility.retired_names).toEqual(["ui-design", "ui-spec"]);
    expect(DESIGN_DESCRIPTOR.compatibility.retired_names).not.toContain(DESIGN_CAPABILITY);
  });
});

describe("una skill solo obtiene superficie Workline si la declara", () => {
  // El opt-in se ejerce en el INVENTARIO: una skill sin descriptor no entra, y
  // un descriptor sin exposición no valida. No hay un tercer lugar donde
  // preguntarlo — un predicado aparte sería una segunda respuesta.
  it("el contrato exige declarar al menos una ruta", () => {
    const doc = maximal();
    doc.exposure = [];
    expect(validateCapabilityDescriptor(doc).ok).toBe(false);
  });

  it("design declara ambas rutas", () => {
    expect(exposes(DESIGN_DESCRIPTOR, "direct")).toBe(true);
    expect(exposes(DESIGN_DESCRIPTOR, "compose")).toBe(true);
  });

  it("una operación fuera del catálogo no existe", () => {
    expect(findOperation(DESIGN_DESCRIPTOR, "consume")).toBeNull();
    expect(findOperation(DESIGN_DESCRIPTOR, "create")).not.toBeNull();
  });
});

describe("el locator de una mejora localiza y nada más", () => {
  const bytes = JSON.stringify(maximal());
  const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
  const good = `capability/workline-capability.json#sha256=${digest}`;

  it("un locator bien formado se parsea", () => {
    const parsed = parseDescriptorLocator(good);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.locator.path).toBe("capability/workline-capability.json");
    expect(parsed.locator.digest).toBe(digest);
    // Un locator LOCALIZA: no trae binding, alias ni identidad.
    expect(Object.keys(parsed.locator).sort()).toEqual(["digest", "path"]);
  });

  it.each([
    ["absoluto", `/etc/workline-capability.json#sha256=${digest}`],
    ["escapado", `../../etc/workline-capability.json#sha256=${digest}`],
    ["con separador de Windows", `a\\b.json#sha256=${digest}`],
    ["sin sello", "capability/workline-capability.json"],
    ["con digest corto", "capability/workline-capability.json#sha256=abc"],
    ["con digest en mayúsculas", `capability/x.json#sha256=${digest.toUpperCase()}`],
    ["que no apunta a JSON", `capability/SKILL.md#sha256=${digest}`],
    ["vacío", ""],
  ])("un locator %s se rechaza con acción", (_case, raw) => {
    const parsed = parseDescriptorLocator(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.action.trim().length).toBeGreaterThan(0);
  });

  it("la clave de metadata es escalar y namespaced", () => {
    expect(CAPABILITY_DESCRIPTOR_METADATA_KEY).toBe("workline-capability-descriptor");
  });

  it("bytes que no producen el digest sellado se rechazan como stale", () => {
    const parsed = parseDescriptorLocator(good);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const check = verifyDescriptorPayload(parsed.locator, `${bytes} `);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("CAPABILITY_DESCRIPTOR_DIGEST_MISMATCH");
  });

  it("bytes sellados con una versión de contrato distinta se rechazan por versión", () => {
    const other = JSON.stringify({
      ...maximal(),
      contract_version: CAPABILITY_CONTRACT_VERSION + 1,
    });
    const otherDigest = createHash("sha256").update(other, "utf8").digest("hex");
    const check = verifyDescriptorPayload({ path: "c/x.json", digest: otherDigest }, other);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("CAPABILITY_CONTRACT_VERSION_UNSUPPORTED");
  });

  it("un descriptor de mejora conserva su propio name y no toca la identidad de design", () => {
    const improvement = { ...maximal(), name: "acme-design-lab" };
    const check = verifyDescriptorPayload(
      {
        path: "acme/workline-capability.json",
        digest: createHash("sha256").update(JSON.stringify(improvement), "utf8").digest("hex"),
      },
      JSON.stringify(improvement),
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.descriptor.name).toBe("acme-design-lab");
    expect(check.descriptor.name).not.toBe(DESIGN_CAPABILITY);
    // Declarar compatibilidad no cambia el binding por defecto del rol.
    expect(BUILTIN_DEFAULT_SKILLS[DESIGN_CAPABILITY]).toBe("design");
  });
});
