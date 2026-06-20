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
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { RecordingGit } from "../helpers/fake-git.js";

class TestEnv implements EnvPort {
  constructor(private readonly cwdValue: string) {}
  get(): undefined {
    return undefined;
  }
  homeDir(): string {
    return this.cwdValue;
  }
  cwd(): string {
    return this.cwdValue;
  }
}

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
    return { fs, env: new TestEnv(cwd), paths, git } as unknown as CliContext;
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
