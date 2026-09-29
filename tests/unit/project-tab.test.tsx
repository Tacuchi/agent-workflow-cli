import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ProjectTab } from "../../src/cli/tui/tabs/project-tab.js";
import type { CliContext } from "../../src/cli/types.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const ESC = "\x1B";
const tick = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));
const MARKERS = { start: "<!-- WORKFLOW-PROJECT-START -->", end: "<!-- WORKFLOW-PROJECT-END -->" };
const WORKSPACE = [
  MARKERS.start,
  "## Proyecto",
  "WS",
  "## Fuentes",
  "| Alias | Path | Rama principal |",
  "|---|---|---|",
  "| alpha | /src/alpha | certificacion |",
  "| beta | /src/beta | main |",
  "## Status",
  "- Ramas de trabajo actuales:",
  "  - alpha: feature/x",
  "  - beta: feature/y",
  "- Ramas QA actuales:",
  "  - alpha: qa",
  MARKERS.end,
].join("\n");

interface Line {
  level: string;
  msg: string;
}

function context(
  opts: {
    lines?: Line[];
    pushed?: string[];
    env?: Record<string, string>;
    failure?: string;
    reads?: string[];
    pathReads?: string[];
    commands?: string[][];
  } = {},
): CliContext {
  return {
    logger: {
      log: async (level: string, msg: string) => void opts.lines?.push({ level, msg }),
      warn: async (msg: string) => void opts.lines?.push({ level: "warn", msg }),
      error: async (msg: string) => void opts.lines?.push({ level: "error", msg }),
    },
    fs: {
      exists: async (path: string) => {
        opts.pathReads?.push(path);
        return path === "/ws/CLAUDE.md" || path === "/src/alpha" || path === "/src/beta";
      },
      readText: async (path: string) => {
        opts.reads?.push(path);
        return WORKSPACE;
      },
    },
    env: {
      cwd: () => "/ws",
      homeDir: () => "/home",
      get: (name: string) => opts.env?.[name],
    },
    git: {
      isGitRepo: async () => true,
      currentBranch: async () => "feature/x",
      changedFiles: async () => [],
      isMerging: async () => false,
      isDirty: async () => false,
      checkout: async () => {
        if (opts.failure) throw new Error(opts.failure);
      },
      remoteHasBranch: async () => true,
      fetchBranch: async () => {},
      fastForward: async () => {},
      aheadBehind: async () => ({ ahead: 0, behind: 0 }),
      revList: async () => [],
      mergeOrigin: async () => undefined,
      merge: async () => ({ ok: true, conflicted: [] }),
      push: async (repo: string, branch: string) => void opts.pushed?.push(`${repo} ${branch}`),
    },
    process: {
      run: async (_cmd: string, args: string[]) => {
        opts.commands?.push(args);
        return { code: args.includes("--no-merges") ? 128 : 0, stdout: "", stderr: "" };
      },
    },
    paths: {
      workspaceDir: () => "/ws",
      blockMarkers: () => MARKERS,
      cwdLocalConfigFile: () => "/ws/.workflow/local.json",
    },
  } as unknown as CliContext;
}

async function detail(stdin: { write(input: string): void }) {
  stdin.write(ENTER);
  await tick();
}

async function selectAction(stdin: { write(input: string): void }, index: number) {
  await detail(stdin);
  for (let i = 0; i < index; i++) {
    stdin.write(DOWN);
    await tick(20);
  }
  stdin.write(ENTER);
  await tick();
}

describe("ProjectTab — fuentes y Git sin lanzador", () => {
  it("navega fuentes y ofrece sólo las cuatro acciones Git y quitar", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={context()} isActive />);
    await tick();
    expect(lastFrame()).toContain("all sources");
    expect(lastFrame()).toContain("WORKING BRANCHES");
    expect(lastFrame()).not.toContain("PROCESOS");
    await detail(stdin);
    for (const label of [
      "Alinear con PROD",
      "Enviar a Desarrollo",
      "Enviar a QA",
      "Enviar a PROD",
      "Quitar del workspace",
    ])
      expect(lastFrame()).toContain(label);
    for (const retired of ["Lanzar en local", "Re-lanzar", "Detener", "Ver log"])
      expect(lastFrame()).not.toContain(retired);
  });

  it("ni el listado ni las acciones Git leen artefactos legacy", async () => {
    const pathReads: string[] = [];
    const reads: string[] = [];
    const lines: Line[] = [];
    const { stdin, lastFrame } = render(
      <ProjectTab ctx={context({ pathReads, reads, lines })} isActive />,
    );
    await tick();
    await selectAction(stdin, 0);
    expect(lastFrame()).toContain("completed");
    expect(lines.some((line) => line.msg.includes("git-flow sync"))).toBe(true);
    expect([...pathReads, ...reads].join(" ")).not.toMatch(
      /processes\.json|\/launch\/|\/docs\/logs\//,
    );
  });

  it("Enviar a Desarrollo conserva el despacho a to-dev", async () => {
    const lines: Line[] = [];
    const { stdin } = render(<ProjectTab ctx={context({ lines })} isActive />);
    await tick();
    await selectAction(stdin, 1);
    expect(lines.some((line) => line.msg.includes("git-flow to-dev"))).toBe(true);
    expect(lines.some((line) => line.msg.includes("git-flow to-qa"))).toBe(false);
  });

  it("un fallo Git conserva su detalle en el log y el resultado", async () => {
    const lines: Line[] = [];
    const { stdin, lastFrame } = render(
      <ProjectTab ctx={context({ lines, failure: "ruta de Git fallida" })} isActive />,
    );
    await tick();
    await selectAction(stdin, 0);
    expect(lastFrame()).toContain("error");
    expect(
      lines.some((line) => line.level === "error" && line.msg.includes("ruta de Git fallida")),
    ).toBe(true);
  });

  it("Enviar a PROD exige vista previa y permite cancelar sin publicar", async () => {
    const pushed: string[] = [];
    const { stdin, lastFrame } = render(<ProjectTab ctx={context({ pushed })} isActive />);
    await tick();
    await selectAction(stdin, 3);
    expect(lastFrame()).toContain("ENVIAR A PROD");
    expect(lastFrame()).toContain("y publicar · n/esc cancelar");
    expect(pushed).toEqual([]);
    stdin.write("n");
    await tick();
    expect(pushed).toEqual([]);
    expect(lastFrame()).toContain("ACTIONS");
  });

  it("Enviar a PROD publica sólo después de confirmar la vista previa", async () => {
    const pushed: string[] = [];
    const { stdin, lastFrame } = render(<ProjectTab ctx={context({ pushed })} isActive />);
    await tick();
    await selectAction(stdin, 3);
    expect(pushed).toEqual([]);
    stdin.write("y");
    await tick(150);
    expect(lastFrame()).toContain("completed");
    expect(pushed).toEqual(["/src/alpha certificacion"]);
  });

  it("un marcador de agente impide publicar PROD aun después de pulsar y", async () => {
    const pushed: string[] = [];
    const { stdin, lastFrame } = render(
      <ProjectTab ctx={context({ pushed, env: { CLAUDECODE: "1" } })} isActive />,
    );
    await tick();
    await selectAction(stdin, 3);
    stdin.write("y");
    await tick();
    expect(pushed).toEqual([]);
    expect(lastFrame()).toContain("La publicación en PROD la hace la persona");
  });

  it("confirmar quitar informa que conserva los procesos y el lanzador", async () => {
    const { stdin, lastFrame } = render(<ProjectTab ctx={context()} isActive />);
    await tick();
    await selectAction(stdin, 4);
    expect(lastFrame()).toContain("¿Quitar alpha del workspace?");
    expect(lastFrame()).toContain("conserva los artefactos y procesos locales anteriores");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toContain("ACTIONS");
  });

  it("las filas no se envuelven con el panel cerrado", async () => {
    const { lastFrame } = render(
      <Box borderStyle="bold" paddingX={2}>
        <Box borderStyle="single" paddingX={2}>
          <ProjectTab ctx={context()} isActive />
        </Box>
      </Box>,
    );
    await tick();
    const rows = (lastFrame() ?? "").split("\n");
    const alpha = rows.findIndex((row) => row.includes("alpha"));
    expect(rows.findIndex((row) => row.includes("beta")) - alpha).toBe(1);
  });
});
