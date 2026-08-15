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
import { recordCommit, recordUnitTaken } from "../../src/application/session-custody-recorder.js";
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
  let workspace: string;
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
    workspace = join(root, "ws");
    source = join(root, "acme");
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    mkdirSync(join(workspace, "docs", "specs"), { recursive: true });
    mkdirSync(join(workspace, ".workflow", "sessions"), { recursive: true });
    mkdirSync(source, { recursive: true });
    git(source, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(source, "base.txt"), "base\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "inicial");

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `<!-- WORKFLOW-PROJECT-START -->\n## Proyecto\n\nX.\n\n## Fuentes\n\n| Alias | Path | Rama principal |\n|---|---|---|\n| acme | ${source} | main |\n\n## Status\n\n- Ramas de trabajo actuales:\n  - acme: main\n<!-- WORKFLOW-PROJECT-END -->\n`,
    );
    writeFileSync(join(workspace, "docs", "specs", "025-spec-algo.md"), SPEC);
    writeFileSync(join(workspace, planPath), PLAN);

    paths = new PathsService(normalizeNamespace("workflow"), join(root, "home"), workspace);
    const env = new FakeEnv(join(root, "home"), workspace);
    ctx = { fs, env, git: new GitCliAdapter(new NodeProcess()), paths } as CliContext;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("1 · descarta una spec con descendientes y sin commits, con una sola aprobación", async () => {
    const refine = await session("algo-spec-refine", ["docs/specs/025-spec-algo.md"]);
    const exec = await session("algo-plan-exec", [planPath]);

    const prepared = await run("discard", "prepare", "spec:025");
    expect(prepared.result.ok).toBe(true);
    const data = prepared.result.data as {
      digest: string;
      next: string;
      preview: { disappears: Array<{ node: string }> };
    };
    // La vista humana y el JSON dicen lo MISMO sobre alcance y digest.
    expect(prepared.human).toContain("Retirar spec:025");
    expect(prepared.human).toContain(data.digest);
    for (const entry of data.preview.disappears) expect(prepared.human).toContain(entry.node);
    expect(data.next).toBe(`aw discard apply spec:025 --approval ${data.digest}`);

    const applied = await run("discard", "apply", "spec:025", "--approval", data.digest);
    expect(applied.result.ok).toBe(true);
    expect(existsSync(join(workspace, "docs", "specs", "025-spec-algo.md"))).toBe(false);
    expect(existsSync(join(workspace, planPath))).toBe(false);
    for (const folder of [refine, exec]) {
      expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(false);
    }
    // Ningún nodo de la clausura queda activo, pendiente ni reanudable, y la única
    // huella propia de Workline es la fila del ledger.
    const board = await runStatusCommand(fs, ctx.env, paths, { git: ctx.git });
    expect(board.specs).toEqual([]);
    expect(board.plans).toEqual([]);
    expect(board.sessions.active).toEqual([]);
    expect(board.pipeline).toEqual([]);
    expect(board.terminal_events).toHaveLength(1);
    expect(board.terminal_events[0]?.command).toBe("discard");
    // Y NO se mezcla con `discarded`, que significa lo que una sesión postergó.
    expect(board.discarded).toEqual([]);
    expect(board.counts.terminal_events).toBe(1);
  });

  it("2 · rechazar la reversión deja plan, sesiones, árbol e HISTORY sin cambios", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", `aw/${folder}`, unit);
    await recordUnitTaken({ fs, git: ctx.git, paths }, folder, {
      alias: "acme",
      sourcePath: source,
      unitPath: unit,
      unitBranch: `aw/${folder}`,
      base: "main",
    });
    writeFileSync(join(unit, "trabajo.txt"), "de la sesión\n");
    git(unit, "add", "-A");
    const receipt = await ctx.git.commit(unit, "trabajo de la sesión");
    await recordCommit({ fs, git: ctx.git, paths }, folder, "acme", receipt);

    const prepared = await run("discard", "prepare", "plan:024");
    expect(prepared.result.ok).toBe(true);
    // La propuesta DICE que autorizarla autoriza commits — eso es la pregunta.
    expect(prepared.human).toContain("Commits que se revierten");
    expect(prepared.human).toContain("AUTORIZA commits");

    // El usuario no la autoriza: no se aplica nada. `apply` sin --approval es un
    // rechazo, no un default.
    const refused = await run("discard", "apply", "plan:024");
    expect(refused.result.ok).toBe(false);
    expect(refused.result.error?.code).toBe("APPROVAL_REQUIRED");
    expect(existsSync(join(workspace, planPath))).toBe(true);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(true);
    expect(git(source, "rev-parse", `refs/heads/aw/${folder}`)).toBe(receipt.after);
    expect(existsSync(paths.cwdHistoryFile())).toBe(false);
  });

  it("3 · resetea una ejecución parcial de plan y lo deja disponible para refinarse", async () => {
    const folder = await session("algo-plan-exec", [planPath]);
    writeFileSync(join(workspace, planPath), PLAN.replace("- [ ] T1.1", "- [x] T1.1"));

    const prepared = await run("reset", "prepare", planPath);
    expect(prepared.result.ok).toBe(true);
    const data = prepared.result.data as { digest: string };
    expect(prepared.human).toContain("Restaurar session:");
    expect(prepared.human).toContain("bytes-previos (cambió desde el baseline)");

    const applied = await run("reset", "apply", planPath, "--approval", data.digest);
    expect(applied.result.ok).toBe(true);
    // El plan volvió a sus bytes previos y sigue en el tablero, listo para refinar.
    expect(readFileSync(join(workspace, planPath), "utf-8")).toBe(PLAN);
    expect(existsSync(join(workspace, ".workflow", "sessions", folder))).toBe(false);
    const board = await runStatusCommand(fs, ctx.env, paths, { git: ctx.git });
    expect(board.plans.map((p) => p.number)).toEqual(["024"]);
    expect(board.pipeline.some((i) => i.command === `/w:plan-exec ${planPath}`)).toBe(true);
    expect(board.terminal_events[0]?.command).toBe("reset");
  });

  it("4 · un efecto compartido bloquea e informa, sin tocar nada", async () => {
    writeFileSync(join(workspace, "docs", "specs", "026-spec-otro.md"), SPEC);
    // Una sesión que declara dos padres: uno dentro del alcance y otro fuera.
    await session("compartida-plan-exec", [planPath, "docs/specs/026-spec-otro.md"]);
    const before = readFileSync(join(workspace, planPath), "utf-8");

    const prepared = await run("discard", "prepare", "spec:025");
    expect(prepared.result.ok).toBe(false);
    expect(prepared.result.error?.code).toBe("SHARED_CONSUMER");
    expect(prepared.result.error?.message).toContain("fuera del alcance");
    // Cero efectos: ni el documento, ni las sesiones, ni HISTORY.
    expect(readFileSync(join(workspace, planPath), "utf-8")).toBe(before);
    expect(existsSync(paths.cwdHistoryFile())).toBe(false);
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
    expect(existsSync(join(workspace, ".workflow", "sessions", quick))).toBe(false);
    const board = await runStatusCommand(fs, ctx.env, paths, { git: ctx.git });
    expect(board.sessions.active).toEqual([]);
    expect(board.terminal_events).toHaveLength(1);
  });

  it("las guardas del comando: verbo, objetivo y aprobación son obligatorios", async () => {
    for (const argv of [[], ["prepare"], ["borrar", "plan:024"], ["apply", "plan:024"]]) {
      const outcome = await run("discard", ...argv);
      expect(outcome.result.ok, argv.join(" ")).toBe(false);
      expect(outcome.result.exitCode, argv.join(" ")).toBe(1);
    }
    // Un objetivo inexistente es un rechazo accionable, no un error opaco.
    const missing = await run("discard", "prepare", "plan:999");
    expect(missing.result.ok).toBe(false);
    expect(missing.result.error?.code).toBe("TARGET_NOT_FOUND");
  });

  it("host de agente y terminal ven el MISMO alcance y el mismo digest", async () => {
    await session("algo-plan-exec", [planPath]);
    const cmd = command("discard");
    const result = await cmd.execute(parseArgv(["discard", "prepare", "plan:024"]), ctx);
    const data = result.data as {
      digest: string;
      preview: { disappears: Array<{ node: string }> };
    };

    // El host de agente consume el CommandResult tal cual; el terminal, su
    // proyección. Las dos salen del mismo objeto sellado.
    const plain = cmd.renderHuman?.(result, { detail: false }) ?? "";
    const detailed = cmd.renderHuman?.(result, { detail: true }) ?? "";
    for (const view of [plain, detailed]) {
      expect(view).toContain(data.digest);
      for (const entry of data.preview.disappears) expect(view).toContain(entry.node);
    }
    // Y una salida vacía nunca se confunde con un éxito: un rechazo no proyecta.
    const rejected = await cmd.execute(parseArgv(["discard", "prepare", "plan:999"]), ctx);
    expect(cmd.renderHuman?.(rejected, { detail: false })).toBe("");
  });
});
