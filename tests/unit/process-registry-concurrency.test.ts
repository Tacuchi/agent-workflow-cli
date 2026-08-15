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

class FakeProc implements ProcessPort {
  alive = new Set<number>();
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async runBinary() {
    const { code, stdout, stderr } = await this.run();
    return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  }
  async which() {
    return undefined;
  }
  async spawnDetached(): Promise<never> {
    throw new Error("not used here");
  }
  async spawnInTerminal(): Promise<never> {
    throw new Error("not used here");
  }
  async killTree(pid: number): Promise<void> {
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
    startedAt: "2026-08-07T00:00:00.000Z",
    logPath: "/tmp/app.log",
    ...over,
  };
}

/**
 * Two flows launching at the same instant used to read the same array and each
 * write back its own copy — so the registry ended up showing one process while
 * the machine ran two, and the untracked one could never be stopped from the TUI.
 */
describe("ProcessRegistryService — read-modify-write under the workspace lock", () => {
  let dir: string;
  let file: string;
  let lock: string;
  let fs: NodeFileSystem;
  let proc: FakeProc;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proc-reg-lock-"));
    file = join(dir, "processes.json");
    lock = join(dir, ".lock");
    fs = new NodeFileSystem();
    proc = new FakeProc();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps both records when two registrations run concurrently", async () => {
    const svc = new ProcessRegistryService(fs, proc, file, lock);
    proc.alive.add(1001);
    proc.alive.add(1002);

    await Promise.all([
      svc.register(reg({ sourceAlias: "api", pid: 1001 })),
      svc.register(reg({ sourceAlias: "web", pid: 1002 })),
    ]);

    const stored = await svc.list();
    expect(stored.map((r) => r.sourceAlias).sort()).toEqual(["api", "web"]);
  });

  it("keeps every record when four registrations pile up at once", async () => {
    const svc = new ProcessRegistryService(fs, proc, file, lock);
    const pids = [2001, 2002, 2003, 2004];
    for (const pid of pids) proc.alive.add(pid);

    await Promise.all(pids.map((pid) => svc.register(reg({ sourceAlias: `s${pid}`, pid }))));

    const stored = await svc.list();
    expect(stored).toHaveLength(4);
    expect(new Set(stored.map((r) => r.pid))).toEqual(new Set(pids));
  });

  it("does not lose a concurrent registration to a concurrent removal", async () => {
    const svc = new ProcessRegistryService(fs, proc, file, lock);
    proc.alive.add(3001);
    const first = await svc.register(reg({ sourceAlias: "old", pid: 3000 }));
    proc.alive.add(3000);

    await Promise.all([svc.register(reg({ sourceAlias: "new", pid: 3001 })), svc.remove(first.id)]);

    const stored = await svc.list();
    expect(stored.map((r) => r.sourceAlias)).toEqual(["new"]);
  });

  it("still works with no lock configured (a registry outside any workspace)", async () => {
    const svc = new ProcessRegistryService(fs, proc, file);
    proc.alive.add(4001);

    await svc.register(reg({ sourceAlias: "solo", pid: 4001 }));

    expect((await svc.list()).map((r) => r.sourceAlias)).toEqual(["solo"]);
  });
});
