import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/cli/tui/app.js";
import { DEFAULT_TUI_PREFS, type TuiPrefs } from "../../src/cli/tui/tui-prefs.js";
import type { CliContext } from "../../src/cli/types.js";

const ENTER = "\r";
const TAB = "\t";
const ESC = "[";

interface CtxOpts {
  logger?: {
    info: (m: string) => Promise<void>;
    warn: (m: string) => Promise<void>;
    error: (m: string) => Promise<void>;
    log: (level: string, m: string) => Promise<void>;
  };
  /** When true, `npm view` (the boot update-check) rejects as if offline. */
  npmThrows?: boolean;
  statusJson?: string;
}

function buildCtx(opts: CtxOpts = {}): CliContext {
  return {
    ...(opts.logger ? { logger: opts.logger } : {}),
    fs: {
      exists: async () => false,
      readText: async () => "",
      mkdirp: async () => {},
      writeText: async () => {},
    } as never,
    env: {
      homeDir: () => "/home/test",
      cwd: () => "/home/test/project",
      get: () => undefined,
    },
    process: {
      run: async (cmd: string) => {
        if (opts.npmThrows && cmd === "npm") {
          throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
        }
        if (cmd === "agent-workflow") {
          return { code: 0, stdout: opts.statusJson ?? "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      which: async () => undefined,
    },
    git: {
      isGitRepo: async () => false,
      currentBranch: async () => undefined,
      changedFiles: async () => [],
    } as never,
    namespace: { namespace: "workflow", source: "default" as const },
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default" as const,
    },
    paths: {
      workspaceDir: () => "/home/test/project",
      userMcpConnectionsFile: () => "/tmp/non-existent-conns.json",
      userDsnFile: () => "/tmp/non-existent-dsn.env",
      userRoot: () => "/home/test/.workflow",
      cwdRoot: () => "/home/test/project",
      userRuntimeJson: () => "/tmp/runtime.json",
      userLibConfigDir: () => "/home/test/.workflow",
      cwdHistoryFile: () => "/home/test/project/.workflow/HISTORY.md",
      cwdSessionsDir: () => "/home/test/project/.workflow/sessions",
      cwdMarkerFile: () => "/home/test/project/.workflow/workline.json",
      cwdProcessesFile: () => "/home/test/project/.workflow/processes.json",
      cwdLockFile: () => "/home/test/project/.workflow/lock",
      blockMarkers: () => ({ start: "<!-- AW-HUB-START -->", end: "<!-- AW-HUB-END -->" }),
    } as never,
  } as unknown as CliContext;
}

describe("App (tab-home)", () => {
  it("boot muestra la Status tab por default (sin palette)", async () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    // Wait for the boot effect to resolve projectName (basename of the mocked cwd).
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    // The palette is an opt-in overlay (^K). Boot renders the TabBar + StatusTab
    // directly — no search input, no "Go to <Tab>".
    expect(frame).not.toContain("type to filter");
    expect(frame).not.toContain("Go to Status");
    // Dynamic brand: the mock has cwd="/home/test/project" and fs.exists=false,
    // so resolveProjectName falls back to the basename "project".
    expect(frame).toContain("project");
    expect(frame).toContain("v9.9.9");
    expect(frame).toContain("Status");
    expect(frame).toContain("Workline");
  });

  it("HomeHeader expone workspace context", async () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    // HomeHeader renders the dynamic brand (basename of the mocked cwd = "project")
    // on line 1, and branch + sessions placeholders on line 2 while hydrating.
    expect(frame).toContain("project");
    expect(frame).toMatch(/sessions/);
  });

  it("número 2 desde la Status tab salta a la Workline tab (admin por host + strip de flows)", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("2");
    await new Promise((r) => setTimeout(r, 50));
    // [Workline] mounts the per-host administration (SectionHead "HOSTS") and
    // the compact flows summary.
    expect(lastFrame()).toContain("HOSTS");
    expect(lastFrame()).toContain("Flows:");
  });

  it("proyecta el próximo paso del status público sin importar decisiones del motor", async () => {
    const ctx = buildCtx({
      statusJson: JSON.stringify({
        counts: {
          sessions_active: 1,
          sessions_closed: 2,
          sessions_paused: 0,
          sessions_abandoned: 0,
          pending: 1,
        },
        pipeline: [{ file: "docs/plans/021-plan.md", detail: { next: "revisar F3" } }],
      }),
    });
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("3 sessions · 1 active");
    stdin.write("2");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("1 pendientes");
    expect(lastFrame()).toContain("docs/plans/021-plan.md: revisar F3");
  });

  it("un status ilegible deja la navegación y la pestaña Git disponibles", async () => {
    const ctx = buildCtx({ statusJson: "not json" });
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("2");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("estado no disponible");
    expect(lastFrame()).toContain("Next: no disponible");
    stdin.write("3");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Hub");
    expect(lastFrame()).toContain("git");
  });

  it("número 5 abre Config sin acceso a catálogo ni gestor de terceros", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("5");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Config 11 settings");
    expect(lastFrame()).not.toContain("add skill");
  });

  it("una preferencia antigua initialScreen=skills abre Status sin reescribirla", async () => {
    const ctx = buildCtx();
    const write = vi.fn();
    ctx.fs.writeText = write;
    const legacy = { ...DEFAULT_TUI_PREFS, initialScreen: "skills" } as unknown as TuiPrefs;
    const { lastFrame } = render(
      <App version="9.9.9" ctx={ctx} initialPrefs={legacy} onResult={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toMatch(/loading status|hosts covered/);
    expect(lastFrame()).not.toContain("add skill");
    expect(write).not.toHaveBeenCalled();
  });

  it("'q' desde la Status tab resuelve con kind:exit", async () => {
    const ctx = buildCtx();
    const onResult = vi.fn();
    const { stdin } = render(<App version="9.9.9" ctx={ctx} onResult={onResult} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 50));
    expect(onResult).toHaveBeenCalledWith({ kind: "exit", exitCode: 0 });
  });

  it("boot update-check offline: no muestra toast de error, loguea al diario (finding update-check-offline-toast)", async () => {
    const logged: { level: string; msg: string }[] = [];
    const logger = {
      info: async () => {},
      warn: async (m: string) => void logged.push({ level: "warn", msg: m }),
      error: async () => {},
      log: async (level: string, m: string) => void logged.push({ level, msg: m }),
    };
    const ctx = buildCtx({ logger, npmThrows: true });
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 60));
    const frame = lastFrame() ?? "";
    // The boot check failed (offline) → NO red "Update check failed" toast…
    expect(frame).not.toContain("Update check failed");
    // …but a durable trace does land in the daily operational log.
    expect(logged.some((l) => l.level === "warn" && l.msg.includes("update check"))).toBe(true);
  });

  // Retired: "sessions-reentrant-log" — the header's sessions count is now
  // computed in-process via SessionsService (no `aw sessions` spawn, so no
  // AW_INTERNAL_CALL env to pin).

  // ESC is referenced to keep the ESC byte import alive in the test bundle.
  it("constante ESC del módulo está definida", () => {
    expect(ESC).toBeDefined();
    expect(ENTER).toBe("\r");
    expect(TAB).toBe("\t");
  });
});
