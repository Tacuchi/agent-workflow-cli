import { describe, expect, it, vi } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfUpdate } from "../../src/application/self/update-self.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { ProcessPort, RunOptions, RunResult } from "../../src/ports/process.js";
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

class ThrowingProcess implements ProcessPort {
  async run(_cmd: string, _args: string[], _opts?: RunOptions): Promise<RunResult> {
    throw new Error("process.run should not be invoked in --dry-run mode");
  }
  async which(_cmd: string): Promise<string | undefined> {
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal() {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }
}

class RecordingProcess implements ProcessPort {
  public invocations: Array<{ cmd: string; args: string[] }> = [];
  async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
    this.invocations.push({ cmd, args });
    return { code: 0, stdout: "ok", stderr: "" };
  }
  async which(_cmd: string): Promise<string | undefined> {
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal() {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }
}

function buildArgs(flags: string[]): ParsedArgs {
  return {
    rest: ["update"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(),
    valuesMulti: new Map(),
  };
}

function buildCtx(process: ProcessPort): CliContext {
  const ns = normalizeNamespace("workflow");
  const paths = new PathsService(ns, "/home/u", "/cwd");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: {} as never,
    env: new FakeEnv(),
    process,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

describe("selfUpdate — --dry-run (H-05)", () => {
  it("returns ok:true with would_run:true and does NOT invoke process.run", async () => {
    const proc = new ThrowingProcess();
    const result = await selfUpdate(buildArgs(["--dry-run"]), buildCtx(proc));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.would_run).toBe(true);
      expect(result.data.command).toBe("npm install -g @tacuchi/agent-workflow-cli@latest");
      expect(result.data.exit_code).toBe(0);
      expect(result.exitCode).toBe(0);
    }
  });

  it("dry-run preserves stdout/stderr empty (no execution happened)", async () => {
    const result = await selfUpdate(buildArgs(["--dry-run"]), buildCtx(new ThrowingProcess()));
    if (result.ok) {
      expect(result.data.stdout).toBe("");
      expect(result.data.stderr).toBe("");
    }
  });
});

describe("selfUpdate — without --dry-run", () => {
  it("invokes npm install when --dry-run flag is absent", async () => {
    // Note: TTY confirm is bypassed because vitest runs without a TTY.
    const proc = new RecordingProcess();
    const result = await selfUpdate(buildArgs([]), buildCtx(proc));
    expect(proc.invocations).toHaveLength(1);
    expect(proc.invocations[0]?.cmd).toBe("npm");
    expect(proc.invocations[0]?.args).toEqual([
      "install",
      "-g",
      "@tacuchi/agent-workflow-cli@latest",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.would_run).toBeUndefined();
    }
  });
});

describe("selfUpdate — confirm cancellation (TTY)", () => {
  function withFakeTty<T>(fn: () => Promise<T>): Promise<T> {
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    return fn().finally(() => {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: original });
    });
  }

  it("Ctrl-C / Esc en el confirm (rechaza la promise) cae como cancelled, no UNHANDLED", async () => {
    const proc = new RecordingProcess();
    const result = await withFakeTty(() =>
      selfUpdate(buildArgs([]), buildCtx(proc), async () => {
        throw new Error("User force closed the prompt with 0 null");
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.command).toBe("(cancelled)");
      expect(result.data.exit_code).toBe(0);
      expect(result.exitCode).toBe(0);
    }
    expect(proc.invocations).toHaveLength(0);
  });

  it("'no' explícito en el confirm también devuelve cancelled", async () => {
    const proc = new RecordingProcess();
    const result = await withFakeTty(() =>
      selfUpdate(buildArgs([]), buildCtx(proc), async () => false),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.command).toBe("(cancelled)");
    expect(proc.invocations).toHaveLength(0);
  });

  it("'sí' en el confirm dispara npm install", async () => {
    const proc = new RecordingProcess();
    const result = await withFakeTty(() =>
      selfUpdate(buildArgs([]), buildCtx(proc), async () => true),
    );
    expect(result.ok).toBe(true);
    expect(proc.invocations).toHaveLength(1);
  });

  it("--yes salta el confirm aunque haya TTY (path desde TUI)", async () => {
    const proc = new RecordingProcess();
    const confirmSpy = vi.fn();
    const result = await withFakeTty(() =>
      selfUpdate(buildArgs(["--yes"]), buildCtx(proc), confirmSpy),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(proc.invocations).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("-y también salta el confirm", async () => {
    const proc = new RecordingProcess();
    const confirmSpy = vi.fn();
    await withFakeTty(() => selfUpdate(buildArgs(["-y"]), buildCtx(proc), confirmSpy));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(proc.invocations).toHaveLength(1);
  });
});
