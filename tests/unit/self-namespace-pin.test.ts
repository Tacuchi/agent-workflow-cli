import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { NamespaceResolver } from "../../src/runtime/namespace-resolver.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

class FakeEnv implements EnvPort {
  constructor(
    private home: string,
    private cwdDir: string,
  ) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this.home;
  }
  cwd() {
    return this.cwdDir;
  }
}

class RealFs implements FileSystemPort {
  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
  async writeText(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
  }
  async writeTextExclusive(path: string, content: string): Promise<{ created: boolean }> {
    try {
      await stat(path);
      return { created: false };
    } catch {
      await writeFile(path, content, "utf8");
      return { created: true };
    }
  }
  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  // Empty cwd → workspace auto-detect never matches, so resolve() reaches the config file.
  async list(): Promise<DirEntry[]> {
    return [];
  }
  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async stat(): Promise<FileStat> {
    throw new Error("nyi");
  }
}

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
