import { describe, expect, it } from "vitest";
import {
  type SelfMcpConnectionView,
  formatConnectionsTable,
} from "../../src/application/self/mcp-config.js";
import { MCP_FILE_HOSTS } from "../../src/domain/harnesses.js";
import type { McpHost } from "../../src/domain/mcp-entry.js";

type Status = "si" | "no" | "drift";
type Host = McpHost;

// One column per file-writing host, DERIVED from the catalog: pinning the count
// by hand is exactly how this table went stale when a host was added.
const HOST_COUNT = MCP_FILE_HOSTS.length;

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
    instalado: Object.fromEntries(MCP_FILE_HOSTS.map((h) => [h, status[h] ?? d])) as Record<
      McpHost,
      Status
    >,
  };
}

// The host status cells of a data row (after `nombre` and `DSN var`, before the trailing edge).
function statusCells(line: string): string[] {
  const cells = line.split("│").map((c) => c.trim());
  return cells.slice(3, cells.length - 1);
}

describe("formatConnectionsTable", () => {
  it("caso vacío: marco cerrado + una columna por cada host (todos)", () => {
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

  it("una conexión sin instalar: – en todas las columnas de host", () => {
    const out = formatConnectionsTable([view("cert", "DB_CERT_DSN")]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain("│ cert");
    expect(lines[3]).toContain("DB_CERT_DSN");
    expect(statusCells(lines[3] ?? "")).toEqual(Array(HOST_COUNT).fill("–"));
  });

  it("status icons mapean: si→✓ en todas las columnas", () => {
    const all: Partial<Record<Host, Status>> = Object.fromEntries(
      MCP_FILE_HOSTS.map((h) => [h, "si" as Status]),
    );
    const out = formatConnectionsTable([view("a", "DSN_A", all)]);
    expect(statusCells(out.split("\n")[3] ?? "")).toEqual(Array(HOST_COUNT).fill("✓"));
  });

  it("status icons mapean: drift→! y no→–, por columna independiente", () => {
    const out = formatConnectionsTable([
      view("a", "DSN_A", { claude: "drift", warp: "drift" }), // rest = no
    ]);
    // column order = host registry order; only claude and warp drift.
    expect(statusCells(out.split("\n")[3] ?? "")).toEqual(
      MCP_FILE_HOSTS.map((h) => (h === "claude" || h === "warp" ? "!" : "–")),
    );
  });

  it("ancho de columna se ajusta al valor más largo (no al header)", () => {
    const out = formatConnectionsTable([view("reporting-warehouse", "REPORTING_WAREHOUSE_DSN")]);
    const lines = out.split("\n");
    expect(lines[3]).toContain("│ reporting-warehouse │");
  });
});
