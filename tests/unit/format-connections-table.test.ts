import { describe, expect, it } from "vitest";
import {
  type SelfMcpConnectionView,
  formatConnectionsTable,
} from "../../src/application/self/mcp-config.js";

type Status = "si" | "no" | "drift";
type Host = "claude" | "codex" | "warp" | "gemini" | "opencode" | "crush";

// All 6 hosts default to "no"; override any subset.
function view(
  nombre: string,
  dsnVar: string,
  status: Partial<Record<Host, Status>> = {},
): SelfMcpConnectionView {
  const d: Status = "no";
  return {
    nombre,
    server_name: nombre,
    dsn_var: dsnVar,
    dsn_visible: false,
    instalado: {
      claude: status.claude ?? d,
      codex: status.codex ?? d,
      warp: status.warp ?? d,
      gemini: status.gemini ?? d,
      opencode: status.opencode ?? d,
      crush: status.crush ?? d,
    },
  };
}

// The host status cells of a data row (after `nombre` and `DSN var`, before the trailing edge).
function statusCells(line: string): string[] {
  const cells = line.split("│").map((c) => c.trim());
  return cells.slice(3, cells.length - 1);
}

describe("formatConnectionsTable", () => {
  it("caso vacío: marco cerrado + una columna por cada host (los 6)", () => {
    const out = formatConnectionsTable([]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith("┌")).toBe(true);
    expect(lines[0]?.endsWith("┐")).toBe(true);
    for (const h of [
      "nombre",
      "DSN var",
      "Claude",
      "Codex",
      "Warp",
      "Gemini",
      "OpenCode",
      "Crush",
    ]) {
      expect(lines[1]).toContain(h);
    }
    expect(lines[2]?.startsWith("└")).toBe(true);
  });

  it("una conexión sin instalar: – en las 6 columnas de host", () => {
    const out = formatConnectionsTable([view("cert", "DB_CERT_DSN")]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain("│ cert");
    expect(lines[3]).toContain("DB_CERT_DSN");
    expect(statusCells(lines[3] ?? "")).toEqual(["–", "–", "–", "–", "–", "–"]);
  });

  it("status icons mapean: si→✓ en las 6 columnas", () => {
    const all: Status = "si";
    const out = formatConnectionsTable([
      view("a", "DSN_A", {
        claude: all,
        codex: all,
        warp: all,
        gemini: all,
        opencode: all,
        crush: all,
      }),
    ]);
    expect(statusCells(out.split("\n")[3] ?? "")).toEqual(["✓", "✓", "✓", "✓", "✓", "✓"]);
  });

  it("status icons mapean: drift→! y no→–, por columna independiente", () => {
    const out = formatConnectionsTable([
      view("a", "DSN_A", { claude: "drift", warp: "drift" }), // resto = no
    ]);
    // orden de columnas = orden del registro de hosts (claude, codex, warp, gemini, opencode, crush)
    expect(statusCells(out.split("\n")[3] ?? "")).toEqual(["!", "–", "!", "–", "–", "–"]);
  });

  it("ancho de columna se ajusta al valor más largo (no al header)", () => {
    const out = formatConnectionsTable([view("reporting-warehouse", "REPORTING_WAREHOUSE_DSN")]);
    const lines = out.split("\n");
    expect(lines[3]).toContain("│ reporting-warehouse │");
  });
});
