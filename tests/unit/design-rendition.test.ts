import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gateDesignDocument } from "../../src/domain/design/maturity.js";
import {
  type DesignRendition,
  checkStale,
  computeSourceDigest,
  staleFailure,
  validateDesignRendition,
} from "../../src/domain/design/rendition.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const PATH = "renditions/VIS-001-r001-formulario-alta/rendition.json";

const raw = (): Record<string, unknown> =>
  JSON.parse(fixture("rendition-VIS-001-r001.json")) as Record<string, unknown>;

function valid(patch: Record<string, unknown> = {}): DesignRendition {
  const result = validateDesignRendition({ ...raw(), ...patch }, PATH);
  if (!result.ok || result.value === null) {
    throw new Error(`el fixture no validó: ${JSON.stringify(result.failures)}`);
  }
  return result.value;
}

const digestOf = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

describe("F4 · una rendition sabe de qué revisión salió", () => {
  it("el fixture maximal valida", () => {
    const result = validateDesignRendition(raw(), PATH);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // La prueba de fase, primera mitad: alterar la screen fuente deja la rendition
  // marcada obsoleta por `source_digest`.
  it("alterar la screen fuente marca la rendition obsoleta", () => {
    const rendition = valid();
    const original = new Map([["DES-001/SCR-001@r2", rendition.sources[0]?.sha256 as string]]);
    expect(checkStale(rendition, original)).toBeNull();

    const alterada = new Map([["DES-001/SCR-001@r2", digestOf("la screen cambió")]]);
    const verdict = checkStale(rendition, alterada);
    expect(verdict).not.toBeNull();
    if (verdict === null) return;
    expect(verdict.moved).toEqual(["DES-001/SCR-001@r2"]);
    expect(verdict.expected).toBe(rendition.source_digest);
    expect(verdict.actual).not.toBe(verdict.expected);

    const failure = staleFailure(verdict, PATH);
    expect(failure.code).toBe("DESIGN_RENDITION_STALE");
    expect(failure.message).toContain("DES-001/VIS-001@r1");
    expect(failure.action).toContain("revisión vigente");
  });

  it("una fuente que ya no está en el package cuenta como movida, no como intacta", () => {
    const verdict = checkStale(valid(), new Map());
    expect(verdict?.moved).toEqual(["DES-001/SCR-001@r2"]);
  });

  it("el token es recomputable: reordenar las fuentes no lo cambia", () => {
    const a = { ref: "DES-001/SCR-001@r2", sha256: `sha256:${"1".repeat(64)}` };
    const b = { ref: "DES-001/SCR-002@r1", sha256: `sha256:${"2".repeat(64)}` };
    expect(computeSourceDigest([a, b])).toBe(computeSourceDigest([b, a]));
    expect(computeSourceDigest([a])).not.toBe(computeSourceDigest([a, b]));
  });

  it("un source_digest que no es el de sus propias fuentes se rechaza", () => {
    const result = validateDesignRendition(
      { ...raw(), source_digest: `sha256:${"0".repeat(64)}` },
      PATH,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_DIGEST_MISMATCH");
  });

  it("una rendition sin fuentes no valida: sin fuente no hay obsolescencia detectable", () => {
    const result = validateDesignRendition({ ...raw(), sources: [] }, PATH);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.message.includes("siempre sale de algo"))).toBe(true);
  });

  it("una rendition no sale de otra rendition", () => {
    const result = validateDesignRendition(
      {
        ...raw(),
        sources: [{ ref: "DES-001/VIS-002@r1", sha256: `sha256:${"3".repeat(64)}` }],
      },
      PATH,
    );
    expect(result.failures.some((f) => f.action.includes("no de otra rendition"))).toBe(true);
  });
});

describe("F4 · fidelidad y madurez nunca se contaminan", () => {
  // La prueba de fase, segunda mitad: subir la fidelidad de una rendition no
  // mueve la madurez de su screen.
  it("subir la fidelidad de una rendition no mueve la madurez de su screen", () => {
    const screen = fixture("SCR-001-r002-formulario-alta.md");
    const antes = gateDesignDocument(screen, "screen", "screens/SCR-001-r002-formulario-alta.md");

    const baja = valid({ fidelity: "low" });
    const alta = valid({ fidelity: "high" });
    expect(baja.fidelity).toBe("low");
    expect(alta.fidelity).toBe("high");

    // La screen no cambió: su veredicto tampoco puede haberlo hecho.
    const despues = gateDesignDocument(screen, "screen", "screens/SCR-001-r002-formulario-alta.md");
    expect(despues.attainable).toBe(antes.attainable);
    expect(despues.failures).toEqual(antes.failures);
    // Y el vocabulario no se cruza: una rendition nunca dice 'handoff'.
    expect(["low", "medium", "high"]).toContain(alta.fidelity);
    expect(JSON.stringify(alta)).not.toContain("handoff");
  });
});

describe("F4 · visibilidad y locators sin credenciales", () => {
  it("registra la clase de acceso y el locator del proveedor", () => {
    const rendition = valid();
    expect(rendition.access).toBe("team");
    expect(rendition.provider?.locator).toEqual({ file_key: "abc123DEF456", node_id: "12:345" });
    // La sincronía con el proveedor es una afirmación, y 'unknown' es la honesta.
    expect(rendition.provider?.sync).toBe("unknown");
  });

  it("un token dentro del locator se rechaza", () => {
    const result = validateDesignRendition(
      {
        ...raw(),
        provider: {
          name: "figma",
          locator: { file_key: "abc123DEF456", access_token: "figd_abcdefghijklmnopqrstuvwx0123" },
          version: null,
          sync: "unknown",
        },
      },
      PATH,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_SECRET_PRESENT");
  });

  it("una rendition puramente local declara provider: null", () => {
    expect(valid({ provider: null, access: "local_only" }).provider).toBeNull();
  });

  it("un locator vacío no localiza nada y se rechaza", () => {
    const result = validateDesignRendition(
      { ...raw(), provider: { name: "figma", locator: {}, version: null, sync: "unknown" } },
      PATH,
    );
    expect(result.failures.some((f) => f.message.includes("al menos una clave"))).toBe(true);
  });
});

describe("F4 · la evidencia local y su medio no se pueden falsear", () => {
  it("una rendition sin archivos locales se rechaza", () => {
    const result = validateDesignRendition({ ...raw(), files: [] }, PATH);
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_EVIDENCE_INSUFFICIENT");
  });

  it("un archivo que se escapa de la carpeta de la rendition se rechaza", () => {
    const result = validateDesignRendition(
      { ...raw(), files: [{ path: "../../otra/preview.svg", sha256: `sha256:${"7".repeat(64)}` }] },
      PATH,
    );
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_PATH_UNSAFE");
  });

  it("un formato declarado que ningún archivo respalda se rechaza", () => {
    const result = validateDesignRendition({ ...raw(), format: "pdf" }, PATH);
    expect(result.failures.some((f) => f.message.includes("ninguno de sus archivos"))).toBe(true);
  });

  it("evidencia de interacción sobre un medio estático se rechaza", () => {
    const result = validateDesignRendition({ ...raw(), medium: "static_image" }, PATH);
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_EVIDENCE_INSUFFICIENT");
    expect(result.failures.some((f) => f.action.includes("storyboard"))).toBe(true);
  });

  it("una evidencia de interacción a medias se rechaza", () => {
    const result = validateDesignRendition(
      {
        ...raw(),
        interaction_evidence: { trigger: "click", transition: "", outcome: "listo" },
      },
      PATH,
    );
    expect(result.failures.some((f) => f.message.includes("transition"))).toBe(true);
  });
});
