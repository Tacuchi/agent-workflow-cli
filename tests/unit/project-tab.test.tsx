import { Box } from "ink";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
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

interface FakeLogger {
  lines: { level: string; msg: string }[];
  info: (m: string) => Promise<void>;
  warn: (m: string) => Promise<void>;
  error: (m: string) => Promise<void>;
  log: (level: string, m: string) => Promise<void>;
}

function fakeLogger(): FakeLogger {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    info: async (m) => void lines.push({ level: "info", msg: m }),
    warn: async (m) => void lines.push({ level: "warn", msg: m }),
    error: async (m) => void lines.push({ level: "error", msg: m }),
    log: async (level, m) => void lines.push({ level, msg: m }),
  };
}

function buildCtx(
  opts: {
    conflictOn?: string;
    logger?: FakeLogger;
    failGit?: boolean;
    /** stdout of the own-commit counter per BASE ref; absent base = unknown revision. */
    ownCommits?: Record<string, string>;
  } = {},
): CliContext {
  return {
    logger: opts.logger,
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
      isGitRepo: async () => {
        if (opts.failGit) throw new Error("git exploded");
        return true;
      },
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
      run: async (_cmd: string, args: string[]) => {
        if (args.includes("rev-list") && args.includes("--no-merges")) {
          const base = (args[args.length - 1] ?? "").split("..")[0] ?? "";
          const stdout = opts.ownCommits?.[base];
          return stdout === undefined
            ? { code: 128, stdout: "", stderr: "unknown revision" }
            : { code: 0, stdout, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    paths: {
      workspaceDir: () => "/ws",
      blockMarkers: () => MARKERS,
      cwdProcessesFile: () => "/ws/.workflow/processes.json",
      cwdDocsLogsDir: () => "/ws/docs/logs",
      cwdLaunchDir: () => "/ws/.workflow/launch",
    },
  } as unknown as CliContext;
}

// Replica of the real frame's horizontal overhead (ScreenFrame + tab Box):
// 12 cells (2 borders + 2×2 paddingX, times 2 boxes). Without this frame the tab
// gets more width than `computeRowWidth` assumes and the line-spacing bug does NOT
// show up — which is why tests rendering the "bare" tab never caught it.
function Framed({ children }: { children: ReactNode }) {
  return (
    <Box borderStyle="bold" paddingX={2}>
      <Box borderStyle="single" paddingX={2}>
        {children}
      </Box>
    </Box>
  );
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

  /** The rendered row of a source, so assertions cannot pass on chrome elsewhere. */
  function rowOf(frame: string, alias: string): string {
    return frame.split("\n").find((l) => l.includes(alias)) ?? "";
  }

  it("pinta el contador de commits propios ANTES del chip dirty/in sync", async () => {
    // alpha está sobre `certificacion` (resuelve); beta sobre `main` (no resuelve).
    const { lastFrame } = render(
      <ProjectTab ctx={buildCtx({ ownCommits: { certificacion: "4\n" } })} isActive />,
    );
    await tick();
    const f = lastFrame() ?? "";
    expect(rowOf(f, "alpha")).toMatch(/\+4\s+in sync/);
    expect(rowOf(f, "beta")).toMatch(/—\s+in sync/);
  });

  it("pinta «—» en ambas filas cuando el contador no se puede medir", async () => {
    const { lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(rowOf(f, "alpha")).toMatch(/—\s+in sync/);
    expect(rowOf(f, "beta")).toMatch(/—\s+in sync/);
    expect(rowOf(f, "alpha")).not.toContain("+");
  });

  it("pinta «+0» cuando la rama no aporta commits (distinto de «no medible»)", async () => {
    const { lastFrame } = render(
      <ProjectTab ctx={buildCtx({ ownCommits: { certificacion: "0\n" } })} isActive />,
    );
    await tick();
    expect(rowOf(lastFrame() ?? "", "alpha")).toMatch(/\+0\s+in sync/);
  });

  it("abre el panel lateral con las 3 acciones al seleccionar una fuente (⏎)", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // open detail on the focused source (alpha)
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
    stdin.write(ENTER); // open panel (action 0 = "Lanzar en local")
    await tick();
    stdin.write(DOWN); // move down to "Alinear con PROD" (sync)
    await tick();
    stdin.write(ENTER); // run sync
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("completed");
    expect(f).toContain("merge prod→work");
  });

  it("loguea el outcome de git-flow en el log operativo (finding tui-actions-not-logged)", async () => {
    const logger = fakeLogger();
    const { stdin } = render(<ProjectTab ctx={buildCtx({ logger })} isActive />);
    await tick();
    stdin.write(ENTER); // open panel (action 0 = "Lanzar en local")
    await tick();
    stdin.write(DOWN); // move down to "Alinear con PROD" (sync)
    await tick();
    stdin.write(ENTER); // run sync
    await tick();
    const flow = logger.lines.find((l) => l.msg.includes("git-flow sync"));
    expect(flow).toBeDefined();
    expect(flow?.level).toBe("info");
    expect(flow?.msg).toContain("→ ok");
  });

  it("loguea y muestra las advertencias de fetch parcial del workspace (finding project-tab-warnings)", async () => {
    const logger = fakeLogger();
    const { lastFrame } = render(<ProjectTab ctx={buildCtx({ logger, failGit: true })} isActive />);
    await tick();
    // 1) Every partial-subfetch warning goes to the operational log (ctx.logger.warn).
    const warn = logger.lines.find((l) => l.level === "warn" && l.msg.includes("workspace data"));
    expect(warn).toBeDefined();
    expect(warn?.msg).toContain("git exploded");
    // 2) The tab shows a visible partial-data notice (these used to be silently dropped).
    const f = lastFrame() ?? "";
    expect(f).toContain("advertencia");
    expect(f).toContain("datos parciales");
  });

  it("QuickActions ofrece 'git status' y ya no el stub 'start session' (finding stub-quick-actions)", async () => {
    const { lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("git status");
    expect(f).not.toContain("start session");
  });

  it("permite seleccionar 'all sources' y abrir el panel aplicado a todas", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(DOWN); // alpha → beta
    stdin.write(DOWN); // beta → all sources
    await tick();
    stdin.write(ENTER); // open panel for "all sources"
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("ACTIONS");
    expect(f).toContain("git flow"); // panel meta: "git flow · 2 fuentes"
    expect(f).toContain("fuentes");
  });

  it("no inserta línea en blanco entre source rows con el panel cerrado (regresión interlineado)", async () => {
    const { lastFrame } = render(
      <Framed>
        <ProjectTab ctx={buildCtx()} isActive />
      </Framed>,
    );
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    // First occurrences = the SOURCES list rows (alpha above beta).
    const alphaIdx = lines.findIndex((l) => l.includes("alpha"));
    const betaIdx = lines.findIndex((l) => l.includes("beta"));
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    // alpha and beta are consecutive source rows. If a row is built wider than
    // its container, Yoga wraps it and inserts an extra line (diff 2). Without
    // the bug they are adjacent (diff 1).
    expect(betaIdx - alphaIdx).toBe(1);
  });
});

// ===== F3 — launching + process administration =====

const ALPHA_DESCRIPTOR = JSON.stringify({
  version: 1,
  source: "alpha",
  stack: "npm",
  cwd: "/src/alpha",
  command: "npm",
  args: ["run", "dev"],
  params: [],
  profiles: ["dev"],
});

const RUNNING_PROCESS = JSON.stringify([
  {
    id: "alpha__dev__4242",
    sourceAlias: "alpha",
    profile: "dev",
    command: "npm",
    args: ["run", "dev"],
    pid: 4242,
    startedAt: "2026-06-23T09:15:00.000Z",
    logPath: "/ws/docs/logs/alpha-dev.log",
    state: "running",
  },
]);

/** ctx where alpha has a launch descriptor and one running process is registered. */
function buildLaunchCtx(): CliContext {
  return {
    fs: {
      exists: async (p: string) =>
        p === "/ws/CLAUDE.md" ||
        p === "/ws/.workflow/launch/alpha/launch.json" ||
        p === "/ws/.workflow/processes.json",
      readText: async (p: string) => {
        if (p === "/ws/.workflow/launch/alpha/launch.json") return ALPHA_DESCRIPTOR;
        if (p === "/ws/.workflow/processes.json") return RUNNING_PROCESS;
        return workspaceMd();
      },
    },
    env: { cwd: () => "/ws", homeDir: () => "/home", get: () => undefined },
    git: {
      isGitRepo: async () => true,
      currentBranch: async () => "feature/x",
      changedFiles: async () => [],
      isMerging: async () => false,
      isDirty: async () => false,
    },
    process: {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      isAlive: async () => true, // running record stays running → no reconcile write
    },
    paths: {
      workspaceDir: () => "/ws",
      blockMarkers: () => MARKERS,
      cwdProcessesFile: () => "/ws/.workflow/processes.json",
      cwdDocsLogsDir: () => "/ws/docs/logs",
      cwdLaunchDir: () => "/ws/.workflow/launch",
    },
  } as unknown as CliContext;
}

describe("ProjectTab — lanzamiento local + procesos en segundo plano", () => {
  it("renderiza la sección de procesos (vacía) y el tile 'procesos'", async () => {
    const { lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("PROCESOS LANZADOS");
    expect(f).toContain("procesos");
    expect(f).toContain("sin procesos");
  });

  it("'Lanzar en local' aparece deshabilitada (no lanzable) en el panel de una fuente", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // open the panel on alpha (no descriptor nor launchable source in this ctx)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Lanzar en local");
    // The inline description truncates to the panel width; the prefix is enough.
    expect(f).toContain("no lanzable");
  });

  it("intentar lanzar una fuente no lanzable avisa 'sin comando de arranque detectable'", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // panel
    await tick();
    stdin.write(ENTER); // action 0 = "Lanzar en local" (not launchable)
    await tick();
    expect(lastFrame() ?? "").toContain("sin comando de arranque detectable");
  });

  it("lista un proceso en ejecución, muestra el tile en 1 y entra al modo procesos con 'p'", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    let f = lastFrame() ?? "";
    expect(f).toContain("PID 4242");
    expect(f).toContain("running");
    stdin.write("p"); // enter processes mode
    await tick();
    f = lastFrame() ?? "";
    expect(f).toContain("stop"); // processes-mode actions hint
    expect(f).toContain("relaunch");
  });

  it("una fuente con descriptor habilita 'Lanzar en local'", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // panel on alpha (launchable in this ctx)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Lanzar en local");
    // Enabled: does NOT show the disabled description.
    expect(f).not.toContain("no lanzable");
  });

  it("lanzar una fuente ya en ejecución (mismo perfil) muestra la pantalla de colisión", async () => {
    // alpha: descriptor without profiles/params (launches directly, profile null) + live process with profile null.
    const ctx = {
      fs: {
        exists: async (p: string) =>
          p === "/ws/CLAUDE.md" ||
          p === "/ws/.workflow/launch/alpha/launch.json" ||
          p === "/ws/.workflow/processes.json",
        readText: async (p: string) => {
          if (p === "/ws/.workflow/launch/alpha/launch.json")
            return JSON.stringify({
              version: 1,
              source: "alpha",
              stack: "npm",
              cwd: "/src/alpha",
              command: "npm",
              args: ["start"],
              params: [],
              profiles: [],
            });
          if (p === "/ws/.workflow/processes.json")
            return JSON.stringify([
              {
                id: "alpha__default__7777",
                sourceAlias: "alpha",
                profile: null,
                command: "npm",
                args: ["start"],
                pid: 7777,
                startedAt: "2026-06-23T09:00:00.000Z",
                logPath: "/ws/docs/logs/alpha.log",
                state: "running",
              },
            ]);
          return workspaceMd();
        },
      },
      env: { cwd: () => "/ws", homeDir: () => "/home", get: () => undefined },
      git: {
        isGitRepo: async () => true,
        currentBranch: async () => "feature/x",
        changedFiles: async () => [],
      },
      process: {
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
        isAlive: async () => true,
      },
      paths: {
        workspaceDir: () => "/ws",
        blockMarkers: () => MARKERS,
        cwdProcessesFile: () => "/ws/.workflow/processes.json",
        cwdDocsLogsDir: () => "/ws/docs/logs",
        cwdLaunchDir: () => "/ws/.workflow/launch",
      },
    } as unknown as CliContext;

    const { stdin, lastFrame } = render(<ProjectTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER); // panel on alpha
    await tick();
    stdin.write(ENTER); // action 0 = "Lanzar en local" → launches directly (no profiles/params)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Ya corre alpha");
    expect(f).toContain("re-lanzar");
  });

  it("sin workspace inicializado: NO ofrece Lanzar ni la sección de procesos (AC12)", async () => {
    // fs.exists=false → no WORKSPACE block → NotInitialized landing.
    const ctx = {
      fs: { exists: async () => false, readText: async () => "" },
      env: { cwd: () => "/ws", homeDir: () => "/home", get: () => undefined },
      git: { isGitRepo: async () => false },
      process: {
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
        isAlive: async () => false,
      },
      paths: {
        workspaceDir: () => "/ws",
        blockMarkers: () => MARKERS,
        cwdProcessesFile: () => "/ws/.workflow/processes.json",
        cwdDocsLogsDir: () => "/ws/docs/logs",
        cwdLaunchDir: () => "/ws/.workflow/launch",
      },
    } as unknown as CliContext;

    const { lastFrame } = render(<ProjectTab ctx={ctx} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("not initialized"); // landing
    expect(f).not.toContain("Procesos lanzados");
    expect(f).not.toContain("Lanzar en local");
  });
});
