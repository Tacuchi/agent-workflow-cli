import { describe, expect, it } from "vitest";
import { renderRefs } from "../../src/application/render/history-row.js";

describe("renderRefs — BUILTIN_RENDERERS (post R5)", () => {
  it("renderiza decision con prefijo NNN", () => {
    expect(renderRefs("dec:001-stack-typescript")).toBe(
      "[DEC](../docs/decisiones/001-stack-typescript.md)",
    );
  });

  it("renderiza decision alias 'decision'", () => {
    expect(renderRefs("decision:001-stack-typescript")).toBe(
      "[DEC](../docs/decisiones/001-stack-typescript.md)",
    );
  });

  it("renderiza plan", () => {
    expect(renderRefs("plan:001-export-plan-2026-05-18")).toBe(
      "[PLAN](../docs/planes/001-export-plan-2026-05-18.md)",
    );
  });

  it("renderiza scripts (aliases sql/script/scripts)", () => {
    const expected = "[SQL](../docs/scripts/001-session001-foo/)";
    expect(renderRefs("scripts:001-session001-foo")).toBe(expected);
    expect(renderRefs("script:001-session001-foo")).toBe(expected);
    expect(renderRefs("sql:001-session001-foo")).toBe(expected);
  });

  it("renderiza conclusion (aliases conclusion/conclusions)", () => {
    const expected = "[CONCLUSION](../docs/conclusiones/004-audit-test.md)";
    expect(renderRefs("conclusion:004-audit-test")).toBe(expected);
    expect(renderRefs("conclusions:004-audit-test")).toBe(expected);
  });

  it("renderiza manual (nuevo R5 — aliases manual/manuales)", () => {
    const expected = "[MANUAL](../docs/manuales/001-mcp-setup.md)";
    expect(renderRefs("manual:001-mcp-setup")).toBe(expected);
    expect(renderRefs("manuales:001-mcp-setup")).toBe(expected);
  });

  it("renderiza especificacion (nuevo R5 — aliases especificacion/especificaciones)", () => {
    const expected = "[ESPECIFICACION](../docs/especificaciones/001-export-func-format/)";
    expect(renderRefs("especificacion:001-export-func-format")).toBe(expected);
    expect(renderRefs("especificaciones:001-export-func-format")).toBe(expected);
  });

  it("renderiza release (nuevo R5)", () => {
    expect(renderRefs("release:001-informe-release")).toBe(
      "[RELEASE](../docs/release/001-informe-release.md)",
    );
  });

  it("kind desconocido cae a renderer genérico", () => {
    expect(renderRefs("foo:bar")).toBe("[FOO](bar)");
  });

  it("entrada vacía devuelve guion", () => {
    expect(renderRefs("")).toBe("—");
    expect(renderRefs(null)).toBe("—");
    expect(renderRefs(undefined)).toBe("—");
  });

  it("combina múltiples refs con coma", () => {
    expect(renderRefs("dec:001-stack,manual:002-mcp,conclusion:003-audit")).toBe(
      "[DEC](../docs/decisiones/001-stack.md), [MANUAL](../docs/manuales/002-mcp.md), [CONCLUSION](../docs/conclusiones/003-audit.md)",
    );
  });

  it("ref libre sin 'kind:' se conserva como texto plano (antes se perdía a '—')", () => {
    expect(renderRefs("ver el informe 003")).toBe("ver el informe 003");
    expect(renderRefs("dec:001-stack, nota suelta")).toBe(
      "[DEC](../docs/decisiones/001-stack.md), nota suelta",
    );
  });

  it("una URL pasa entera como texto plano (no se mutila por el split kind:val)", () => {
    expect(renderRefs("https://github.com/org/repo/pull/42")).toBe(
      "https://github.com/org/repo/pull/42",
    );
    expect(renderRefs("dec:001-x, https://ci.example.com/run/9")).toBe(
      "[DEC](../docs/decisiones/001-x.md), https://ci.example.com/run/9",
    );
  });
});
