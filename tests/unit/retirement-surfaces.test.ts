import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * The five scenarios the spec fixes, driven through the REGISTERED commands.
 *
 * Not through the services: what is under test here is the public surface — the
 * argument shape, the refusals, the approval demand, and the fact that the human
 * projection and the JSON say the same thing about scope and digest. An agent host
 * and a terminal must be able to differ in shape and never in what gets deleted.
 */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

const PLAN =
  "# Plan 024 — algo\n\n> Derived from docs/specs/025-spec-algo.md\n> Estado: open\n\n## Tasks\n\n### F1 — hacer\n> Estado: pendiente\n\n- [ ] T1.1 — algo\n";
const SPEC = "---\nstatus: ready-for-plan\n---\n\n# Spec 025 — algo\n";

describe("superficies de retiro — los cinco escenarios de la spec por el comando registrado", () => {
  let root: string;
  let hub: string;
  let source: string;
  let ctx: CliContext;
  let paths: PathsService;
  const fs = new NodeFileSystem();
  const planPath = "docs/plans/024-plan-algo.md";

  function command(name: "discard" | "reset") {
    const found = ALL_COMMANDS.find((c) => c.name === name);
    if (found === undefined) throw new Error(`${name} no está registrado`);
    return found;
  }

  async function run(name: "discard" | "reset", ...argv: string[]) {
    const cmd = command(name);
    const args = parseArgv([name, ...argv]);
    const result = await cmd.execute(args, ctx);
    const human = cmd.renderHuman?.(result, { detail: false }) ?? "";
    return { result, human };
  }

  async function session(name: string, inputs: string[] = []): Promise<string> {
    const created = await runSessionCreate(fs, paths, {
      type: name.endsWith("-quick") ? "quick" : "exec",
      name,
      objetivo: "o",
      ...(inputs.length > 0 ? { inputs } : {}),
    });
    if ("error" in created) throw new Error(created.error);
    return created.sessionCreate.folder;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surfaces-"));
    hub = join(root, "ws");
    source = join(root, "acme");
    mkdirSync(join(hub, "docs", "plans"), { recursive: true });
    mkdirSync(join(hub, "docs", "specs"), { recursive: true });
    mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
    mkdirSync(source, { recursive: true });
    git(source, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(source, "base.txt"), "base\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "inicial");

    writeFileSync(
      join(hub, "CLAUDE.md"),
      `<!-- WORKFLOW-HUB-START -->\n## Hub\n\nX.\n\n## Fuentes\n\n| Alias | Path | Rama principal |\n|---|---|---|\n| acme | ${source} | main |\n\n## Status\n\n- Ramas de trabajo actuales:\n  - acme: main\n<!-- WORKFLOW-HUB-END -->\n`,
    );
    writeFileSync(join(hub, "docs", "specs", "025-spec-algo.md"), SPEC);
    writeFileSync(join(hub, planPath), PLAN);

    paths = new PathsService(normalizeNamespace("workflow"), join(root, "home"), hub);
    const env = new FakeEnv(join(root, "home"), hub);
    ctx = { fs, env, git: new GitCliAdapter(new NodeProcess()), paths } as CliContext;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("3 · resetea una ejecución parcial de plan y lo deja disponible para refinarse", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    writeFileSync(join(hub, planPath), PLAN.replace("- [ ] T1.1", "- [x] T1.1"));

    const prepared = await run("reset", "prepare", planPath);
    expect(prepared.result.ok).toBe(true);
    const data = prepared.result.data as { digest: string };
    expect(prepared.human).toContain("Restaurar session:");
    expect(prepared.human).toContain("bytes-previos (cambió desde el baseline)");

    const applied = await run("reset", "apply", planPath, "--approval", data.digest);
    expect(applied.result.ok).toBe(true);
    // El plan volvió a sus bytes previos y sigue en el tablero, listo para refinar.
    expect(readFileSync(join(hub, planPath), "utf-8")).toBe(PLAN);
    expect(existsSync(join(hub, ".workflow", "sessions", folder))).toBe(false);
    const board = await runStatusCommand(fs, ctx.env, paths, { git: ctx.git });
    expect(board.plans.map((p) => p.number)).toEqual(["024"]);
    expect(board.pipeline.some((i) => i.command === `/w:plan-exec ${planPath}`)).toBe(true);
    expect(board.terminal_events).toEqual([]);
  });

  it("5 · resetea un quick sin artefacto base retirándolo entero", async () => {
    const quick = await session("suelto-quick");
    const prepared = await run("reset", "prepare", `session:${quick}`);
    expect(prepared.result.ok).toBe(true);
    const data = prepared.result.data as { digest: string; preview: { restores: unknown[] } };
    expect(data.preview.restores).toEqual([]);
    // Antes de aplicar, la vista dice que no hay nada que devolver — y por qué.
    expect(prepared.human).toContain("Nada vuelve atrás");
    expect(prepared.human).toContain(`${quick}: sin artefactos declarados`);

    const applied = await run("reset", "apply", `session:${quick}`, "--approval", data.digest);
    expect(applied.result.ok).toBe(true);
    // Y después de aplicar tampoco se lee «listo» donde no se restauró nada.
    expect(applied.human).toContain("Nada volvió atrás");
    expect(existsSync(join(hub, ".workflow", "sessions", quick))).toBe(false);
    const board = await runStatusCommand(fs, ctx.env, paths, { git: ctx.git });
    expect(board.sessions.active).toEqual([]);
    expect(board.terminal_events).toEqual([]);
  });
});
