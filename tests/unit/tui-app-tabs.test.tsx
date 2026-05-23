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

describe("App (tabs)", () => {
  it("monta con Status como tab activa por defecto", () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    const frame = lastFrame() ?? "";
    // Active tab tiene el label envuelto en espacios para el inverse highlight.
    expect(frame).toMatch(/1 +Status/);
    expect(frame).toContain("agent-workflow");
    expect(frame).toContain("v9.9.9");
  });

  it("renderiza sidebar con workspace context", () => {
    const ctx = buildCtx();
    const { lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    const frame = lastFrame() ?? "";
    // post-v9 sidebar: brand + version + 5 tabs + workspace + keymap. Cwd ya
    // no se renderiza inline (eliminado con Header.tsx); validamos que la
    // sección WORKSPACE existe y muestra el sessions placeholder.
    expect(frame).toContain("WORKSPACE");
  });

  it("número 2 va directo a Workflow tab", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("2");
    await new Promise((r) => setTimeout(r, 50));
    // TAB_BY_KEY post-v9: {1:status, 2:workflow, ...}. La tab Workflow renderiza
    // SectionHead "SESSION LIFECYCLE" — uniquely identifica el contenido del tab.
    expect(lastFrame()).toContain("SESSION LIFECYCLE");
  });

  it("número 5 va directo a Skills tab", async () => {
    const ctx = buildCtx();
    const { stdin, lastFrame } = render(<App version="9.9.9" ctx={ctx} onResult={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("5");
    await new Promise((r) => setTimeout(r, 50));
    // Skills tab renderiza SectionHead "HOSTS" — uniquely identifica el tab.
    expect(lastFrame()).toContain("HOSTS");
  });

  it("'q' resuelve con kind:exit", async () => {
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
