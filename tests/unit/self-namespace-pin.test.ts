import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  selfNamespace,
  selfNamespacePin,
  writeNamespacePin,
} from "../../src/application/self/namespace-info.js";
import { selfCommand } from "../../src/cli/commands/self.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { NamespaceResolver } from "../../src/runtime/namespace-resolver.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
// NoScanFs stubs list()→[] so workspace auto-detect never matches the sandbox,
// letting resolve() reach the config file (the whole point of these tests).
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

function buildCtx(home: string, cwdDir: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new RealFs(),
    env: new FakeEnv(home, cwdDir),
    process: {} as ProcessPort,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, cwdDir),
  };
}

function buildArgs(rest: string[], values: Record<string, string> = {}): ParsedArgs {
  return {
    rest,
    plugin: {},
    flags: new Set(),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

describe("self namespace --pin", () => {
  let workdir: string;
  let home: string;
  let cwdDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-ns-pin-"));
    home = join(workdir, "home");
    cwdDir = join(workdir, "cwd");
    await mkdir(home, { recursive: true });
    await mkdir(cwdDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("pins the namespace and round-trips through NamespaceResolver (source 'config')", async () => {
    const ctx = buildCtx(home, cwdDir);
    const result = await selfNamespacePin(ctx, "myproj");

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.pinned).toBe("myproj");
      expect(result.data.path).toBe(join(home, ".config", "agent-workflow", "namespace"));
    }

    // The resolver (same file it reads) picks it up as source "config".
    const resolved = await new NamespaceResolver(new RealFs(), new FakeEnv(home, cwdDir)).resolve(
      undefined,
    );
    expect(resolved.namespace).toBe("myproj");
    expect(resolved.source).toBe("config");
  });

  it("writeNamespacePin writes exactly `<name>\\n` at the resolver's path", async () => {
    const path = await writeNamespacePin(new RealFs(), home, "workflow");
    expect(path).toBe(join(home, ".config", "agent-workflow", "namespace"));
    expect(await readFile(path, "utf8")).toBe("workflow\n");
  });

  it("rejects an invalid namespace and writes nothing", async () => {
    const ctx = buildCtx(home, cwdDir);
    const result = await selfNamespacePin(ctx, "Bad Name!");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_NAMESPACE");

    let existed = true;
    try {
      await stat(join(home, ".config", "agent-workflow", "namespace"));
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
  });

  it("`self namespace` without --pin stays read-only (no file written)", async () => {
    const ctx = buildCtx(home, cwdDir);
    const result = await selfNamespace(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) expect(result.data.namespace).toBe("agent-workflow");

    let existed = true;
    try {
      await stat(join(home, ".config", "agent-workflow", "namespace"));
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
  });

  it("selfCommand routes `namespace --pin` to the writer", async () => {
    const ctx = buildCtx(home, cwdDir);
    const result = await selfCommand.execute(buildArgs(["namespace"], { pin: "otra-ns" }), ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect((result.data as { pinned: string }).pinned).toBe("otra-ns");
    }
    expect(await readFile(join(home, ".config", "agent-workflow", "namespace"), "utf8")).toBe(
      "otra-ns\n",
    );
  });

  it("self describe documents --pin", () => {
    expect(selfCommand.describe).toContain("--pin");
  });
});
