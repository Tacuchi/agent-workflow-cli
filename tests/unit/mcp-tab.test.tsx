import type { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Mock the data boundary so we can render populated states without touching the
// real profile.json. `selfMcpConfig` is the only runtime import the tab uses for
// data; `list` (refresh) is the only action these tests exercise.
vi.mock("../../src/application/self/mcp-config.js", () => ({
  selfMcpConfig: vi.fn(async () => {
    const status = (state: string) => ({
      state,
      entry_state: state === "registered" ? "missing" : "current",
      launchable: state === "launchable" || state === "host-load-observed",
      reload_required: false,
    });
    const hostStatus = (claude = "registered") => ({
      claude: status(claude),
      codex: status("registered"),
      warp: status("registered"),
      gemini: status("registered"),
      opencode: status("registered"),
      crush: status("registered"),
      kimi: status("registered"),
    });
    return {
      ok: true,
      data: {
        connections: [
          {
            nombre: "alpha",
            server_name: "alpha",
            dsn_var: "ALPHA_DATABASE_URL",
            dsn_visible: true,
            instalado: {
              claude: "no",
              codex: "no",
              warp: "no",
              gemini: "no",
              opencode: "no",
              crush: "no",
              kimi: "no",
            },
            host_status: hostStatus(),
          },
          {
            nombre: "beta",
            server_name: "beta",
            dsn_var: "BETA_DATABASE_URL",
            dsn_visible: true,
            instalado: {
              claude: "si",
              codex: "no",
              warp: "no",
              gemini: "no",
              opencode: "no",
              crush: "no",
              kimi: "no",
            },
            host_status: hostStatus("host-load-observed"),
          },
        ],
      },
    };
  }),
}));

import { selfMcpConfig } from "../../src/application/self/mcp-config.js";
import { INSTALLABLE_MCP_HOSTS, mcpHostLabel } from "../../src/cli/tui/tabs/mcp-tab-helpers.js";
import { McpTab } from "../../src/cli/tui/tabs/mcp-tab.js";
import type { CliContext } from "../../src/cli/types.js";

// The tab reads the home through the env port, like the backend that builds the
// paths it shows — so the frame is deterministic and never depends on the real home.
const ctx = { env: { homeDir: () => "/home/test" } } as unknown as CliContext;
const ENTER = "\r";
const DOWN = "\x1B[B";
const tick = () => new Promise((r) => setTimeout(r, 80));

function registeredHostStatus() {
  return {
    claude: {
      state: "registered",
      entry_state: "missing",
      launchable: false,
      reload_required: false,
    },
    codex: {
      state: "registered",
      entry_state: "missing",
      launchable: false,
      reload_required: false,
    },
    warp: {
      state: "registered",
      entry_state: "missing",
      launchable: false,
      reload_required: false,
    },
    gemini: {
      state: "registered",
      entry_state: "missing",
      launchable: false,
      reload_required: false,
    },
    opencode: {
      state: "registered",
      entry_state: "missing",
      launchable: false,
      reload_required: false,
    },
    crush: {
      state: "registered",
      entry_state: "missing",
      launchable: false,
      reload_required: false,
    },
    kimi: {
      state: "registered",
      entry_state: "missing",
      launchable: false,
      reload_required: false,
    },
  };
}

describe("McpTab — user-scope install", () => {
  it("agrega el estado de todos los hosts, no sólo el de Codex", async () => {
    const { lastFrame } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("host loaded 1/7");
    expect(frame).toContain("1 host loaded · 6 registered");
  });

  it("offers the host picker in the detail panel of an uninstalled connection", async () => {
    const { lastFrame, stdin } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER); // open detail on the focused (first) row = alpha, status "no"
    await tick();
    expect(lastFrame() ?? "").toContain("Install in host…");
  });

  it("marca el fallback directo como específico de Codex", async () => {
    const { lastFrame, stdin } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = (lastFrame() ?? "").replace(/[│]/g, "").replace(/\s+/g, " ");
    expect(frame).toContain("Fallback directo de Codex (MCP opcional)");
    expect(frame).toContain(
      "agent-workflow tool call execute_sql --connection alpha --input-json -",
    );
  });

  it("explica el conflicto: nombra el archivo de la entrada ajena y qué hacer con ella", async () => {
    // The user's own 'gamma' lives in Claude's historical settings file. The
    // detail must say WHICH file and that Workline will not touch it — a bare
    // "conflict" leaves the person guessing whether it is even a problem.
    const conflicted = {
      nombre: "gamma",
      server_name: "gamma",
      dsn_var: "GAMMA_DATABASE_URL",
      dsn_visible: true,
      instalado: {
        claude: "drift",
        codex: "no",
        warp: "no",
        gemini: "no",
        opencode: "no",
        crush: "no",
        kimi: "no",
      },
      host_status: {
        ...registeredHostStatus(),
        claude: {
          state: "conflict",
          entry_state: "foreign",
          launchable: false,
          reload_required: false,
          target: "/home/test/.claude/settings.json",
        },
      },
    };
    vi.mocked(selfMcpConfig).mockResolvedValueOnce({
      ok: true,
      data: { connections: [conflicted] },
    } as never);

    const { lastFrame, stdin } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = (lastFrame() ?? "").replace(/[│]/g, "").replace(/\s+/g, " ");
    expect(frame).toContain("Claude Code: conflict · ajena en ~/.claude/settings.json");
    expect(frame).toContain("Acción: la entrada 'gamma' marcada ajena no la escribió Workline");
  });

  it("una entrada de otra versión dice de dónde salió y que se arregla reinstalando", async () => {
    // After a CLI upgrade the descriptor is still ours, one release behind. The
    // panel must not leave the reader with a bare "legacy" and reload hints that
    // cannot change a file.
    const stale = {
      nombre: "delta",
      server_name: "delta",
      dsn_var: "DELTA_DATABASE_URL",
      dsn_visible: true,
      instalado: {
        claude: "drift",
        codex: "no",
        warp: "no",
        gemini: "no",
        opencode: "no",
        crush: "no",
        kimi: "no",
      },
      host_status: {
        ...registeredHostStatus(),
        claude: {
          state: "legacy",
          entry_state: "known-legacy",
          legacy_kind: "generation",
          launchable: false,
          reload_required: true,
          target: "/home/test/.claude.json",
        },
      },
    };
    vi.mocked(selfMcpConfig).mockResolvedValueOnce({
      ok: true,
      data: { connections: [stale] },
    } as never);

    const { lastFrame, stdin } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = (lastFrame() ?? "").replace(/[│]/g, "").replace(/\s+/g, " ");
    expect(frame).toContain("Claude Code: legacy · de otra versión en ~/.claude.json");
    expect(frame).toContain("Acción: Claude Code quedó con un descriptor de otra versión");
    expect(frame).toContain("reinstalá");
    // Reinstalling is what install actually does here, so it must not send the
    // reader to the migration instead.
    expect(frame).not.toContain("mcp migrate");
  });

  it("un descriptor histórico manda a la migración, no a reinstalar", async () => {
    // Install refuses this shape on purpose: only `mcp migrate` replaces it,
    // and it previews what it overwrites. Telling the reader to reinstall would
    // be advice the code is built to reject.
    const historic = {
      nombre: "epsilon",
      server_name: "epsilon",
      dsn_var: "EPSILON_DATABASE_URL",
      dsn_visible: true,
      instalado: {
        claude: "drift",
        codex: "no",
        warp: "no",
        gemini: "no",
        opencode: "no",
        crush: "no",
        kimi: "no",
      },
      host_status: {
        ...registeredHostStatus(),
        claude: {
          state: "legacy",
          entry_state: "known-legacy",
          legacy_kind: "historic",
          launchable: false,
          reload_required: true,
          target: "/home/test/.claude.json",
        },
      },
    };
    vi.mocked(selfMcpConfig).mockResolvedValueOnce({
      ok: true,
      data: { connections: [historic] },
    } as never);

    const { lastFrame, stdin } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = (lastFrame() ?? "").replace(/[│]/g, "").replace(/\s+/g, " ");
    expect(frame).toContain("Claude Code: legacy · descriptor histórico en ~/.claude.json");
    expect(frame).toContain("Acción: Claude Code conserva un descriptor histórico");
    expect(frame).toContain("mcp migrate");
    expect(frame).not.toContain("reinstalá la conexión desde este panel");
  });

  it("un remove que falla muestra el resumen del backend, no el error crudo", async () => {
    const onToast = vi.fn();
    const { stdin } = render(<McpTab ctx={ctx} isActive onToast={onToast} />);
    await tick();
    stdin.write(ENTER); // detail of alpha
    await tick();
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN); // Install → Test → Edit → Remove
      await tick();
    }
    stdin.write(ENTER); // confirm banner
    await tick();
    // The next backend call is the remove itself: a real write error keeps the
    // connection, and the summary — not a pointer to JSON fields the TUI never
    // shows — is what the person can act on.
    vi.mocked(selfMcpConfig).mockResolvedValueOnce({
      ok: false,
      data: {
        action: "remove",
        connection: null,
        summary:
          "Eliminación parcial de 'alpha'. Se conservó la entrada ajena homónima en: Codex (~/.codex/config.toml).",
      },
      error: {
        code: "MCP_REMOVE_PARTIAL",
        message:
          "1 error(es) y 1 conflicto(s) durante remove; ver data.remove.errors y data.remove.conflicts",
      },
      exitCode: 1,
    } as never);
    stdin.write("y");
    await tick();

    const failed = onToast.mock.calls
      .map(([toast]) => toast as { tone: string; body?: string })
      .find((toast) => toast.tone === "err");
    expect(failed?.body).toContain("Eliminación parcial de 'alpha'");
    expect(failed?.body).not.toContain("ver data.remove");
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

  it("windows the connections list to the viewport and keeps the last row reachable", async () => {
    // 40 connections overflow a rows=20 viewport (the chrome reserves 22 rows).
    const many = Array.from({ length: 40 }, (_, i) => ({
      nombre: `db-${String(i + 1).padStart(2, "0")}`,
      server_name: `srv-${i + 1}`,
      dsn_var: `DB_${String(i + 1).padStart(2, "0")}_DSN`,
      dsn_visible: true,
      instalado: {
        claude: "no",
        codex: "no",
        warp: "no",
        gemini: "no",
        opencode: "no",
        crush: "no",
        kimi: "no",
      },
      host_status: registeredHostStatus(),
    }));
    // One-shot override of the module mock above — consumed by the mount refresh.
    vi.mocked(selfMcpConfig).mockResolvedValueOnce({
      ok: true,
      data: { connections: many },
    } as never);

    const { lastFrame, stdin, stdout } = render(<McpTab ctx={ctx} isActive />);
    await tick();
    // ink-testing-library's fake stdout has no `rows`: fake a 20-row TTY + resize.
    const fake = stdout as EventEmitter & { rows?: number };
    fake.rows = 20;
    fake.emit("resize");
    await tick();

    for (let i = 0; i < 39; i++) {
      stdin.write(DOWN);
      await tick();
    }

    const frame = lastFrame() ?? "";
    expect(frame).toContain("db-40"); // the cursor reached the last connection
    expect(frame).not.toContain("db-01"); // the top of the list scrolled out
    expect(frame.split("\n").length).toBeLessThanOrEqual(20);
    expect(frame).toContain("de 40"); // range indicator in the SectionHead hint
  }, 15000);

  // Un host apagado en [Config] es un opt-out de targeting: ofrecer instalarle
  // un MCP contradice la única pantalla desde la que se apaga.
  describe("hosts apagados en [Config]", () => {
    async function openHostPicker(disabledHosts?: readonly string[]): Promise<string> {
      const { lastFrame, stdin, unmount } = render(
        <McpTab ctx={ctx} isActive {...(disabledHosts ? { disabledHosts } : {})} />,
      );
      await tick();
      stdin.write(ENTER); // detail de la primera conexión
      await tick();
      stdin.write(ENTER); // acción por defecto: instalar → abre el selector de host
      await tick();
      const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
      unmount();
      return frame;
    }

    it("el selector no ofrece el host apagado y sí los demás", async () => {
      const frame = await openHostPicker(["claude"]);
      expect(frame).toContain("INSTALL ALPHA INTO…");
      expect(frame).not.toContain(mcpHostLabel("claude"));
      expect(frame).toContain(mcpHostLabel("codex"));
      expect(frame).toContain(`INSTALL ALPHA INTO… ${INSTALLABLE_MCP_HOSTS.length - 1}`);
    });

    it("con todos apagados lo dice, en vez de mostrar una lista vacía", async () => {
      const frame = await openHostPicker([...INSTALLABLE_MCP_HOSTS]);
      expect(frame).toContain("every MCP host is off in [Config]");
    });

    it("sin nada apagado el selector ofrece el catálogo entero", async () => {
      const frame = await openHostPicker();
      expect(frame).toContain(mcpHostLabel("claude"));
      expect(frame).toContain(`INSTALL ALPHA INTO… ${INSTALLABLE_MCP_HOSTS.length}`);
    });
  });
});
