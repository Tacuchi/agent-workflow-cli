import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ProjectTab } from "../../src/cli/tui/tabs/project-tab.js";
import type { CliContext } from "../../src/cli/types.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const MARKERS = { start: "<!-- WORKFLOW-PROJECT-START -->", end: "<!-- WORKFLOW-PROJECT-END -->" };

function workspaceMd(): string {
  return [
    MARKERS.start,
    "## Proyecto",
    "",
    "WS",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    "| alpha | /src/alpha | certificacion |",
    "| beta | /src/beta | main |",
    "",
    "## Status",
    "",
    "- Ramas de trabajo actuales:",
    "  - alpha: feature/x",
    "  - beta: feature/y",
    MARKERS.end,
  ].join("\n");
}

function buildCtx(opts: { conflictOn?: string } = {}): CliContext {
  return {
    fs: {
      exists: async (p: string) => p === "/ws/CLAUDE.md",
      readText: async () => workspaceMd(),
    },
    env: {
      cwd: () => "/ws",
      homeDir: () => "/home",
      get: () => undefined,
    },
    git: {
      isGitRepo: async () => true,
      currentBranch: async () => "feature/x",
      changedFiles: async () => [],
      isMerging: async () => false,
      isDirty: async () => false,
      checkout: async () => {},
      pull: async () => {},
      push: async () => {},
      merge: async (_repo: string, from: string) =>
        from === opts.conflictOn
          ? { ok: false, conflicted: ["src/Foo.java"] }
          : { ok: true, conflicted: [] },
      conflictedFiles: async () => ["src/Foo.java"],
    },
    process: {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    paths: {
      workspaceDir: () => "/ws",
      blockMarkers: () => MARKERS,
    },
  } as unknown as CliContext;
}

describe("ProjectTab — navegación de sources + panel lateral de acciones", () => {
  it("renderiza las sources como lista navegable con una fila 'all sources'", async () => {
    const { lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Workspace");
    expect(f).toContain("SOURCES");
    expect(f).toContain("alpha");
    expect(f).toContain("beta");
    expect(f).toContain("all sources");
  });

  it("abre el panel lateral con las 3 acciones al seleccionar una fuente (⏎)", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // abre detail sobre la fuente enfocada (alpha)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("ACTIONS");
    expect(f).toContain("Alinear con PROD");
    expect(f).toContain("Enviar a QA");
    expect(f).toContain("Enviar a PROD");
  });

  it("ejecuta 'Alinear con PROD' (sync) sobre la fuente y muestra el resultado", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // abre panel
    await tick();
    stdin.write(ENTER); // ejecuta acción enfocada = Alinear con PROD (sync)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("completed");
    expect(f).toContain("merge prod→work");
  });

  it("permite seleccionar 'all sources' y abrir el panel aplicado a todas", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(DOWN); // alpha → beta
    stdin.write(DOWN); // beta → all sources
    await tick();
    stdin.write(ENTER); // abre panel para "all sources"
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("ACTIONS");
    expect(f).toContain("git flow"); // meta del panel: "git flow · 2 fuentes"
    expect(f).toContain("fuentes");
  });
});
