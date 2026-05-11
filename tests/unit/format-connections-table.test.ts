import { describe, expect, it } from "vitest";
import {
  type SelfMcpConnectionView,
  formatConnectionsTable,
} from "../../src/application/self/mcp-config.js";

function view(
  nombre: string,
  dsnVar: string,
  claude: "si" | "no" | "drift" = "no",
  codex: "si" | "no" | "drift" = "no",
  warp: "si" | "no" | "drift" = "no",
): SelfMcpConnectionView {
  return {
    nombre,
    server_name: nombre,
    dsn_var: dsnVar,
    dsn_visible: false,
    instalado: { claude_code: claude, codex, warp },
  };
}

describe("formatConnectionsTable", () => {
  it("caso vacío: header + bottom sin filas, marco cerrado", () => {
    const out = formatConnectionsTable([]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith("┌")).toBe(true);
    expect(lines[0]?.endsWith("┐")).toBe(true);
    expect(lines[1]).toContain("nombre");
    expect(lines[1]).toContain("DSN var");
    expect(lines[1]).toContain("Claude");
    expect(lines[1]).toContain("Codex");
    expect(lines[1]).toContain("Warp");
    expect(lines[2]?.startsWith("└")).toBe(true);
  });

  it("una conexión con status icons (no/no): – en ambas columnas", () => {
    const out = formatConnectionsTable([view("cert", "DB_CERT_DSN")]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain("│ cert");
    expect(lines[3]).toContain("DB_CERT_DSN");
    expect(lines[3]).toContain("│ –      │"); // padded a "Claude"
    expect(lines[3]).toMatch(/│ – {4}│$/); // último char antes del cierre = padded "Warp"
  });

  it("status icons mapean: si→✓ · no→– · drift→!", () => {
    const out = formatConnectionsTable([
      view("a", "DSN_A", "si", "no"),
      view("b", "DSN_B", "drift", "si"),
    ]);
    const lines = out.split("\n");
    expect(lines[3]).toContain("│ ✓"); // Claude=si
    expect(lines[3]).toContain("│ –"); // Codex=no
    expect(lines[4]).toContain("│ !"); // Claude=drift
    expect(lines[4]).toContain("│ ✓     │"); // Codex=si
    expect(lines[4]).toMatch(/│ – {4}│$/); // Warp=no (last col)
  });

  it("ancho de columna se ajusta al valor más largo (no al header)", () => {
    const out = formatConnectionsTable([view("reporting-warehouse", "REPORTING_WAREHOUSE_DSN")]);
    const lines = out.split("\n");
    expect(lines[1]).toMatch(/│ nombre {14}│/);
    expect(lines[3]).toContain("│ reporting-warehouse │");
  });

  it("snapshot exacto para 2 conexiones con todos los estados mixtos", () => {
    const out = formatConnectionsTable([
      view("cert", "DB_CERT_DSN", "si", "no"),
      view("prod", "DB_PROD_DSN", "drift", "si"),
    ]);
    const expected = [
      "┌────────┬─────────────┬────────┬───────┬──────┐",
      "│ nombre │ DSN var     │ Claude │ Codex │ Warp │",
      "├────────┼─────────────┼────────┼───────┼──────┤",
      "│ cert   │ DB_CERT_DSN │ ✓      │ –     │ –    │",
      "│ prod   │ DB_PROD_DSN │ !      │ ✓     │ –    │",
      "└────────┴─────────────┴────────┴───────┴──────┘",
    ].join("\n");
    expect(out).toBe(expected);
  });
});
