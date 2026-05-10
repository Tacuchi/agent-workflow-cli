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
): SelfMcpConnectionView {
  return {
    nombre,
    server_name: nombre,
    dsn_var: dsnVar,
    dsn_visible: false,
    instalado: { claude_code: claude, codex },
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
    expect(lines[1]).toContain("Claude Code");
    expect(lines[1]).toContain("Codex");
    expect(lines[2]?.startsWith("└")).toBe(true);
    expect(lines[2]?.endsWith("┘")).toBe(true);
  });

  it("una conexión: 5 líneas (top, header, sep, row, bottom) y celdas alineadas al header", () => {
    const out = formatConnectionsTable([view("cert", "DB_CERT_DSN")]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]?.startsWith("├")).toBe(true);
    expect(lines[2]?.endsWith("┤")).toBe(true);
    expect(lines[3]).toContain("│ cert");
    expect(lines[3]).toContain("DB_CERT_DSN");
    expect(lines[3]).toContain("│ no          │"); // padding al ancho de "Claude Code"
    expect(lines[3]).toContain("│ no    │"); // padding al ancho de "Codex"
    expect(lines[4]?.startsWith("└")).toBe(true);
  });

  it("ancho de columna se ajusta al valor más largo (no al header)", () => {
    const out = formatConnectionsTable([view("reporting-warehouse", "REPORTING_WAREHOUSE_DSN")]);
    const lines = out.split("\n");
    // El header "nombre" se padding-extiende para acomodar "reporting-warehouse"
    expect(lines[1]).toMatch(/│ nombre {14}│/);
    expect(lines[3]).toContain("│ reporting-warehouse │");
  });

  it("múltiples conexiones: una fila por conexión, todas con anchos consistentes", () => {
    const out = formatConnectionsTable([
      view("cert", "DB_CERT_DSN", "si", "no"),
      view("prod", "DB_PROD_DSN", "drift", "si"),
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(6); // top, header, sep, row, row, bottom
    const widths = lines.map((l) => [...l].length);
    expect(new Set(widths).size).toBe(1); // todas las líneas mismo largo visual
    expect(lines[3]).toContain("│ cert   │"); // padded a ancho de "nombre" header
    expect(lines[4]).toContain("│ prod   │");
    expect(lines[3]).toContain("│ si          │"); // cert claude_code=si padded a Claude Code
    expect(lines[4]).toContain("│ drift       │"); // prod claude_code=drift
    expect(lines[4]).toContain("│ si    │"); // prod codex=si padded a "Codex"
  });

  it("snapshot exacto para 2 conexiones con estado mixto", () => {
    const out = formatConnectionsTable([
      view("cert", "DB_CERT_DSN", "no", "no"),
      view("prod", "DB_PROD_DSN", "no", "no"),
    ]);
    const expected = [
      "┌────────┬─────────────┬─────────────┬───────┐",
      "│ nombre │ DSN var     │ Claude Code │ Codex │",
      "├────────┼─────────────┼─────────────┼───────┤",
      "│ cert   │ DB_CERT_DSN │ no          │ no    │",
      "│ prod   │ DB_PROD_DSN │ no          │ no    │",
      "└────────┴─────────────┴─────────────┴───────┘",
    ].join("\n");
    expect(out).toBe(expected);
  });
});
