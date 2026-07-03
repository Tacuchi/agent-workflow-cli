import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/cli/tui/app.js";
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
  /** Observe every process.run call (cmd/args/opts) — used to assert spawn env. */
  onRun?: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ) => void;
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
      run: async (
        cmd: string,
        args: string[] = [],
        runOpts?: { cwd?: string; env?: Record<string, string> },
      ) => {
        opts.onRun?.(cmd, args, runOpts);
        if (opts.npmThrows && cmd === "npm") {
          throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
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
      userMcpConnectionsFile: () => "/tmp/non-existent-conns.json",
      userDsnFile: () => "/tmp/non-existent-dsn.env",
      userRoot: () => "/home/test/.workflow",
      cwdRoot: () => "/home/test/project",
      userRuntimeJson: () => "/tmp/runtime.json",
      userLibConfigDir: () => "/home/test/.workflow",
      cwdHistoryFile: () => "/home/test/project/.workflow/HISTORY.md",
      cwdSessionsDir: () => "/home/test/project/.workflow/sessions",
      blockMarkers: () => ({ start: "<!-- AW-PROJECT-START -->", end: "<!-- AW-PROJECT-END -->" }),
    } as never,
  } as unknown as CliContext;
}

describe("App (tab-home)", () => {
  it("boot muestra la Status tab por default (sin palette)", async () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    // Esperar a que el effect de boot resuelva projectName (basename del cwd mock).
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    // post-v9.2.0: la palette es overlay opt-in (^K). El boot renderiza la
    // TabBar + StatusTab directamente — no search input ni "Go to <Tab>".
    expect(frame).not.toContain("type to filter");
    expect(frame).not.toContain("Go to Status");
    // Brand dinámico: en el mock cwd="/home/test/project" y fs.exists=false,
    // por lo que resolveProjectName cae al basename "project".
    expect(frame).toContain("project");
    expect(frame).toContain("v9.9.9");
    expect(frame).toContain("Status");
    expect(frame).toContain("Workflows");
  });

  it("HomeHeader expone workspace context", async () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    // HomeHeader renderiza brand dinámico (basename del cwd mock = "project")
    // en línea 1 y branch + sessions placeholders en línea 2 mientras hidrata.
    expect(frame).toContain("project");
    expect(frame).toMatch(/sessions/);
  });

  it("número 2 desde la Status tab salta a Workflows tab (admin por host + strip de flows)", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("2");
    await new Promise((r) => setTimeout(r, 50));
    // [Workflows] monta la administración por host (SectionHead "HOSTS") y el
    // informativo compacto de flows.
    expect(lastFrame()).toContain("HOSTS");
    expect(lastFrame()).toContain("Flows:");
  });

  it("número 5 desde la Status tab salta a Skills tab (administrador de sueltas)", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("5");
    await new Promise((r) => setTimeout(r, 100));
    // [Skills] renderiza la lista única con las recomendadas de la semilla.
    expect(lastFrame()).toContain("recommended");
    expect(lastFrame()).toContain("add skill");
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
    // El check de arranque falló (offline) → NO hay toast rojo "Update check failed"…
    expect(frame).not.toContain("Update check failed");
    // …pero sí queda una traza durable en el log operativo diario.
    expect(logged.some((l) => l.level === "warn" && l.msg.includes("update check"))).toBe(true);
  });

  it("marca el spawn re-entrante de `aw sessions` como interno (finding sessions-reentrant-log)", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const ctx = buildCtx({
      onRun: (cmd, args, runOpts) => calls.push({ cmd, args, env: runOpts?.env }),
    });
    render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 60));
    const sessCall = calls.find((c) => c.args[0] === "sessions");
    expect(sessCall).toBeDefined();
    // El env pasa AW_INTERNAL_CALL=1 (main.ts silencia el logger) y conserva el
    // resto del entorno (PATH, etc.) para que el hijo `aw` pueda ejecutarse.
    expect(sessCall?.env?.AW_INTERNAL_CALL).toBe("1");
    expect(Object.keys(sessCall?.env ?? {}).length).toBeGreaterThan(1);
  });

  // ESC se referencia para asegurar el import del byte ESC en el test bundle.
  it("constante ESC del módulo está definida", () => {
    expect(ESC).toBeDefined();
    expect(ENTER).toBe("\r");
    expect(TAB).toBe("\t");
  });
});
