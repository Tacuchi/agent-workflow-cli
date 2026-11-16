import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderHubBlock } from "../../src/application/render/hub-block.js";
import { App, type TuiResult } from "../../src/cli/tui/app.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const ESC = "\x1B";
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const PIPELINE = [
  {
    file: "docs/plans/001-plan-alpha.md",
    command: "/w:plan-exec docs/plans/001-plan-alpha.md",
    detail: { next: "continuar por la primera fase no validada" },
  },
];

interface Setup {
  aliases?: string[];
  latest?: string | "offline";
  status?: { code: number; stdout: string };
  env?: Record<string, string>;
  dirty?: string[];
}

describe("TUI de una sola pantalla", () => {
  let hub: string;

  beforeEach(async () => {
    hub = await realpath(await mkdtemp(join(tmpdir(), "aw-tui-screen-")));
  });
  afterEach(async () => {
    await rm(hub, { recursive: true, force: true });
  });

  async function context(opts: Setup = {}) {
    const aliases = opts.aliases ?? ["alpha", "beta", "gamma"];
    const paths = new PathsService(normalizeNamespace("agent-workflow"), hub, hub);
    for (const alias of aliases) await mkdir(join(hub, alias), { recursive: true });
    const block = renderHubBlock({
      proyecto: "Hub",
      fuentes: aliases.map((alias) => ({ alias, path: alias, main_branch: "main" })),
      stack: {},
      lastActivity: "2026-01-01 00:00",
      workingBranches: Object.fromEntries(aliases.map((a) => [a, "feature/x"])),
      markers: paths.blockMarkers(),
    });
    await writeFile(join(hub, "AGENTS.md"), block, "utf8");
    const git = new RecordingGit({
      currentBranch: "feature/x",
      dirtyRepos: (opts.dirty ?? []).map((a) => join(hub, a)),
    });
    const dirty = new Set((opts.dirty ?? []).map((a) => join(hub, a)));
    git.changedFiles = async (repo: string) => (dirty.has(repo) ? ["src/x.ts"] : []);
    const commands: string[][] = [];
    const process = {
      run: async (cmd: string, args: string[]) => {
        commands.push([cmd, ...args]);
        if (cmd === "npm") {
          if (opts.latest === "offline") throw new Error("getaddrinfo ENOTFOUND registry");
          return { code: 0, stdout: `${opts.latest ?? "32.0.0"}\n`, stderr: "" };
        }
        return {
          code: opts.status?.code ?? 0,
          stdout: opts.status?.stdout ?? JSON.stringify({ pipeline: PIPELINE }),
          stderr: "",
        };
      },
    };
    const ctx = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(hub, hub, opts.env ?? {}),
      git,
      paths,
      process,
      runtime: { binName: "aw", packageName: "@scope/cli" },
    } as unknown as CliContext;
    return { ctx, git, commands };
  }

  async function open(opts: Setup = {}) {
    const { ctx, git, commands } = await context(opts);
    const results: TuiResult[] = [];
    const view = render(<App version="32.0.0" ctx={ctx} onResult={(r) => results.push(r)} />);
    await tick(120);
    return { ...view, git, commands, results, frame: () => view.lastFrame() ?? "" };
  }

  async function press(stdin: { write(s: string): void }, ...keys: string[]) {
    for (const key of keys) {
      stdin.write(key);
      await tick();
    }
  }

  it("abre una sola pantalla, sin pestañas, con pendientes, fuentes y sus teclas", async () => {
    const { frame, commands } = await open({ dirty: ["beta"] });
    const f = frame();
    expect(f).toContain("PENDIENTES");
    expect(f).toContain("docs/plans/001-plan-alpha.md · continuar por la primera fase no validada");
    expect(f).toContain("/w:plan-exec docs/plans/001-plan-alpha.md");
    expect(f).toContain("FUENTES");
    expect(f).toMatch(/alpha feature\/x · limpia/);
    expect(f).toMatch(/beta feature\/x · con cambios sin confirmar/);
    expect(f).toContain("todas las fuentes");
    expect(f).toContain("↑↓ mover · ⏎ acciones · r refrescar · q salir");
    for (const retired of ["Status", "MCP", "Config", "Hub ", "sessions", "Workline"]) {
      expect(f).not.toContain(retired);
    }
    // Pending items come from the public JSON, in a subprocess.
    expect(commands).toContainEqual(["aw", "status", "--format", "json"]);
  });

  it("los pendientes no dependen de contadores de sesiones", async () => {
    const { frame } = await open({
      status: { code: 0, stdout: JSON.stringify({ pipeline: PIPELINE }) },
    });
    expect(frame()).toContain("PENDIENTES 1");
    expect(frame()).not.toContain("No se pudo leer");
  });

  it("cada vista muestra solo las teclas que acepta", async () => {
    const { stdin, frame } = await open();
    await press(stdin, ENTER);
    expect(frame()).toContain("Alinear con PROD");
    expect(frame()).toContain("↑↓ mover · ⏎ ejecutar · esc volver · q salir");
    expect(frame()).not.toContain("r refrescar");
    await press(stdin, ESC);
    expect(frame()).toContain("FUENTES");
  });

  it("alinea con PROD una fuente y muestra su resultado", async () => {
    const { stdin, frame, git } = await open();
    await press(stdin, ENTER, ENTER);
    await tick(120);
    expect(frame()).toContain("ALINEAR CON PROD");
    expect(frame()).toContain("completado");
    expect(frame()).toMatch(/alpha\s+ok/);
    expect(git.calls.some((c) => c.op === "merge")).toBe(true);
    expect(frame()).toContain("↑↓ mover · esc volver · q salir");
  });

  it("envía a desarrollo todas las fuentes y da una fila por fuente", async () => {
    const { stdin, frame } = await open();
    await press(stdin, DOWN, DOWN, DOWN, ENTER, DOWN, ENTER);
    await tick(150);
    expect(frame()).toContain("ENVIAR A DESARROLLO");
    for (const alias of ["alpha", "beta", "gamma"])
      expect(frame()).toMatch(new RegExp(`${alias}\\s+ok`));
  });

  it("abre el detalle de un error y vuelve", async () => {
    const { stdin, frame } = await open({ dirty: ["alpha"] });
    await press(stdin, ENTER, DOWN, ENTER);
    await tick(120);
    expect(frame()).toMatch(/alpha\s+error/);
    await press(stdin, ENTER);
    expect(frame()).toContain("error:");
    expect(frame()).toContain("↑↓ mover · esc volver");
    await press(stdin, ESC);
    expect(frame()).toContain("ENVIAR A DESARROLLO");
  });

  it("Enviar a PROD con todas las fuentes muestra la vista previa y n vuelve sin publicar", async () => {
    const { stdin, frame, git } = await open();
    await press(stdin, DOWN, DOWN, DOWN, ENTER, DOWN, DOWN, DOWN, ENTER);
    await tick(150);
    expect(frame()).toContain("ENVIAR A PROD");
    expect(frame()).toContain("y publicar · n/esc cancelar");
    for (const alias of ["alpha", "beta", "gamma"]) expect(frame()).toContain(alias);
    await press(stdin, "n");
    await tick(120);
    expect(git.calls.some((c) => c.op === "push")).toBe(false);
    expect(frame()).toContain("FUENTES");
  });

  it("Enviar a PROD publica solo con y", async () => {
    const { stdin, frame, git } = await open();
    await press(stdin, ENTER, DOWN, DOWN, DOWN, ENTER);
    await tick(120);
    expect(git.calls.some((c) => c.op === "push")).toBe(false);
    await press(stdin, "y");
    await tick(150);
    expect(frame()).toContain("completado");
    expect(git.calls.some((c) => c.op === "push" && c.arg === "main")).toBe(true);
  });

  it("un marcador de agente impide publicar en PROD aun pulsando y", async () => {
    const { stdin, frame, git } = await open({ env: { CLAUDECODE: "1" } });
    await press(stdin, ENTER, DOWN, DOWN, DOWN, ENTER);
    await tick(120);
    await press(stdin, "y");
    expect(git.calls.some((c) => c.op === "push")).toBe(false);
    expect(frame()).toContain("La publicación en PROD la hace la persona");
    expect(frame()).toContain("esc volver · q salir");
  });

  it("con versión nueva muestra una línea y u sale para actualizar", async () => {
    const { stdin, frame, results } = await open({ latest: "32.1.0" });
    expect(frame()).toContain("Versión nueva: v32.0.0 → v32.1.0");
    expect(frame()).toContain("u actualizar");
    await press(stdin, "u");
    expect(results).toEqual([{ kind: "update" }]);
  });

  it.each([["32.0.0"], ["offline"]] as const)(
    "sin versión nueva o sin red (%s) no hay línea, ni error, ni tecla u",
    async (latest) => {
      const { stdin, frame, results } = await open({ latest });
      expect(frame()).not.toContain("Versión nueva");
      expect(frame()).not.toContain("u actualizar");
      expect(frame()).not.toMatch(/error|ENOTFOUND/i);
      expect(frame()).toContain("FUENTES");
      await press(stdin, "u");
      expect(results).toEqual([]);
    },
  );

  it("en un hub sin fuentes muestra los pendientes y cómo declararlas", async () => {
    const { frame } = await open({ aliases: [] });
    expect(frame()).toContain("PENDIENTES");
    expect(frame()).toContain("aw add-source");
    expect(frame()).not.toContain("todas las fuentes");
    expect(frame()).toContain("r refrescar · q salir");
    expect(frame()).not.toContain("⏎");
  });

  it("q sale con 0", async () => {
    const { stdin, results } = await open();
    await press(stdin, "q");
    expect(results).toEqual([{ kind: "exit", exitCode: 0 }]);
  });
});
