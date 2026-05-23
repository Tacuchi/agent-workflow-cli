import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { SelfMcpConnectionView } from "../../src/application/self/mcp-config.js";
import { ConnectionsTable } from "../../src/cli/tui/components/connections-table.js";

function view(nombre: string, dsnVar: string): SelfMcpConnectionView {
  return {
    nombre,
    server_name: nombre,
    dsn_var: dsnVar,
    dsn_visible: false,
    instalado: { claude_code: "no", codex: "no" },
  };
}

describe("ConnectionsTable (TUI)", () => {
  it("shows placeholder when there are no connections", () => {
    const { lastFrame } = render(<ConnectionsTable connections={[]} />);
    expect(lastFrame()).toContain("(no registered connections)");
  });

  it("renderiza tabla con conexiones", () => {
    const { lastFrame } = render(<ConnectionsTable connections={[view("cert", "DB_CERT_DSN")]} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("nombre");
    expect(frame).toContain("DSN var");
    expect(frame).toContain("cert");
    expect(frame).toContain("DB_CERT_DSN");
    expect(frame).toContain("┌");
    expect(frame).toContain("└");
  });
});
