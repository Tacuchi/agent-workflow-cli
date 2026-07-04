import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfCommand } from "../../src/cli/commands/self.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

function buildArgs(rest: string[]): ParsedArgs {
  return {
    rest,
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
  };
}

function buildCtx(): CliContext {
  const ns = normalizeNamespace("workflow");
  const paths = new PathsService(ns, "/home/u", "/cwd");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  const proc: ProcessPort = {
    async run() {
      throw new Error("process.run should not be called in this test");
    },
    async which() {
      return undefined;
    },
  };
  return {
    fs: {} as never,
    env: new FakeEnv("/home/u", "/cwd"),
    process: proc,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

describe("selfCommand — without subcommand (H-07)", () => {
  it("returns ok:true with subcommands list and help_hint, exit 0", async () => {
    const noSub = await selfCommand.execute(buildArgs([]), buildCtx());
    expect(noSub.ok).toBe(true);
    if (noSub.ok) {
      const data = noSub.data as { subcommands: string[]; help_hint: string };
      expect(data.subcommands).toEqual([
        "namespace",
        "doctor",
        "detect-hosts",
        "update",
        "install",
        "install-skill",
        "install-hooks",
        "install-plugin-skills",
        "install-plugin-skills-git",
        "uninstall",
        "uninstall-skill",
        "clean-cache",
        "clean-legacy",
        "mcp",
        "bootstrap",
      ]);
      expect(data.help_hint).toContain("aw self");
      expect(noSub.exitCode).toBe(0);
    }
  });

  it("rejects unknown subcommand with INVALID_INPUT (preserves prior contract)", async () => {
    const result = await selfCommand.execute(buildArgs(["bogus"]), buildCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toContain("bogus");
    }
  });
});
