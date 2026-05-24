import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/cli/tui/app.js";

const ENTER = "\r";
const TAB = "\t";
const ESC = "[";

function buildCtx() {
  return {
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
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
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
  };
}

describe("App (tab-home)", () => {
  it("boot muestra la Status tab por default (sin palette)", () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    const frame = lastFrame() ?? "";
    // post-v9.2.0: la palette es overlay opt-in (^K). El boot renderiza la
    // TabBar + StatusTab directamente — no search input ni "Go to <Tab>".
    expect(frame).not.toContain("type to filter");
    expect(frame).not.toContain("Go to Status");
    expect(frame).toContain("agent-workflow");
    expect(frame).toContain("v9.9.9");
    expect(frame).toContain("Status");
    expect(frame).toContain("Workflow");
  });

  it("HomeHeader expone workspace context", () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    const frame = lastFrame() ?? "";
    // HomeHeader renderiza modeLabel (default agent-workflow · single-repo) + branch placeholder
    // mientras hidrata el workspace context async.
    expect(frame).toContain("agent-workflow");
    // sessions placeholder visible mientras carga.
    expect(frame).toMatch(/sessions/);
  });

  it("número 2 desde la Status tab salta a Workflow tab", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("2");
    await new Promise((r) => setTimeout(r, 50));
    // Workflow tab renderiza SectionHead "SESSION LIFECYCLE".
    expect(lastFrame()).toContain("SESSION LIFECYCLE");
  });

  it("número 5 desde la Status tab salta a Skills tab", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("5");
    await new Promise((r) => setTimeout(r, 50));
    // Skills tab renderiza SectionHead "HOSTS".
    expect(lastFrame()).toContain("HOSTS");
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

  // ESC se referencia para asegurar el import del byte ESC en el test bundle.
  it("constante ESC del módulo está definida", () => {
    expect(ESC).toBeDefined();
    expect(ENTER).toBe("\r");
    expect(TAB).toBe("\t");
  });
});
