import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Mock the data boundary so we can render populated states without touching the
// real profile.json. `selfMcpConfig` is the only runtime import the tab uses for
// data; `list` (refresh) is the only action these tests exercise.
vi.mock("../../src/application/self/mcp-config.js", () => ({
  selfMcpConfig: vi.fn(async () => ({
    ok: true,
    data: {
      connections: [
        {
          nombre: "cert",
          server_name: "cert",
          dsn_var: "DB_CERT_DSN",
          dsn_visible: true,
          instalado: {
            claude: "no",
            codex: "no",
            warp: "no",
            gemini: "no",
            opencode: "no",
            crush: "no",
          },
        },
        {
          nombre: "prod",
          server_name: "prod",
          dsn_var: "DB_PROD_DSN",
          dsn_visible: true,
          instalado: {
            claude: "si",
            codex: "no",
            warp: "no",
            gemini: "no",
            opencode: "no",
            crush: "no",
          },
        },
      ],
    },
  })),
}));

import { McpTab } from "../../src/cli/tui/tabs/mcp-tab.js";
import type { CliContext } from "../../src/cli/types.js";

const ctx = {} as unknown as CliContext;
const ENTER = "\r";
const tick = () => new Promise((r) => setTimeout(r, 80));

describe("McpTab — user-scope install", () => {
  it("shows the real per-connection user-scope install status (not a static pill)", async () => {
    const { lastFrame } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cert");
    expect(frame).toContain("prod");
    // prod is installed in the user-scope ~/.claude.json → "installed" pill.
    expect(frame).toContain("installed");
  });

  it("offers 'Install → user scope' in the detail panel of an uninstalled connection", async () => {
    const { lastFrame, stdin } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER); // open detail on the focused (first) row = cert, status "no"
    await tick();
    expect(lastFrame() ?? "").toContain("Install → user scope");
  });

  it("guides add → alias → DSN (suggested) → review with save+install before committing", async () => {
    const { lastFrame, stdin } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    stdin.write("a"); // open the add wizard
    await tick();
    stdin.write("reporting"); // step 1: alias
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER); // step 2: accept the suggested DSN var default
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("reporting");
    expect(frame).toContain("DB_REPORTING_DSN"); // suggested from the alias
    expect(frame.toLowerCase()).toContain("save + install"); // review step, not yet saved
  });
});
