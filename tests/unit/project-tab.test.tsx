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
  opts: { conflictOn?: string; logger?: FakeLogger; failGit?: boolean } = {},
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
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
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

// Réplica del overhead horizontal del frame real (ScreenFrame + Box del tab):
// 12 cells (2 bordes + 2×2 paddingX, por 2 boxes). Sin este frame el tab dispone
// de más ancho que el que asume `computeRowWidth`, y el bug de interlineado NO
// aparece — por eso los tests que renderizan el tab "pelado" nunca lo detectaron.
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
    stdin.write(ENTER); // abre panel (acción 0 = Lanzar en local)
    await tick();
    stdin.write(DOWN); // baja a "Alinear con PROD" (sync)
    await tick();
    stdin.write(ENTER); // ejecuta sync
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("completed");
    expect(f).toContain("merge prod→work");
  });

  it("loguea el outcome de git-flow en el log operativo (finding tui-actions-not-logged)", async () => {
    const logger = fakeLogger();
    const { stdin } = render(<ProjectTab ctx={buildCtx({ logger })} isActive />);
    await tick();
    stdin.write(ENTER); // abre panel (acción 0 = Lanzar en local)
    await tick();
    stdin.write(DOWN); // baja a "Alinear con PROD" (sync)
    await tick();
    stdin.write(ENTER); // ejecuta sync
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
    // 1) Cada warning de subfetch parcial se vuelca al log operativo (ctx.logger.warn).
    const warn = logger.lines.find((l) => l.level === "warn" && l.msg.includes("workspace data"));
    expect(warn).toBeDefined();
    expect(warn?.msg).toContain("git exploded");
    // 2) El tab muestra un aviso visible de datos parciales (antes se descartaban).
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
    stdin.write(ENTER); // abre panel para "all sources"
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("ACTIONS");
    expect(f).toContain("git flow"); // meta del panel: "git flow · 2 fuentes"
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
    // Primeras apariciones = los rows de la lista SOURCES (alpha arriba de beta).
    const alphaIdx = lines.findIndex((l) => l.includes("alpha"));
    const betaIdx = lines.findIndex((l) => l.includes("beta"));
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    // alpha y beta son source rows consecutivos. Si el row se construye más ancho
    // que su contenedor, Yoga lo envuelve y mete una línea extra (diff 2). Sin el
    // bug, son adyacentes (diff 1).
    expect(betaIdx - alphaIdx).toBe(1);
  });
});

// ===== F3 — lanzamiento + administración de procesos =====

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

  it("'Lanzar en local' aparece deshabilitada (sin descriptor) en el panel de una fuente", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // abre el panel sobre alpha (sin descriptor en este ctx)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Lanzar en local");
    // El hint inline se trunca al ancho del panel ("sin descrip…"); el hint completo
    // aparece en el aviso al activarla (ver test siguiente).
    expect(f).toContain("sin descrip");
  });

  it("intentar lanzar sin descriptor muestra el hint /w:workspace-init", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // panel
    await tick();
    stdin.write(ENTER); // acción 0 = Lanzar en local (no launchable)
    await tick();
    expect(lastFrame() ?? "").toContain("/w:workspace-init");
  });

  it("lista un proceso en ejecución, muestra el tile en 1 y entra al modo procesos con 'p'", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    let f = lastFrame() ?? "";
    expect(f).toContain("PID 4242");
    expect(f).toContain("running");
    stdin.write("p"); // entra al modo procesos
    await tick();
    f = lastFrame() ?? "";
    expect(f).toContain("stop"); // hint de acciones del modo procesos
    expect(f).toContain("relaunch");
  });

  it("una fuente con descriptor habilita 'Lanzar en local'", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // panel sobre alpha (launchable en este ctx)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Lanzar en local");
    // Habilitada: NO muestra el hint de "sin descriptor" (la desc se trunca al ancho del panel).
    expect(f).not.toContain("sin descriptor");
  });

  it("lanzar una fuente ya en ejecución (mismo perfil) muestra la pantalla de colisión", async () => {
    // alpha: descriptor sin perfiles/params (lanza directo, profile null) + proceso vivo profile null.
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
    stdin.write(ENTER); // panel sobre alpha
    await tick();
    stdin.write(ENTER); // acción 0 = Lanzar en local → lanza directo (sin perfiles/params)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Ya corre alpha");
    expect(f).toContain("re-lanzar");
  });

  it("sin workspace inicializado: NO ofrece Lanzar ni la sección de procesos (AC12)", async () => {
    // fs.exists=false → no hay bloque WORKSPACE → landing NotInitialized.
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
