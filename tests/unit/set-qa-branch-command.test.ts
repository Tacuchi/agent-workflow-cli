import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { setQaBranchCommand } from "../../src/cli/commands/set-qa-branch.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

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

function args(rest: string[]): ParsedArgs {
  return {
    rest,
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
  };
}

describe("set-qa-branch command", () => {
  const fs = new NodeFileSystem();
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-set-qa-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function ctx(): CliContext {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd);
    return { fs, env: new TestEnv(cwd), paths } as unknown as CliContext;
  }

  it("rejects missing alias/branch with INVALID_INPUT", async () => {
    const result = await setQaBranchCommand.execute(args(["core"]), ctx());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("upserts qa_branches[alias] into the WORKSPACE block", async () => {
    const result = await setQaBranchCommand.execute(args(["core", "desarrollo"]), ctx());
    expect(result.ok).toBe(true);
    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("- Ramas QA actuales:");
    expect(claude).toContain("  - core: desarrollo");
  });
});
