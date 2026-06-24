import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  type ProcessRegistration,
  ProcessRegistryService,
} from "../../src/application/process-registry-service.js";
import type { ProcessPort } from "../../src/ports/process.js";

/** Fake ProcessPort whose liveness is fully controllable per pid. */
class FakeProc implements ProcessPort {
  alive = new Set<number>();
  killed: number[] = [];
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async which() {
    return undefined;
  }
  async spawnDetached() {
    throw new Error("not used here");
  }
  async killTree(pid: number): Promise<void> {
    this.killed.push(pid);
    this.alive.delete(pid);
  }
  async isAlive(pid: number): Promise<boolean> {
    return this.alive.has(pid);
  }
}

function reg(over: Partial<ProcessRegistration> = {}): ProcessRegistration {
  return {
    sourceAlias: "app",
    profile: null,
    command: "npm",
    args: ["start"],
    pid: 1000,
    startedAt: "2026-06-23T00:00:00.000Z",
    logPath: "/tmp/app.log",
    ...over,
  };
}

describe("ProcessRegistryService", () => {
  let dir: string;
  let file: string;
  let fs: NodeFileSystem;
  let proc: FakeProc;
  let svc: ProcessRegistryService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proc-reg-"));
    file = join(dir, "processes.json");
    fs = new NodeFileSystem();
    proc = new FakeProc();
    svc = new ProcessRegistryService(fs, proc, file);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("list() on a missing registry returns []", async () => {
    expect(await svc.list()).toEqual([]);
  });

  it("register() stores a running record with a derived id", async () => {
    const rec = await svc.register(reg({ pid: 1000, profile: "dev" }));
    expect(rec.state).toBe("running");
    expect(rec.id).toBe("app__dev__1000");
    proc.alive.add(1000);
    const all = await svc.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("app__dev__1000");
  });

  it("list() reconciles a dead running pid to exited and persists it", async () => {
    await svc.register(reg({ pid: 1000 }));
    await svc.register(reg({ pid: 2000, sourceAlias: "web" }));
    proc.alive.add(2000); // 1000 is dead

    const all = await svc.list();
    const byPid = Object.fromEntries(all.map((r) => [r.pid, r.state]));
    expect(byPid[1000]).toBe("exited");
    expect(byPid[2000]).toBe("running");

    // Persisted: a second list() (with isAlive irrelevant for sticky exited) keeps exited.
    proc.alive.clear();
    const again = await svc.list();
    expect(again.find((r) => r.pid === 1000)?.state).toBe("exited");
  });

  it("markStopped() is sticky — survives reconciliation even if still alive", async () => {
    const rec = await svc.register(reg({ pid: 1000 }));
    proc.alive.add(1000);
    await svc.markStopped(rec.id);
    const all = await svc.list();
    expect(all[0]?.state).toBe("stopped");
  });

  it("remove() drops the record", async () => {
    const rec = await svc.register(reg({ pid: 1000 }));
    await svc.remove(rec.id);
    expect(await svc.list()).toEqual([]);
  });

  it("register() replaces a stale record sharing the same recycled id", async () => {
    await svc.register(reg({ pid: 1000, profile: "dev" }));
    const second = await svc.register(reg({ pid: 1000, profile: "dev", command: "node" }));
    const all = await svc.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.command).toBe("node");
    expect(second.id).toBe("app__dev__1000");
  });

  it("a corrupt registry degrades to [] rather than throwing", async () => {
    await fs.writeText(file, "{ not json");
    expect(await svc.list()).toEqual([]);
  });
});
