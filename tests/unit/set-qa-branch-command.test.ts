import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  setExceptionBranchCommand,
  setQaBranchCommand,
} from "../../src/cli/commands/set-branch.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

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
    return { fs, env: new FakeEnv(cwd), paths } as unknown as CliContext;
  }

  it("rejects missing alias/branch with INVALID_INPUT", async () => {
    const result = await setQaBranchCommand.execute(args(["core"]), ctx());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("upserts qa_branches[alias] into the WORKSPACE block", async () => {
    const result = await setQaBranchCommand.execute(args(["core", "desarrollo"]), ctx());
    expect(result.ok).toBe(true);
    const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("- Ramas QA actuales:");
    expect(agentsMd).toContain("  - core: desarrollo");
  });

  it("declara hotfix y rechaza desarrollo/PROD como excepción", async () => {
    await writeFile(
      join(cwd, "AGENTS.md"),
      `<!-- AGENT-WORKFLOW-HUB-START -->\n## Hub\nTest\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| core | ${cwd} | main |\n## Status\n- Ramas por defecto:\n  - desarrollo: development\n<!-- AGENT-WORKFLOW-HUB-END -->`,
    );
    expect((await setExceptionBranchCommand.execute(args(["core", "development"]), ctx())).ok).toBe(
      false,
    );
    expect((await setExceptionBranchCommand.execute(args(["core", "main"]), ctx())).ok).toBe(false);
    expect((await setExceptionBranchCommand.execute(args(["core", "hotfix/one"]), ctx())).ok).toBe(
      true,
    );
    expect((await setExceptionBranchCommand.execute(args(["core", "hotfix/two"]), ctx())).ok).toBe(
      true,
    );
    const text = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(text).toContain("  - core: hotfix/two");
    expect(text).not.toContain("hotfix/one");
  });
});
