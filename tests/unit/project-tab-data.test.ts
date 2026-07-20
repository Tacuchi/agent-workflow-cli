import { describe, expect, it } from "vitest";
import type { ParsedProjectBlock } from "../../src/application/parsers/project-block.js";
import {
  buildProjectTabData,
  resolveDefinedWorkingBranch,
} from "../../src/application/project-tab-data.js";

const MARKERS = { start: "<!-- WORKFLOW-PROJECT-START -->", end: "<!-- WORKFLOW-PROJECT-END -->" };

function workspaceBlock(withWorkingBranches: boolean): string {
  const working = withWorkingBranches
    ? [
        "- Ramas de trabajo actuales:",
        "  - autoservicio-solicitud-spring: feature/mantenimiento-contratos",
        "  - pefectivo-solicitud-spring: feature/mantenimiento-contratos",
        "- Ramas QA actuales:",
        "  - autoservicio-solicitud-spring: desarrollo",
        "  - pefectivo-solicitud-spring: desarrollo",
      ].join("\n")
    : "";
  return [
    MARKERS.start,
    "## Proyecto",
    "",
    "Workspace de mantenimiento de contratos.",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    "| autoservicio-solicitud-spring | /src/autoservicio | certificacion |",
    "| pefectivo-solicitud-spring | /src/pefectivo | main |",
    "",
    "## Stack",
    "",
    "_Stack sin detectar._",
    "",
    "## Status",
    "",
    working,
    "- Última actividad: 2026-05-26 14:19",
    "- Histórico: `.workflow/HISTORY.md`",
    MARKERS.end,
  ].join("\n");
}

interface FakeDepsOptions {
  claudeMd: string;
  currentBranch: string;
  /**
   * stdout of the own-commit counter (`rev-list --count --no-merges`) keyed by
   * BASE ref. A base that is absent here exits non-zero, like a ref git does not
   * know. Default: no base resolves → the counter is null.
   */
  ownCommits?: Record<string, string>;
  /** Collects every `git` argv the data layer issues. */
  calls?: string[][];
  /** Make the counter's subprocess THROW (vs. exit non-zero) to exercise safeRun. */
  throwOnCounter?: boolean;
}

function buildDeps({
  claudeMd,
  currentBranch,
  ownCommits,
  calls,
  throwOnCounter,
}: FakeDepsOptions) {
  return {
    fs: {
      exists: async (p: string) => p === "/ws/CLAUDE.md",
      readText: async (p: string) => (p === "/ws/CLAUDE.md" ? claudeMd : ""),
      list: async () => [],
      writeText: async () => {},
      mkdirp: async () => {},
    } as never,
    env: {
      cwd: () => "/ws",
      homeDir: () => "/home",
      get: () => undefined,
    } as never,
    git: {
      isGitRepo: async () => true,
      currentBranch: async () => currentBranch,
      changedFiles: async () => [],
    } as never,
    process: {
      run: async (_cmd: string, args: string[]) => {
        calls?.push(args);
        // ahead/behind of the GIT tile — a different rev-list from the counter's
        if (args.includes("rev-list") && args.includes("--left-right")) {
          return { code: 0, stdout: "0\t5", stderr: "" };
        }
        if (args.includes("rev-list")) {
          if (throwOnCounter) throw new Error("git spawn failed");
          const base = (args[args.length - 1] ?? "").split("..")[0] ?? "";
          const stdout = ownCommits?.[base];
          return stdout === undefined
            ? { code: 128, stdout: "", stderr: `unknown revision ${base}` }
            : { code: 0, stdout, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      which: async () => undefined,
    } as never,
    paths: {
      blockMarkers: () => MARKERS,
      cwdSessionsDir: () => "/ws/.workflow/sessions",
      cwdHistoryFile: () => "/ws/.workflow/HISTORY.md",
      cwdProcessesFile: () => "/ws/.workflow/processes.json",
      cwdDocsLogsDir: () => "/ws/docs/logs",
    } as never,
  };
}

describe("buildProjectTabData — workspace view", () => {
  it("expone las fuentes declaradas y sus ramas principales", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    expect(data.initialized).toBe(true);
    expect(data.sources.map((s) => s.alias)).toEqual([
      "autoservicio-solicitud-spring",
      "pefectivo-solicitud-spring",
    ]);
    expect(data.sources[0]?.mainBranch).toBe("certificacion");
  });

  it("expone las ramas de trabajo actuales por alias", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    expect(data.workingBranches).toEqual({
      "autoservicio-solicitud-spring": "feature/mantenimiento-contratos",
      "pefectivo-solicitud-spring": "feature/mantenimiento-contratos",
    });
  });

  it("expone las ramas QA actuales por alias", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    expect(data.qaBranches).toEqual({
      "autoservicio-solicitud-spring": "desarrollo",
      "pefectivo-solicitud-spring": "desarrollo",
    });
  });

  it("expone qaBranches vacío cuando el bloque no declara ramas QA", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(false), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    expect(data.qaBranches).toEqual({});
  });

  it("no expone sessions, pending ni workspaceMode (vista WORKSPACE unificada)", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    expect(data).not.toHaveProperty("sessions");
    expect(data).not.toHaveProperty("pending");
    expect(data).not.toHaveProperty("workspaceMode");
  });
});

describe("buildProjectTabData — contador de commits propios", () => {
  const FEATURE = "feature/mantenimiento-contratos";

  it("cuenta contra la rama principal local, excluyendo merges", async () => {
    const calls: string[][] = [];
    const deps = buildDeps({
      claudeMd: workspaceBlock(true),
      currentBranch: FEATURE,
      ownCommits: { certificacion: "3\n" },
      calls,
    });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.commitCount).toBe(3);
    const counter = calls.find((a) => a.includes("--count") && a.includes("--no-merges"));
    // --no-merges es la semántica: sin él, un merge de la principal hacia la rama contaría.
    expect(counter).toEqual(["rev-list", "--count", "--no-merges", `certificacion..${FEATURE}`]);
    // Cada fuente cuenta contra SU base: la 2ª declara `main`, que aquí no resuelve.
    expect(data.sources[1]?.commitCount).toBeNull();
    expect(calls).toContainEqual(["rev-list", "--count", "--no-merges", `main..${FEATURE}`]);
  });

  it("cuenta 0 cuando la rama no aporta commits propios (distinto de «no medible»)", async () => {
    const deps = buildDeps({
      claudeMd: workspaceBlock(true),
      currentBranch: FEATURE,
      ownCommits: { certificacion: "0\n" },
    });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.commitCount).toBe(0);
  });

  it("da null en HEAD desacoplado, sin preguntarle a git", async () => {
    // `git rev-parse --abbrev-ref HEAD` imprime el literal "HEAD" (exit 0) en
    // detached: si no se trata como centinela, `<base>..HEAD` cuenta igual y
    // durante un rebase muestra un número parcial.
    const calls: string[][] = [];
    const deps = buildDeps({
      claudeMd: workspaceBlock(true),
      currentBranch: "HEAD",
      ownCommits: { certificacion: "3\n", "origin/certificacion": "3\n" },
      calls,
    });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.commitCount).toBeNull();
    expect(calls.some((a) => a.includes("--no-merges"))).toBe(false);
  });

  it("cae a origin/<principal> cuando la base local no existe", async () => {
    const deps = buildDeps({
      claudeMd: workspaceBlock(true),
      currentBranch: FEATURE,
      ownCommits: { "origin/certificacion": "7\n" },
    });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.commitCount).toBe(7);
  });

  it("da null EN SILENCIO cuando no hay base ni local ni remota", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: FEATURE });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.commitCount).toBeNull();
    // Una base inexistente es el caso ordinario (clon recién hecho): un warning
    // por fuente sería ruido, no información.
    expect(data.warnings.some((w) => w.startsWith("commits:"))).toBe(false);
  });

  it("degrada a null y SÍ avisa cuando el subproceso de git revienta", async () => {
    const deps = buildDeps({
      claudeMd: workspaceBlock(true),
      currentBranch: FEATURE,
      ownCommits: { certificacion: "3\n" },
      throwOnCounter: true,
    });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.commitCount).toBeNull();
    expect(data.warnings.some((w) => w.startsWith("commits:"))).toBe(true);
  });

  it("da null —sin preguntarle a git— cuando la rama actual ES la principal", async () => {
    const calls: string[][] = [];
    const deps = buildDeps({
      claudeMd: workspaceBlock(true),
      currentBranch: "certificacion",
      ownCommits: { certificacion: "9\n" },
      calls,
    });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.commitCount).toBeNull();
    // Para ESA fuente no se le pregunta a git (la 2ª declara otra base y sí cuenta).
    expect(calls.some((a) => a.some((x) => x.startsWith("certificacion..")))).toBe(false);
  });

  it("no confunde el contador con el ahead/behind del tile GIT", async () => {
    const deps = buildDeps({
      claudeMd: workspaceBlock(true),
      currentBranch: FEATURE,
      ownCommits: { certificacion: "3\n" },
    });

    const data = await buildProjectTabData(deps);

    // ahead/behind sigue leyendo "0\t5"; el contador es otro número.
    expect(data.git?.behind).toBe(0);
    expect(data.git?.ahead).toBe(5);
    expect(data.sources[0]?.commitCount).toBe(3);
  });
});

describe("buildProjectTabData — rama principal resuelta", () => {
  // Fuentes cell empty → the workspace default `principal` must resolve it, both
  // for the source row and for the GIT tile's base.
  function blockWithDefault(): string {
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
      "| core | /src/core |  |",
      "",
      "## Status",
      "",
      "- Ramas por defecto:",
      "  - principal: trunk",
      "- Ramas de trabajo actuales:",
      "  - core: feature/x",
      "- Última actividad: 2026-05-26 14:19",
      MARKERS.end,
    ].join("\n");
  }

  it("aplica el default `principal` del workspace a una celda «Rama principal» vacía", async () => {
    const deps = buildDeps({
      claudeMd: blockWithDefault(),
      currentBranch: "feature/x",
      ownCommits: { trunk: "2\n" },
    });

    const data = await buildProjectTabData(deps);

    expect(data.sources[0]?.mainBranch).toBe("trunk");
    expect(data.git?.base).toBe("trunk");
    // El contador cuenta contra la base RESUELTA, no contra la celda cruda (vacía).
    expect(data.sources[0]?.commitCount).toBe(2);
  });
});

describe("buildProjectTabData — GIT tile working branch", () => {
  it("muestra la rama de trabajo DEFINIDA en el workspace, no la rama actual del source", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    // The primary source is checked out on "desarrollo", but the workspace declares
    // "feature/mantenimiento-contratos" as the working branch.
    expect(data.git?.branch).toBe("feature/mantenimiento-contratos");
    expect(data.git?.base).toBe("certificacion");
  });

  it("cae a la rama actual cuando el workspace no declara ramas de trabajo", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(false), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    expect(data.git?.branch).toBe("desarrollo");
  });
});

function block(overrides: Partial<ParsedProjectBlock>): ParsedProjectBlock {
  return {
    proyecto: "p",
    fuentes: [
      { alias: "alpha", path: "/src/alpha", main_branch: "certificacion" },
      { alias: "beta", path: "/src/beta", main_branch: "certificacion" },
    ],
    stack: {},
    default_branches: {},
    working_branches: {},
    qa_branches: {},
    last_activity: null,
    ...overrides,
  };
}

describe("resolveDefinedWorkingBranch", () => {
  it("devuelve la rama de trabajo de la fuente primaria (fuentes[0])", () => {
    const b = block({
      working_branches: { alpha: "feature/x", beta: "feature/y" },
    });
    expect(resolveDefinedWorkingBranch(b)).toBe("feature/x");
  });

  it("devuelve undefined si la fuente primaria no tiene rama declarada", () => {
    const b = block({ working_branches: { beta: "feature/y" } });
    expect(resolveDefinedWorkingBranch(b)).toBeUndefined();
  });

  it("devuelve undefined cuando el bloque es null", () => {
    expect(resolveDefinedWorkingBranch(null)).toBeUndefined();
  });

  it("devuelve undefined cuando no hay fuentes", () => {
    const b = block({ fuentes: [], working_branches: { alpha: "feature/x" } });
    expect(resolveDefinedWorkingBranch(b)).toBeUndefined();
  });
});
