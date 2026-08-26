import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { InputLockProvider, useInputLock } from "../../src/cli/tui/input-lock.js";
import { ProjectTab } from "../../src/cli/tui/tabs/project-tab.js";
import type { CliContext } from "../../src/cli/types.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const ESC = "\x1B";
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const MARKERS = { start: "<!-- WORKFLOW-PROJECT-START -->", end: "<!-- WORKFLOW-PROJECT-END -->" };

/** ink-testing-library exposes `columns` as a getter: redefine it, then resize. */
function setCols(stdout: unknown, cols: number) {
  const fake = stdout as { emit(event: string): boolean };
  Object.defineProperty(fake, "columns", { value: cols, configurable: true });
  fake.emit("resize");
}

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
    // Declaradas para que "no se renderiza la lista QA" sea una aserción real.
    "- Ramas QA actuales:",
    "  - alpha: qa",
    MARKERS.end,
  ].join("\n");
}

/** Workspace block with `n` sources (s0..sN) and no Status section → empty branch lists. */
function workspaceMdWithSources(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `| s${i} | /src/s${i} | main |`);
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
    ...rows,
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
    /** When set, the workspace declares this many sources instead of alpha/beta. */
    sourceCount?: number;
  } = {},
): CliContext {
  const md =
    opts.sourceCount === undefined ? workspaceMd() : workspaceMdWithSources(opts.sourceCount);
  return {
    logger: opts.logger,
    fs: {
      exists: async (p: string) => p === "/ws/CLAUDE.md",
      readText: async () => md,
      // The process registry now serializes its read-modify-write on the
      // workspace lock, so the stub answers the lock's own calls too.
      mkdirp: async () => {},
      writeText: async () => {},
      writeTextExclusive: async () => ({ created: true }),
      remove: async () => {},
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
      cwdSessionsDir: () => "/ws/.workflow/sessions",
      cwdProcessesFile: () => "/ws/.workflow/processes.json",
      cwdLockFile: () => "/ws/.workflow/.lock",
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

  it("abre el panel lateral con las 4 acciones, en orden, al seleccionar una fuente (⏎)", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // open detail on the focused source (alpha)
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("ACTIONS");
    const ACTIONS = ["Alinear con PROD", "Enviar a Desarrollo", "Enviar a QA", "Enviar a PROD"];
    for (const a of ACTIONS) expect(f).toContain(a);
    // El orden es contractual (design SPEC 002): prod → dev → qa → prod.
    const positions = ACTIONS.map((a) => f.indexOf(a));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it("ejecuta 'Alinear con PROD' (sync) sobre la fuente y muestra el resultado", async () => {
    const { stdin, lastFrame, stdout } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    // `merge prod→work` es el ÚLTIMO paso del plan sync: con el ancho por
    // defecto la cadena no cabe y queda fuera de la ventana horizontal. Un
    // terminal ancho la muestra entera, que es lo que esta prueba afirma.
    setCols(stdout, 200);
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

  it("en el resultado ⏎ NO reejecuta, r sí y esc vuelve al listado recargando (spec 022 · 6)", async () => {
    // Las tres consecuencias en una sola prueba porque el riesgo es la COLISIÓN:
    // Ink entrega input a todos los hooks activos, así que una tecla con dos
    // handlers dispararía git dos veces sin que nada más lo delate.
    const logger = fakeLogger();
    // El reload no es un prop: `esc` dispara el `loadData` interno de la pestaña,
    // que se observa por la re-lectura real del workspace.
    const ctx = buildCtx({ logger });
    const fs = ctx.fs as unknown as { readText: (p: string) => Promise<string> };
    const readText = fs.readText.bind(fs);
    let reads = 0;
    fs.readText = async (p: string) => {
      reads += 1;
      return readText(p);
    };
    const { stdin, lastFrame } = render(<ProjectTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER); // abre el panel
    await tick();
    stdin.write(DOWN); // → Alinear con PROD
    await tick();
    stdin.write(ENTER); // ejecuta
    await tick();
    const runs = () => logger.lines.filter((l) => l.msg.includes("git-flow sync")).length;
    expect(runs()).toBe(1);
    expect(lastFrame() ?? "").toMatch(/alpha\s+ok/); // el resultado está montado

    stdin.write(ENTER); // ya no es alias de reejecución
    await tick();
    expect(runs()).toBe(1);

    stdin.write("r"); // la única reejecución/reanudación
    await tick();
    expect(runs()).toBe(2);

    const readsBeforeBack = reads;
    stdin.write(ESC);
    await tick();
    const back = lastFrame() ?? "";
    expect(back).toContain("SOURCES");
    expect(back).toContain("all sources");
    expect(reads).toBeGreaterThan(readsBeforeBack); // volver refresca
  });

  it("«Enviar a Desarrollo» despacha to-dev (no basta con que se llame así)", async () => {
    // El panel muestra NOMBRES pero despacha IDs: sin ejecutar la acción, cablearla
    // a `to-qa` renderiza idéntico y empujaría a la rama QA sin que nadie se entere.
    const logger = fakeLogger();
    const { stdin } = render(<ProjectTab ctx={buildCtx({ logger })} isActive />);
    await tick();
    stdin.write(ENTER); // abre el panel (acción 0 = "Lanzar en local")
    await tick();
    stdin.write(DOWN); // → Alinear con PROD
    await tick();
    stdin.write(DOWN); // → Enviar a Desarrollo
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(logger.lines.find((l) => l.msg.includes("git-flow to-dev"))).toBeDefined();
    expect(logger.lines.find((l) => l.msg.includes("git-flow to-qa"))).toBeUndefined();
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

  it("tampoco con el chip de procesos, que ensancha la fila (misma regresión)", async () => {
    const { lastFrame } = render(
      <Framed>
        <ProjectTab ctx={buildLaunchCtx()} isActive />
      </Framed>,
    );
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    const alphaIdx = lines.findIndex((l) => l.includes("alpha"));
    const betaIdx = lines.findIndex((l) => l.includes("beta"));
    expect(lines[alphaIdx]).toContain("● 1 running"); // la fila ancha es la de alpha
    expect(betaIdx - alphaIdx).toBe(1);
  });

  it("ventana: con 30 fuentes el frame queda acotado al viewport y el cursor alcanza 'all sources'", async () => {
    const { stdin, lastFrame, stdout } = render(
      <ProjectTab ctx={buildCtx({ sourceCount: 30 })} isActive />,
    );
    await tick();
    // Non-TTY (rows=0) renders all 31 rows; fake a 24-row viewport so the
    // window kicks in (useListWindow re-renders on `resize`).
    const fakeStdout = stdout as unknown as { rows?: number; emit(event: string): boolean };
    fakeStdout.rows = 24;
    fakeStdout.emit("resize");
    await tick();
    // Walk to the last target: the "all sources" sentinel (index 30 of 31).
    for (let i = 0; i < 30; i++) {
      stdin.write(DOWN);
      await tick(20);
    }
    const f = lastFrame() ?? "";
    // The focused row is always painted (the bug: the cursor walked onto rows
    // the shell clipped, so the user navigated blind).
    expect(f).toContain("all sources");
    // Bounded: the old code rendered all 31 list rows and blew past 24 lines.
    expect(f.split("\n").length).toBeLessThanOrEqual(24);
    // Range indicator next to the Sources head (en-dash, no extra row spent).
    expect(f).toContain("de 31");
  });

  it("cancelar «Quitar del workspace» (n) vuelve al panel de detalle, no a la lista", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // panel on alpha
    await tick();
    // Detail actions for a source: launch · 4 git-flow · remove (the last one).
    for (let i = 0; i < 5; i++) {
      stdin.write(DOWN);
      await tick(20);
    }
    stdin.write(ENTER); // → confirm-remove
    await tick();
    expect(lastFrame() ?? "").toContain("¿Quitar alpha del workspace?");
    stdin.write("n"); // cancel
    await tick();
    const f = lastFrame() ?? "";
    // Back to the detail panel (reference: mcp/skills tabs), not the bare list.
    expect(f).toContain("ACTIONS");
    expect(f).toContain("Quitar del workspace"); // the remove action, as panel item
    expect(f).not.toContain("¿Quitar alpha del workspace?"); // confirm screen gone
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

/** One entry of the process registry; `state` is what the row chip reads. */
function procRecord(
  alias: string,
  pid: number,
  state: "running" | "stopped" | "exited" = "running",
  profile: string | null = "dev",
) {
  return {
    id: `${alias}__${profile ?? "default"}__${pid}`,
    sourceAlias: alias,
    profile,
    command: "npm",
    args: ["run", "dev"],
    pid,
    startedAt: "2026-06-23T09:15:00.000Z",
    logPath: `/ws/docs/logs/${alias}-${pid}.log`,
    state,
  };
}

const RUNNING_PROCESS = JSON.stringify([procRecord("alpha", 4242)]);

/**
 * ctx where alpha has a launch descriptor and the given process registry.
 * `procOver` injects the kill/liveness pair a stop test needs (the default
 * never kills anything: no test but a stop one exercises it); `descriptorJson`
 * swaps the launch descriptor (default: with profiles → opens the form).
 */
function buildLaunchCtx(
  processesJson: string = RUNNING_PROCESS,
  procOver: Record<string, unknown> = {},
  descriptorJson: string = ALPHA_DESCRIPTOR,
): CliContext {
  return {
    fs: {
      exists: async (p: string) =>
        p === "/ws/CLAUDE.md" ||
        p === "/ws/.workflow/launch/alpha/launch.json" ||
        p === "/ws/.workflow/processes.json",
      readText: async (p: string) => {
        if (p === "/ws/.workflow/launch/alpha/launch.json") return descriptorJson;
        if (p === "/ws/.workflow/processes.json") return processesJson;
        return workspaceMd();
      },
      mkdirp: async () => {},
      writeText: async () => {},
      // The registry serializes its read-modify-write on the workspace lock.
      writeTextExclusive: async () => ({ created: true }),
      remove: async () => {},
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
      ...procOver,
    },
    paths: {
      workspaceDir: () => "/ws",
      blockMarkers: () => MARKERS,
      cwdSessionsDir: () => "/ws/.workflow/sessions",
      cwdProcessesFile: () => "/ws/.workflow/processes.json",
      cwdLockFile: () => "/ws/.workflow/.lock",
      cwdDocsLogsDir: () => "/ws/docs/logs",
      cwdLaunchDir: () => "/ws/.workflow/launch",
    },
  } as unknown as CliContext;
}

describe("ProjectTab — lock de teclas globales (homologación)", () => {
  function LockSpy() {
    const { locked } = useInputLock();
    return <Text>{`locked=${locked}`}</Text>;
  }

  it("el panel de detalle NO retiene el lock global (alineado con mcp/skills/host-admin)", async () => {
    const { stdin, lastFrame } = render(
      <InputLockProvider>
        <LockSpy />
        <ProjectTab ctx={buildCtx()} isActive />
      </InputLockProvider>,
    );
    await tick();
    expect(lastFrame()).toContain("locked=false");
    stdin.write(ENTER); // abre el panel de detalle sobre alpha
    await tick();
    // Antes: useLockWhile(mode.kind !== "list") bloqueaba q/r/tab/1-6 con el panel abierto.
    expect(lastFrame()).toContain("locked=false");
  });

  it("la tecla `p` ya no abre modo alguno ni toma el lock (el modo procesos se eliminó)", async () => {
    const { stdin, lastFrame } = render(
      <InputLockProvider>
        <LockSpy />
        <ProjectTab ctx={buildLaunchCtx()} isActive />
      </InputLockProvider>,
    );
    await tick();
    stdin.write("p"); // había un proceso running: antes esto entraba al modo procesos
    await tick();
    expect(lastFrame()).toContain("locked=false");
    expect(lastFrame()).toContain("SOURCES"); // sigue en la lista
  });
});

describe("ProjectTab — lanzamiento local + procesos en segundo plano", () => {
  it("no renderiza secciones de ramas ni de procesos, pero conserva las StatTiles", async () => {
    const { lastFrame } = render(<ProjectTab ctx={buildCtx()} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    // Secciones eliminadas (SPEC 019).
    expect(f).not.toContain("PROCESOS LANZADOS");
    expect(f).not.toContain("sin procesos");
    expect(f).not.toContain("RAMAS DE TRABAJO ACTUALES");
    expect(f).not.toContain("RAMAS QA ACTUALES");
    expect(f).not.toContain("manage processes"); // QuickAction del modo `p`
    // Los cinco tiles siguen ahí (StatTile mayúscula su label) con sus conteos.
    for (const tile of ["GIT", "WORKING TREE", "SOURCES", "WORKING BRANCHES", "PROCESOS"]) {
      expect(f).toContain(tile);
    }
    expect(f).toContain("0 dirty"); // working tree
    expect(f).toContain("declared"); // working branches: las 2 declaradas siguen contadas
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

  /** The rendered row of a source (assertions cannot pass on chrome elsewhere). */
  function sourceRow(frame: string, alias: string): string {
    return frame.split("\n").find((l) => l.includes(alias)) ?? "";
  }

  it("la fila de la fuente con un proceso running muestra el chip; la otra no", async () => {
    const { lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(sourceRow(f, "alpha")).toContain("● 1 running");
    expect(sourceRow(f, "beta")).not.toContain("running");
    // El centinela no es una fuente real: nunca lleva chip.
    expect(sourceRow(f, "all sources")).not.toContain("running");
  });

  it("el chip cuenta los procesos running de la fuente y jamás los stopped/exited", async () => {
    const ctx = buildLaunchCtx(
      JSON.stringify([
        procRecord("alpha", 4242, "running", "dev"),
        procRecord("alpha", 4243, "running", "test"),
        procRecord("alpha", 1111, "stopped"),
        procRecord("alpha", 2222, "exited"),
        procRecord("beta", 3333, "stopped"),
      ]),
    );
    const { lastFrame } = render(<ProjectTab ctx={ctx} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(sourceRow(f, "alpha")).toContain("● 2 running");
    // beta solo tiene historial → sin chip.
    expect(sourceRow(f, "beta")).not.toContain("running");
  });

  it("sin procesos running ninguna fila lleva chip", async () => {
    const ctx = buildLaunchCtx(JSON.stringify([procRecord("alpha", 1111, "stopped")]));
    const { lastFrame } = render(<ProjectTab ctx={ctx} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(sourceRow(f, "alpha")).not.toContain("running");
    expect(f).not.toContain("●");
  });

  it("el panel de detalle ofrece detener/re-lanzar/ver log por proceso activo, entre git flow y Quitar", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // panel de alpha (1 proceso running: dev · PID 4242)
    await tick();
    const f = lastFrame() ?? "";
    for (const action of ["Detener · dev", "Re-lanzar · dev", "Ver log · dev"]) {
      expect(f).toContain(action);
    }
    expect(f).toContain("PID 4242");
    // Orden contractual: git flow → acciones de proceso → destructiva última.
    expect(f.indexOf("Enviar a PROD")).toBeLessThan(f.indexOf("Detener · dev"));
    expect(f.indexOf("Ver log · dev")).toBeLessThan(f.indexOf("Quitar del workspace"));
  });

  it("«Ver log» desde el detalle abre el log de ESE proceso", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    stdin.write(ENTER); // panel de alpha
    await tick();
    // launch + 4 git-flow + Detener + Re-lanzar = 7 bajadas hasta "Ver log".
    for (let i = 0; i < 7; i++) {
      stdin.write(DOWN);
      await tick(20);
    }
    stdin.write(ENTER);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("LOG · ALPHA · DEV"); // el SectionHead mayúscula su label
    expect(f).toContain("/ws/docs/logs/alpha-4242.log");
  });

  /** Baja hasta «Detener» (launch + 4 git-flow = 5) y la ejecuta. */
  async function runStop(stdin: { write: (s: string) => void }, settle: number): Promise<void> {
    stdin.write(ENTER); // panel de alpha
    await tick();
    for (let i = 0; i < 5; i++) {
      stdin.write(DOWN);
      await tick(20);
    }
    stdin.write(ENTER);
    await tick(settle);
  }

  it("«Detener» confirma con el PID cuando el proceso murió, y lo loguea como info", async () => {
    const logger = fakeLogger();
    const alive = new Set([4242]);
    const ctx = buildLaunchCtx(RUNNING_PROCESS, {
      killTree: async (pid: number) => void alive.delete(pid),
      isAlive: async (pid: number) => alive.has(pid),
    });
    const { stdin, lastFrame } = render(
      <ProjectTab ctx={{ ...ctx, logger } as unknown as CliContext} isActive />,
    );
    await tick();
    await runStop(stdin, 200);
    const f = lastFrame() ?? "";
    expect(f).toContain("Detenido alpha");
    expect(f).toContain("PID 4242");
    // Criterio 5 (spec 020): el log distingue el resultado — info al detener.
    const line = logger.lines.find((l) => l.msg.includes("stop alpha"));
    expect(line?.level).toBe("info");
  });

  it("«Detener» avisa cuando el proceso sigue vivo tras la señal, y lo loguea como warn", async () => {
    // La mentira que esto reemplaza: antes decía «detenido» igual y el registro
    // lo marcaba stopped aunque el árbol siguiera en pie.
    const logger = fakeLogger();
    const ctx = buildLaunchCtx(RUNNING_PROCESS, {
      killTree: async () => {}, // no mata nada
      isAlive: async () => true,
    });
    const { stdin, lastFrame } = render(
      <ProjectTab ctx={{ ...ctx, logger } as unknown as CliContext} isActive />,
    );
    await tick();
    await runStop(stdin, 900); // el confirmador agota su presupuesto
    const f = lastFrame() ?? "";
    expect(f).toContain("sigue vivo tras la señal");
    const warn = logger.lines.find((l) => l.msg.includes("stop alpha"));
    expect(warn?.level).toBe("warn");
  });

  it("una fuente sin procesos running no ofrece acciones de proceso en su detalle", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={buildLaunchCtx()} isActive />);
    await tick();
    stdin.write(DOWN); // alpha → beta (sin procesos)
    await tick();
    stdin.write(ENTER);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("ACTIONS");
    expect(f).not.toContain("Detener");
    expect(f).not.toContain("Ver log");
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
        cwdSessionsDir: () => "/ws/.workflow/sessions",
        cwdProcessesFile: () => "/ws/.workflow/processes.json",
        cwdLockFile: () => "/ws/.workflow/.lock",
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

  /** Descriptor sin perfiles ni params: «Lanzar en local» lanza directo (perfil null). */
  const DIRECT_DESCRIPTOR = JSON.stringify({
    version: 1,
    source: "alpha",
    stack: "npm",
    cwd: "/src/alpha",
    command: "npm",
    args: ["start"],
    params: [],
    profiles: [],
  });

  it("confirmar el re-lanzamiento en colisión con un superviviente no lanza proceso nuevo y muestra stop_failed", async () => {
    // Criterio 4 (spec 020), cláusula «resolviendo una colisión»: la ruta del
    // panel ya la demuestra el motor (relaunchProcess); esta prueba cablea el
    // callback propio de la pantalla de colisión (confirmRelaunch → stopFailed).
    let spawns = 0;
    const ctx = buildLaunchCtx(
      JSON.stringify([procRecord("alpha", 7777, "running", null)]),
      {
        killTree: async () => {}, // no mata: el proceso sobrevive a la señal
        isAlive: async () => true,
        spawnInTerminal: async () => {
          spawns += 1;
          return { pid: 9999, mode: "terminal" };
        },
      },
      DIRECT_DESCRIPTOR,
    );
    const { stdin, lastFrame } = render(<ProjectTab ctx={ctx} isActive />);
    await tick();
    stdin.write(ENTER); // panel de alpha
    await tick();
    stdin.write(ENTER); // Lanzar en local → colisión (mismo alias + perfil null)
    await tick();
    expect(lastFrame() ?? "").toContain("Ya corre alpha");
    stdin.write("r"); // confirmar re-lanzamiento: detiene… pero el proceso no muere
    await tick(900); // el confirmador agota su presupuesto (600 ms)
    const f = lastFrame() ?? "";
    expect(f).toContain("sigue vivo tras la señal");
    // Lo que evita: dos procesos peleando por el mismo puerto.
    expect(spawns).toBe(0);
  });

  it("sin bloque WORKSPACE mantiene la vista normal y ofrece configurar fuentes", async () => {
    // fs.exists=false → root implícito, no una pantalla de inicialización obligatoria.
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
        cwdSessionsDir: () => "/ws/.workflow/sessions",
        cwdProcessesFile: () => "/ws/.workflow/processes.json",
        cwdLockFile: () => "/ws/.workflow/.lock",
        cwdDocsLogsDir: () => "/ws/docs/logs",
        cwdLaunchDir: () => "/ws/.workflow/launch",
      },
    } as unknown as CliContext;

    const { lastFrame } = render(<ProjectTab ctx={ctx} isActive />);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("Workspace");
    expect(f).toContain("configurar fuentes");
    expect(f).not.toContain("not initialized");
    expect(f).not.toContain("Lanzar en local");
  });
});
