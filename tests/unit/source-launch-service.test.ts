import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ProcessRegistryService } from "../../src/application/process-registry-service.js";
import type { LaunchDescriptor } from "../../src/application/source-launch-scripts-service.js";
import {
  type LaunchDeps,
  findCollision,
  launchSource,
  logFileFor,
  readDescriptor,
  relaunchProcess,
  resolveLaunch,
  stopProcess,
  tailLog,
} from "../../src/application/source-launch-service.js";
import type {
  ProcessPort,
  SpawnDetachedResult,
  SpawnInTerminalOptions,
  SpawnInTerminalResult,
} from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

class FakeProc implements ProcessPort {
  terminalSpawns: { cmd: string; args: string[]; opts: SpawnInTerminalOptions }[] = [];
  killed: number[] = [];
  alive = new Set<number>();
  nextPid = 5000;
  /** What the (impure) adapter would report — the service just records it. */
  mode: "terminal" | "background" = "terminal";
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async which() {
    return undefined;
  }
  async spawnDetached(): Promise<SpawnDetachedResult> {
    throw new Error("the service must launch via spawnInTerminal, not spawnDetached");
  }
  async spawnInTerminal(
    cmd: string,
    args: string[],
    opts: SpawnInTerminalOptions,
  ): Promise<SpawnInTerminalResult> {
    const pid = this.nextPid++;
    this.terminalSpawns.push({ cmd, args, opts });
    this.alive.add(pid);
    return { pid, mode: this.mode };
  }
  async killTree(pid: number): Promise<void> {
    this.killed.push(pid);
    this.alive.delete(pid);
  }
  async isAlive(pid: number): Promise<boolean> {
    return this.alive.has(pid);
  }
}

function descriptor(over: Partial<LaunchDescriptor> = {}): LaunchDescriptor {
  return {
    version: 1,
    source: "app",
    stack: "npm",
    cwd: "/src/app",
    command: "npm",
    args: ["run", "dev"],
    params: [
      { name: "PORT", default: "3000", secret: false },
      { name: "API_TOKEN", default: "", secret: true },
    ],
    profiles: ["dev", "prod"],
    ...over,
  };
}

describe("source-launch-service — pure logic", () => {
  it("logFileFor includes the profile when present", () => {
    expect(logFileFor("/logs", "app", "dev")).toBe("/logs/app-dev.log");
    expect(logFileFor("/logs", "app", null)).toBe("/logs/app.log");
  });

  it("resolveLaunch merges params + user values + PROFILE into env", () => {
    const r = resolveLaunch(
      descriptor(),
      { alias: "app", profile: "dev", values: { API_TOKEN: "sk-123" } },
      "/logs",
      { PATH: "/usr/bin" },
    );
    expect(r).not.toBeNull();
    expect(r?.command).toBe("npm");
    expect(r?.args).toEqual(["run", "dev"]);
    expect(r?.cwd).toBe("/src/app");
    expect(r?.env.PATH).toBe("/usr/bin"); // base env preserved
    expect(r?.env.PORT).toBe("3000"); // default
    expect(r?.env.API_TOKEN).toBe("sk-123"); // user value overrides empty secret default
    expect(r?.env.PROFILE).toBe("dev");
    expect(r?.logPath).toBe("/logs/app-dev.log");
  });

  it("resolveLaunch exposes env deltas (params + PROFILE) apart from the base env", () => {
    const r = resolveLaunch(
      descriptor(),
      { alias: "app", profile: "dev", values: { API_TOKEN: "sk-123" } },
      "/logs",
      { PATH: "/usr/bin" },
    );
    // Deltas are what a terminal that doesn't inherit our env must have baked in.
    expect(r?.envDelta).toEqual({ PORT: "3000", API_TOKEN: "sk-123", PROFILE: "dev" });
    expect(r?.envDelta.PATH).toBeUndefined(); // base env is NOT a delta
  });

  it("resolveLaunch translates the JVM wrapper to its .bat twin on win32 only", () => {
    const desc = descriptor({ command: "./gradlew", args: ["bootRun"] });
    const req = { alias: "app", profile: null, values: {} };
    expect(resolveLaunch(desc, req, "/logs", {}, "win32")?.command).toBe("./gradlew.bat");
    expect(resolveLaunch(desc, req, "/logs", {}, "darwin")?.command).toBe("./gradlew");
    expect(resolveLaunch(desc, req, "/logs", {}, "linux")?.command).toBe("./gradlew");
  });

  it("resolveLaunch returns null when the descriptor has no command", () => {
    expect(
      resolveLaunch(
        descriptor({ command: null }),
        { alias: "app", profile: null, values: {} },
        "/logs",
        {},
      ),
    ).toBeNull();
  });

  it("findCollision matches a running same-source+profile, ignoring others", () => {
    const procs = [
      {
        id: "a",
        sourceAlias: "app",
        profile: "dev",
        pid: 1,
        state: "running" as const,
        command: "npm",
        args: [],
        startedAt: "",
        logPath: "",
      },
      {
        id: "b",
        sourceAlias: "app",
        profile: "prod",
        pid: 2,
        state: "running" as const,
        command: "npm",
        args: [],
        startedAt: "",
        logPath: "",
      },
      {
        id: "c",
        sourceAlias: "app",
        profile: "dev",
        pid: 3,
        state: "stopped" as const,
        command: "npm",
        args: [],
        startedAt: "",
        logPath: "",
      },
    ];
    expect(findCollision(procs, "app", "dev")?.id).toBe("a");
    expect(findCollision(procs, "app", "qa")).toBeUndefined();
    expect(findCollision(procs, "web", "dev")).toBeUndefined();
  });
});

describe("source-launch-service — launch/stop/relaunch", () => {
  let ws: string;
  let fs: NodeFileSystem;
  let proc: FakeProc;
  let deps: LaunchDeps;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "launch-svc-"));
    fs = new NodeFileSystem();
    proc = new FakeProc();
    const paths = new PathsService(normalizeNamespace("workflow"), ws, ws);
    deps = {
      fs,
      proc,
      paths,
      baseEnv: { PATH: "/usr/bin" },
      now: () => "2026-06-23T12:00:00.000Z",
    };
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  function writeDescriptor(alias: string, desc: LaunchDescriptor) {
    const dir = join(ws, ".workflow", "launch", alias);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "launch.json"), JSON.stringify(desc));
  }

  it("launchSource opens a terminal, tees to a log, and registers a running record + mode", async () => {
    writeDescriptor("app", descriptor());
    const res = await launchSource(deps, {
      alias: "app",
      profile: "dev",
      values: { API_TOKEN: "x" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.state).toBe("running");
    expect(res.record.pid).toBe(5000);
    expect(res.record.launchMode).toBe("terminal");
    expect(proc.terminalSpawns).toHaveLength(1);
    expect(proc.terminalSpawns[0]?.cmd).toBe("npm");
    expect(proc.terminalSpawns[0]?.opts.logPath).toBe(join(ws, "docs", "logs", "app-dev.log"));
    expect(proc.terminalSpawns[0]?.opts.envDelta.PROFILE).toBe("dev");
    expect(proc.terminalSpawns[0]?.opts.title).toContain("app");

    // Persisted in the registry.
    const registry = new ProcessRegistryService(fs, proc, deps.paths.cwdProcessesFile());
    const listed = await registry.list();
    expect(listed.map((r) => r.pid)).toContain(5000);
  });

  it("launchSource records background mode when the adapter fell back (no terminal)", async () => {
    writeDescriptor("app", descriptor({ profiles: [], params: [] }));
    proc.mode = "background";
    const res = await launchSource(deps, { alias: "app", profile: null, values: {} });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.launchMode).toBe("background");
  });

  it("launchSource errors when no descriptor exists", async () => {
    const res = await launchSource(deps, { alias: "ghost", profile: null, values: {} });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("no_descriptor");
  });

  it("stopProcess kills the tree and marks the record stopped", async () => {
    writeDescriptor("app", descriptor({ profiles: [], params: [] }));
    const launched = await launchSource(deps, { alias: "app", profile: null, values: {} });
    if (!launched.ok) throw new Error("launch failed");
    await stopProcess(deps, launched.record);
    expect(proc.killed).toContain(launched.record.pid);
    const registry = new ProcessRegistryService(fs, proc, deps.paths.cwdProcessesFile());
    const listed = await registry.list();
    expect(listed.find((r) => r.id === launched.record.id)?.state).toBe("stopped");
  });

  it("relaunchProcess stops the old process and launches a fresh one", async () => {
    writeDescriptor("app", descriptor({ profiles: [], params: [] }));
    const first = await launchSource(deps, { alias: "app", profile: null, values: {} });
    if (!first.ok) throw new Error("launch failed");
    const again = await relaunchProcess(deps, first.record);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(proc.killed).toContain(first.record.pid);
    expect(again.record.pid).not.toBe(first.record.pid);
  });

  it("persists non-secret values (for relaunch) but never the secret ones", async () => {
    writeDescriptor("app", descriptor()); // PORT (non-secret) + API_TOKEN (secret)
    const launched = await launchSource(deps, {
      alias: "app",
      profile: "dev",
      values: { PORT: "8080", API_TOKEN: "sk-secret" },
    });
    if (!launched.ok) throw new Error("launch failed");
    expect(launched.record.values).toEqual({ PORT: "8080" }); // secret excluded
    expect(JSON.stringify(launched.record)).not.toContain("sk-secret");

    // Relaunch reuses the persisted non-secret value.
    const again = await relaunchProcess(deps, launched.record);
    if (!again.ok) throw new Error("relaunch failed");
    expect(proc.terminalSpawns.at(-1)?.opts.env?.PORT).toBe("8080");
  });

  it("tailLog returns the last lines of a log", async () => {
    const log = join(ws, "out.log");
    writeFileSync(log, "l1\nl2\nl3\nl4\n");
    expect(await tailLog(fs, log, 2)).toEqual(["l3", "l4"]);
    expect(await tailLog(fs, join(ws, "missing.log"), 2)).toEqual([]);
  });

  it("readDescriptor reads a written descriptor and returns null when absent", async () => {
    writeDescriptor("app", descriptor());
    const launchDir = join(ws, ".workflow", "launch");
    expect((await readDescriptor(fs, launchDir, "app"))?.command).toBe("npm");
    expect(await readDescriptor(fs, launchDir, "nope")).toBeNull();
  });
});
