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
    "| pefectivo-solicitud-spring | /src/pefectivo | certificacion |",
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
}

function buildDeps({ claudeMd, currentBranch }: FakeDepsOptions) {
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
        if (args.includes("rev-list")) return { code: 0, stdout: "0\t5", stderr: "" };
        if (args.includes("for-each-ref")) return { code: 0, stdout: "", stderr: "" };
        if (args.includes("log")) {
          return {
            code: 0,
            stdout: "abc1234\tfix\tme\t2026-01-01T00:00:00Z\thace 1 día",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      which: async () => undefined,
    } as never,
    paths: {
      blockMarkers: () => MARKERS,
      cwdSessionsDir: () => "/ws/.workflow/sessions",
      cwdHistoryFile: () => "/ws/.workflow/HISTORY.md",
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

  it("no expone sessions, pending ni workspaceMode (vista WORKSPACE unificada)", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    expect(data).not.toHaveProperty("sessions");
    expect(data).not.toHaveProperty("pending");
    expect(data).not.toHaveProperty("workspaceMode");
  });
});

describe("buildProjectTabData — GIT tile working branch", () => {
  it("muestra la rama de trabajo DEFINIDA en el workspace, no la rama actual del source", async () => {
    const deps = buildDeps({ claudeMd: workspaceBlock(true), currentBranch: "desarrollo" });

    const data = await buildProjectTabData(deps);

    // La fuente primaria está checked out en "desarrollo", pero el workspace define
    // "feature/mantenimiento-contratos" como rama de trabajo.
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
    working_branches: {},
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
