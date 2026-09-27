import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import type { GitFlowResult } from "../../src/application/git-flow-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import {
  type ConfirmFn,
  createGitFlowCommand,
  gitFlowCommand,
} from "../../src/cli/commands/git-flow.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";

interface ArgOpts {
  rest?: string[];
  flags?: string[];
  values?: Record<string, string>;
  valuesMulti?: Record<string, string[]>;
}

function args(opts: ArgOpts): ParsedArgs {
  return {
    rest: opts.rest ?? [],
    plugin: {},
    flags: new Set(opts.flags ?? []),
    values: new Map(Object.entries(opts.values ?? {})),
    valuesMulti: new Map(Object.entries(opts.valuesMulti ?? {})),
  };
}

const fs = new (class extends NodeFileSystem {
  override async exists(path: string): Promise<boolean> {
    return path.startsWith("/repo/") || super.exists(path);
  }
})();

describe("git-flow command", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-git-flow-cmd-"));
    const block = renderProjectBlock({
      proyecto: "Test",
      fuentes: [{ alias: "core", path: "/repo/core", main_branch: "certificacion" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
      markers: new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd).blockMarkers(),
    });
    await writeFile(join(cwd, "CLAUDE.md"), block, "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function ctx(
    git: RecordingGit,
    opts: { tty?: boolean; vars?: Record<string, string> } = {},
  ): CliContext {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd);
    const process = { hasTty: () => opts.tty ?? false };
    const env = new FakeEnv(cwd, cwd, opts.vars ?? {});
    return { fs, env, paths, git, process } as unknown as CliContext;
  }

  it("rejects a missing/invalid action with INVALID_INPUT", async () => {
    const r1 = await gitFlowCommand.execute(args({}), ctx(new RecordingGit()));
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe("INVALID_INPUT");

    const r2 = await gitFlowCommand.execute(args({ rest: ["bogus"] }), ctx(new RecordingGit()));
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("INVALID_INPUT");
  });

  it("dispatches sync for --source (multi-value flag) and reports ok", async () => {
    const git = new RecordingGit({ currentBranch: "feature/x" });
    const result = await gitFlowCommand.execute(
      args({ rest: ["sync"], valuesMulti: { source: ["core"] } }),
      ctx(git),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const data = result.data as GitFlowResult;
    expect(data.action).toBe("sync");
    expect(data.status).toBe("ok");
    // The service actually drove git (proves dispatch wired ctx.git through).
    expect(git.calls.some((c) => c.op === "merge")).toBe(true);
  });

  it("passes --dry-run through (no git calls)", async () => {
    const git = new RecordingGit({ currentBranch: "feature/x" });
    const result = await gitFlowCommand.execute(
      args({ rest: ["to-qa"], valuesMulti: { source: ["core"] }, flags: ["--dry-run"] }),
      ctx(git),
    );
    expect(result.ok).toBe(true);
    const data = result.data as GitFlowResult;
    expect(data.dry_run).toBe(true);
    expect(git.calls).toEqual([]);
  });

  it("passes --target through to override the destination", async () => {
    const git = new RecordingGit({ currentBranch: "feature/x" });
    const result = await gitFlowCommand.execute(
      args({
        rest: ["to-qa"],
        valuesMulti: { source: ["core"] },
        values: { target: "release/9" },
      }),
      ctx(git),
    );
    expect(result.ok).toBe(true);
    expect(git.calls.some((c) => c.op === "push" && c.arg === "release/9")).toBe(true);
  });

  it("accepts to-dev and promotes onto the workspace development branch", async () => {
    const git = new RecordingGit({ currentBranch: "feature/x" });
    const result = await gitFlowCommand.execute(
      args({ rest: ["to-dev"], valuesMulti: { source: ["core"] } }),
      ctx(git),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode ?? 0).toBe(0);
    // Sin default declarado en el bloque, dev cae al piso `development`.
    expect(git.calls.some((c) => c.op === "push" && c.arg === "development")).toBe(true);
  });

  it("returns exitCode 2 (paused, not error) on a merge conflict", async () => {
    const git = new RecordingGit({
      currentBranch: "feature/x",
      conflicts: { certificacion: ["a.ts"] },
    });
    const result = await gitFlowCommand.execute(
      args({ rest: ["sync"], valuesMulti: { source: ["core"] } }),
      ctx(git),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(2);
    const data = result.data as GitFlowResult;
    expect(data.status).toBe("conflict");
  });

  /**
   * Two sources whose bases differ, so a scripted conflict hits ONLY the second.
   * The failure must never be first: otherwise `results[0].status` coincides with
   * the aggregate and a CLI reading the head instead of `data.status` passes.
   */
  async function writeTwoSources(): Promise<void> {
    const block = renderProjectBlock({
      proyecto: "Test",
      fuentes: [
        { alias: "core", path: "/repo/core", main_branch: "main" },
        { alias: "ui", path: "/repo/ui", main_branch: "release" },
      ],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      workingBranches: { core: "feat-a", ui: "feat-b" },
      markers: new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd).blockMarkers(),
    });
    await writeFile(join(cwd, "CLAUDE.md"), block, "utf8");
  }

  it("--all con TODAS las fuentes en ok: exit 0", async () => {
    await writeTwoSources();
    const git = new RecordingGit({ currentBranch: "feat-a" });

    const result = await gitFlowCommand.execute(
      args({ rest: ["sync"], flags: ["--all"] }),
      ctx(git),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect((result.data as GitFlowResult).results.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("--all: un error en la SEGUNDA fuente da exit 1 (el agregado manda, no la primera)", async () => {
    await writeTwoSources();
    const git = new RecordingGit({ currentBranch: "feat-a", dirtyRepos: ["/repo/ui"] });

    const result = await gitFlowCommand.execute(
      args({ rest: ["sync"], flags: ["--all"] }),
      ctx(git),
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const data = result.data as GitFlowResult;
    expect(data.results.map((r) => r.status)).toEqual(["ok", "error"]);
    expect(data.status).toBe("error");
  });

  it("--all: exit 1 por el agregado en las TRES acciones que no publican en PROD", async () => {
    for (const action of ["sync", "to-dev", "to-qa"]) {
      await writeTwoSources();
      const git = new RecordingGit({ currentBranch: "feat-a", dirtyRepos: ["/repo/ui"] });

      const result = await gitFlowCommand.execute(
        args({ rest: [action], flags: ["--all"] }),
        ctx(git),
      );

      expect(result.ok, `acción ${action}`).toBe(false);
      expect(result.exitCode, `acción ${action}`).toBe(1);
      const data = result.data as GitFlowResult;
      expect(
        data.results.map((r) => r.status),
        `acción ${action}`,
      ).toEqual(["ok", "error"]);
    }
  });

  it("--all: un conflicto en la SEGUNDA fuente da exit 2 (el agregado manda, no la primera)", async () => {
    await writeTwoSources();
    // Solo `ui` mergea `release`: la 1ª fuente termina ok.
    const git = new RecordingGit({ currentBranch: "feat-a", conflicts: { release: ["c.ts"] } });

    const result = await gitFlowCommand.execute(
      args({ rest: ["sync"], flags: ["--all"] }),
      ctx(git),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(2);
    const data = result.data as GitFlowResult;
    expect(data.results.map((r) => r.status)).toEqual(["ok", "conflict"]);
    expect(data.status).toBe("conflict");
  });

  it("returns a failing result with exitCode 1 on a validation/error status", async () => {
    const git = new RecordingGit({ currentBranch: "feature/x" });
    const result = await gitFlowCommand.execute(
      args({ rest: ["sync"], valuesMulti: { source: ["nope"] } }),
      ctx(git),
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("GIT_FLOW_ERROR");
  });

  describe("publicar en PROD exige a la persona (AC-02, AC-03, AC-09)", () => {
    const MOVING = new Set(["checkout", "fetch", "ff", "merge", "push"]);
    const moved = (git: RecordingGit) => git.calls.filter((c) => MOVING.has(c.op));

    /** A confirm double that records every question and answers `answer`. */
    function confirmer(answer: boolean | Error): ConfirmFn & { asked: string[] } {
      const asked: string[] = [];
      const fn = async (message: string) => {
        asked.push(message);
        if (answer instanceof Error) throw answer;
        return answer;
      };
      return Object.assign(fn, { asked });
    }

    const toProd = (extra: ArgOpts = {}) =>
      args({ rest: ["to-prod"], valuesMulti: { source: ["core"] }, ...extra });

    it("sin terminal interactiva no publica, no pregunta y manda a la persona al TUI o a su terminal", async () => {
      const git = new RecordingGit({ currentBranch: "feature/x" });
      const confirm = confirmer(true);

      const result = await createGitFlowCommand(confirm).execute(toProd(), ctx(git));

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("GIT_FLOW_NEEDS_PERSON");
      expect(result.error?.message).toMatch(/TUI.*propia terminal/);
      expect(result.error?.message).toMatch(/sin terminal|no tiene terminal/);
      // La vista previa viaja con el rechazo, con las ramas reales.
      expect(result.error?.message).toContain("merge feature/x→certificacion");
      expect(result.error?.message).toContain("push certificacion");
      expect(confirm.asked).toEqual([]);
      expect(moved(git)).toEqual([]);
    });

    for (const marker of ["CLAUDECODE", "AI_AGENT", "OZ_RUN_ID", "CODEX_THREAD_ID"]) {
      it(`con terminal y el marcador ${marker}, cuenta como del agente y no publica`, async () => {
        const git = new RecordingGit({ currentBranch: "feature/x" });
        const confirm = confirmer(true);
        const vars = { [marker]: "1", TERM_PROGRAM: "WarpTerminal" };

        const result = await createGitFlowCommand(confirm).execute(
          toProd(),
          ctx(git, { tty: true, vars }),
        );

        expect(result.error?.code).toBe("GIT_FLOW_NEEDS_PERSON");
        expect(result.error?.message).toContain(marker);
        expect(confirm.asked).toEqual([]);
        expect(moved(git)).toEqual([]);
      });
    }

    it("un marcador presente con valor vacío también cuenta como del agente", async () => {
      const git = new RecordingGit({ currentBranch: "feature/x" });
      const confirm = confirmer(true);

      const result = await createGitFlowCommand(confirm).execute(
        toProd(),
        ctx(git, { tty: true, vars: { CLAUDECODE: "" } }),
      );

      expect(result.error?.code).toBe("GIT_FLOW_NEEDS_PERSON");
      expect(confirm.asked).toEqual([]);
      expect(moved(git)).toEqual([]);
    });

    it("con terminal y sin marcadores, pregunta mostrando la vista previa, y sólo el sí publica", async () => {
      const git = new RecordingGit({ currentBranch: "feature/x" });
      const confirm = confirmer(true);

      const result = await createGitFlowCommand(confirm).execute(toProd(), ctx(git, { tty: true }));

      expect(result.ok).toBe(true);
      expect(confirm.asked).toHaveLength(1);
      expect(confirm.asked[0]).toContain("merge feature/x→certificacion");
      expect(git.calls.some((c) => c.op === "push" && c.arg === "certificacion")).toBe(true);
    });

    it("decir que no, o cerrar la pregunta, deja todo intacto", async () => {
      for (const answer of [false, new Error("ExitPromptError")]) {
        const git = new RecordingGit({ currentBranch: "feature/x" });

        const result = await createGitFlowCommand(confirmer(answer)).execute(
          toProd(),
          ctx(git, { tty: true }),
        );

        expect(result.error?.code).toBe("GIT_FLOW_PROD_DECLINED");
        expect(moved(git)).toEqual([]);
      }
    });

    it("las marcas de Warp solas (TERM_PROGRAM y WARP_IS_LOCAL_SHELL_SESSION) cuentan como la persona", async () => {
      const git = new RecordingGit({ currentBranch: "feature/x" });
      const confirm = confirmer(true);
      const vars = { TERM_PROGRAM: "WarpTerminal", WARP_IS_LOCAL_SHELL_SESSION: "1" };

      const result = await createGitFlowCommand(confirm).execute(
        toProd(),
        ctx(git, { tty: true, vars }),
      );

      expect(result.ok).toBe(true);
      expect(confirm.asked).toHaveLength(1);
      expect(git.calls.some((c) => c.op === "push")).toBe(true);
    });

    it("una confirmación por stdin no publica: sin terminal en la entrada no hay a quién preguntar", async () => {
      // `echo y | aw git-flow to-prod …`: stdin es un pipe, así que hasTty() es falso.
      const git = new RecordingGit({ currentBranch: "feature/x" });
      const confirm = confirmer(true);

      const result = await createGitFlowCommand(confirm).execute(
        toProd(),
        ctx(git, { tty: false }),
      );

      expect(result.error?.code).toBe("GIT_FLOW_NEEDS_PERSON");
      expect(confirm.asked).toEqual([]);
      expect(moved(git)).toEqual([]);
    });

    it("ningún flag inventado equivale al consentimiento", async () => {
      for (const flag of ["--yes", "--confirm", "-y"]) {
        const git = new RecordingGit({ currentBranch: "feature/x" });
        const agent = await createGitFlowCommand(confirmer(true)).execute(
          toProd({ flags: [flag] }),
          ctx(git),
        );
        expect(agent.error?.code, flag).toBe("GIT_FLOW_NEEDS_PERSON");
        expect(moved(git), flag).toEqual([]);

        const person = new RecordingGit({ currentBranch: "feature/x" });
        const declined = await createGitFlowCommand(confirmer(false)).execute(
          toProd({ flags: [flag] }),
          ctx(person, { tty: true }),
        );
        expect(declined.error?.code, flag).toBe("GIT_FLOW_PROD_DECLINED");
        expect(moved(person), flag).toEqual([]);
      }
    });

    it("to-dev --target certificacion sin consentimiento devuelve la vista previa y no cambia ninguna rama", async () => {
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await gitFlowCommand.execute(
        args({
          rest: ["to-dev"],
          valuesMulti: { source: ["core"] },
          values: { target: "certificacion" },
        }),
        ctx(git),
      );

      expect(result.error?.code).toBe("GIT_FLOW_NEEDS_PERSON");
      const data = result.data as GitFlowResult;
      expect(data.consent_required?.sources).toEqual(["core"]);
      expect(data.results[0]?.steps.at(-1)?.preview).toBe("push certificacion");
      expect(moved(git)).toEqual([]);
    });

    it("to-prod --all se rechaza con el mensaje que pide la lista", async () => {
      await writeTwoSources();
      const git = new RecordingGit({ currentBranch: "feat-a" });
      const confirm = confirmer(true);

      const result = await createGitFlowCommand(confirm).execute(
        args({ rest: ["to-prod"], flags: ["--all"] }),
        ctx(git, { tty: true }),
      );

      expect(result.error?.code).toBe("GIT_FLOW_ERROR");
      expect(result.error?.message).toMatch(/--all no vale.*--source/);
      expect(confirm.asked).toEqual([]);
      expect(moved(git)).toEqual([]);
    });

    it("--source repetido publica exactamente las fuentes nombradas", async () => {
      await writeTwoSources();
      const git = new RecordingGit({ currentBranch: "feat-a" });
      const confirm = confirmer(true);

      const result = await createGitFlowCommand(confirm).execute(
        args({ rest: ["to-prod"], valuesMulti: { source: ["ui", "core"] } }),
        ctx(git, { tty: true }),
      );

      expect(result.ok).toBe(true);
      expect(confirm.asked[0]).toMatch(/ui: .*\ncore: /);
      const pushed = git.calls.filter((c) => c.op === "push").map((c) => `${c.repo} ${c.arg}`);
      expect(pushed).toEqual(["/repo/ui release", "/repo/core main"]);
    });

    it("desarrollo y QA siguen publicando sin preguntar", async () => {
      for (const action of ["to-dev", "to-qa"]) {
        const git = new RecordingGit({ currentBranch: "feature/x" });
        const confirm = confirmer(false);
        const result = await createGitFlowCommand(confirm).execute(
          args({ rest: [action], valuesMulti: { source: ["core"] } }),
          ctx(git),
        );
        expect(result.ok, action).toBe(true);
        expect(confirm.asked, action).toEqual([]);
        expect(
          git.calls.some((c) => c.op === "push"),
          action,
        ).toBe(true);
      }
    });
  });

  describe("el log recibe la fuente, el paso y el stderr de cada fuente fallida (AC-06)", () => {
    function logged(): { lines: Array<{ level: string; message: string }>; logger: unknown } {
      const lines: Array<{ level: string; message: string }> = [];
      return {
        lines,
        logger: {
          log: async (level: string, message: string) => {
            lines.push({ level, message });
          },
        },
      };
    }

    it("un checkout fallido deja la fuente, el paso y el stderr de git", async () => {
      await writeTwoSources();
      const git = new RecordingGit({ currentBranch: "feat-a", throwOn: "checkout" });
      const sink = logged();
      const context = { ...ctx(git), logger: sink.logger } as unknown as CliContext;

      await gitFlowCommand.execute(args({ rest: ["sync"], flags: ["--all"] }), context);

      expect(sink.lines.map((l) => l.level)).toEqual(["error", "error"]);
      expect(sink.lines[0]?.message).toMatch(
        /^git-flow sync · core · pull feat-a → error: pull feat-a failed: git checkout failed \(scripted\)$/,
      );
      expect(sink.lines[1]?.message).toMatch(/· ui · /);
    });

    it("un stderr de varias líneas queda en UNA línea de log", async () => {
      await writeTwoSources();
      const git = new RecordingGit({ currentBranch: "feat-a" });
      git.push = async () => {
        throw new Error(
          "git push main failed in /repo/core: To origin\n ! [rejected] main -> main (fetch first)\nerror: failed to push",
        );
      };
      const sink = logged();
      const context = { ...ctx(git, { tty: true }), logger: sink.logger } as unknown as CliContext;

      await createGitFlowCommand(async () => true).execute(
        args({ rest: ["to-prod"], valuesMulti: { source: ["core"] } }),
        context,
      );

      expect(sink.lines).toHaveLength(1);
      expect(sink.lines[0]?.message).not.toContain("\n");
      expect(sink.lines[0]?.message).toMatch(
        /To origin \| ! \[rejected\] .* \| error: failed to push$/,
      );
    });

    it("un merge anterior deja la línea con su rama y su origen, sin repetirlos", async () => {
      await writeTwoSources();
      const git = new RecordingGit({
        currentBranch: "feat-a",
        merging: true,
        mergeOrigin: "origin/feat-a",
      });
      const sink = logged();
      const context = { ...ctx(git), logger: sink.logger } as unknown as CliContext;

      await gitFlowCommand.execute(
        args({ rest: ["sync"], valuesMulti: { source: ["core"] } }),
        context,
      );

      expect(sink.lines).toEqual([
        {
          level: "error",
          message:
            "git-flow sync · core · precondición → error: hay un merge a medias sobre feat-a, traído por origin/feat-a: resolvelo y commitealo, y volvé a correr",
        },
      ]);
    });

    it("un conflicto deja una línea de aviso con la rama y la que lo trajo; una fuente ok no deja nada", async () => {
      await writeTwoSources();
      const git = new RecordingGit({ currentBranch: "feat-a", conflicts: { release: ["c.ts"] } });
      const sink = logged();
      const context = { ...ctx(git), logger: sink.logger } as unknown as CliContext;

      await gitFlowCommand.execute(args({ rest: ["sync"], flags: ["--all"] }), context);

      expect(sink.lines).toEqual([
        {
          level: "warn",
          message:
            "git-flow sync · ui · merge prod→work → conflict: merge sobre feat-b, traído por release; archivos: c.ts",
        },
      ]);
    });
  });
});
