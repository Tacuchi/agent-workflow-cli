import { describe, expect, it } from "vitest";
import {
  inferType,
  isValidDevType,
  parseTypeFromObjetivo,
} from "../../src/application/session/infer-type.js";

describe("inferType — heurística Mit-C", () => {
  it("detecta refactor con alta confianza", () => {
    const r = inferType("rebuild de mantenimiento de categorías al estándar nuevo");
    expect(r.type).toBe("refactor");
    expect(r.confidence).toBe("high");
    expect(r.matchedKeywords).toContain("rebuild");
  });

  it("detecta feature con alta confianza", () => {
    const r = inferType("agregar mantenimiento de categorías con CRUD");
    expect(r.type).toBe("feature");
    expect(r.confidence).toBe("high");
    expect(r.matchedKeywords).toContain("agregar");
  });

  it("detecta bugfix con confianza media", () => {
    const r = inferType("fix de validación en formulario de usuarios");
    expect(r.type).toBe("bugfix");
    expect(r.confidence).toBe("medium");
  });

  it("detecta chore con alta confianza", () => {
    const r = inferType("bump de dependencias del CLI");
    expect(r.type).toBe("chore");
    expect(r.confidence).toBe("high");
    expect(r.matchedKeywords).toContain("bump");
  });

  it("fallback a feature cuando no matchea", () => {
    const r = inferType("mejoras varias en el sistema");
    expect(r.type).toBe("feature");
    expect(r.confidence).toBe("fallback");
    expect(r.matchedKeywords).toEqual([]);
  });

  it("refactor gana sobre feature cuando ambos keywords están", () => {
    const r = inferType("agregar nuevas funciones al refactor de pdf-renderer");
    expect(r.type).toBe("refactor");
  });
});

describe("isValidDevType — validación de --type", () => {
  it("acepta los 4 tipos canónicos", () => {
    expect(isValidDevType("feature")).toBe(true);
    expect(isValidDevType("refactor")).toBe(true);
    expect(isValidDevType("bugfix")).toBe(true);
    expect(isValidDevType("chore")).toBe(true);
  });

  it("rechaza valores inválidos", () => {
    expect(isValidDevType("hotfix")).toBe(false);
    expect(isValidDevType("docs")).toBe(false);
    expect(isValidDevType("")).toBe(false);
    expect(isValidDevType("FEATURE")).toBe(false); // case-sensitive, normalize antes
  });
});

describe("parseTypeFromObjetivo — alias bilingüe ## Type / ## Tipo", () => {
  it("lee ## Type canónico", () => {
    const md = "# Objective — session050\n\n## Type\nfeature\n\n## Requirement\n…";
    expect(parseTypeFromObjetivo(md)).toBe("feature");
  });

  it("lee ## Tipo legacy ES y normaliza a EN", () => {
    const md = "# Objective — session045\n\n## Tipo\nrefactor\n\n## Origin\n…";
    expect(parseTypeFromObjetivo(md)).toBe("refactor");
  });

  it("retorna null si no encuentra la sección", () => {
    const md = "# Objective — session999\n\n## Requirement\nbla\n";
    expect(parseTypeFromObjetivo(md)).toBeNull();
  });

  it("retorna null si el valor no es un tipo válido", () => {
    const md = "# Objective\n\n## Type\nbananas\n";
    expect(parseTypeFromObjetivo(md)).toBeNull();
  });

  it("tolera CRLF endings", () => {
    const md = "# Objective\r\n\r\n## Type\r\nbugfix\r\n";
    expect(parseTypeFromObjetivo(md)).toBe("bugfix");
  });

  it("tolera whitespace alrededor del valor", () => {
    const md = "# Objective\n\n## Type\n  chore  \n";
    expect(parseTypeFromObjetivo(md)).toBe("chore");
  });
});
