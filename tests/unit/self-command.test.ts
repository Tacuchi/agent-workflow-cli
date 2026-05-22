import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfCommand } from "../../src/cli/commands/self.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

class FakeEnv implements EnvPort {
  get() {
    return undefined;
  }
  homeDir() {
    return "/home/u";
  }
  cwd() {
    return "/cwd";
  }
}

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
    env: new FakeEnv(),
    process: proc,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

describe("selfCommand — without subcommand (H-07)", () => {
  it("returns ok:true with subcommands list and help_hint, exit 0", async () => {
    const result = await selfCommand.execute(buildArgs(["self"]), buildCtx());
    // rest[0] === "self" is not a subcommand of self; the dispatcher reads rest[0] which
    // for the actual self command call is the SUBCOMMAND. Simulate a "no sub" call by
    // passing rest = [] explicitly.
    const noSub = await selfCommand.execute(buildArgs([]), buildCtx());
    expect(noSub.ok).toBe(true);
    if (noSub.ok) {
      const data = noSub.data as { subcommands: string[]; help_hint: string };
      expect(data.subcommands).toEqual([
        "namespace",
        "doctor",
        "detect-hosts",
        "update",
        "install-skill",
        "install-hooks",
        "install-plugin-skills",
        "install-plugin-skills-git",
        "uninstall-skill",
        "mcp",
        "bootstrap",
      ]);
      expect(data.help_hint).toContain("aw self");
      expect(noSub.exitCode).toBe(0);
    }
    // First call (rest=["self"]) is treated as unknown subcommand "self" → error envelope.
    expect(result.ok).toBe(false);
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
