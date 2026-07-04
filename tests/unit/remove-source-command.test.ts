import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { removeSourceCommand } from "../../src/cli/commands/remove-source.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

class FakeProc implements ProcessPort {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async which() {
    return undefined;
  }
  async spawnDetached() {
    return { pid: 0 };
  }
  async spawnInTerminal() {
    return { pid: 0, mode: "background" as const };
  }
  async killTree() {}
  async isAlive() {
    return true;
  }
}

function args(rest: string[]): ParsedArgs {
  return {
    rest,
    plugin: {},
    flags: new Set<string>(),
    values: new Map<string, string>(),
    valuesMulti: new Map<string, string[]>(),
  };
}

const fs = new NodeFileSystem();

describe("remove-source command", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-remove-source-cmd-"));
    const block = renderProjectBlock({
      proyecto: "Test",
      fuentes: [
        { alias: "core", path: "/repo/core", main_branch: "main" },
        { alias: "plugin", path: "/repo/plugin", main_branch: "main" },
      ],
      stack: {},
      lastActivity: "2026-01-01 00:00",
    });
    await writeFile(join(cwd, "CLAUDE.md"), block, "utf8");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function ctx(): CliContext {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd);
    return { fs, env: new FakeEnv(cwd), paths, process: new FakeProc() } as unknown as CliContext;
  }

  it("errors with usage when no alias is given", async () => {
    const result = await removeSourceCommand.execute(args([]), ctx());
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("errors for an unknown alias", async () => {
    const result = await removeSourceCommand.execute(args(["ghost"]), ctx());
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("removes a known source", async () => {
    const result = await removeSourceCommand.execute(args(["plugin"]), ctx());
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
