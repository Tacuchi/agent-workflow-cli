import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import type { GitFlowResult } from "../../src/application/git-flow-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { gitFlowCommand } from "../../src/cli/commands/git-flow.js";
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

const fs = new NodeFileSystem();

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
    });
    await writeFile(join(cwd, "CLAUDE.md"), block, "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function ctx(git: RecordingGit): CliContext {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd);
    return { fs, env: new FakeEnv(cwd), paths, git } as unknown as CliContext;
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

  it("--all: exit 1 por el agregado en las CUATRO acciones", async () => {
    for (const action of ["sync", "to-dev", "to-qa", "to-prod"]) {
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
});
