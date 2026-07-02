import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock spawn so the win32 branches run on any host without launching real
// processes or opening console windows.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { NodeProcess } from "../../src/adapters/node-process.js";

interface ChildOpts {
  code?: number;
  stdout?: string;
  stderr?: string;
  pid?: number;
}

/** A minimal fake ChildProcess that emits its lifecycle on the next microtask. */
function makeChild({ code = 0, stdout = "", stderr = "", pid = 4242 }: ChildOpts = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void };
    pid: number;
    unref: () => void;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.pid = pid;
  child.unref = () => {};
  child.kill = () => {};
  // Emit after the caller attached its listeners (this same synchronous stack).
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("exit", code);
    child.emit("close", code);
  });
  return child;
}

const winProc = () => new NodeProcess("win32", { PATH: "C:\\bin" });

afterEach(() => spawnMock.mockReset());

describe("NodeProcess — win32 branches", () => {
  it("run() spawns npm under a shell on win32", async () => {
    spawnMock.mockImplementation(() => makeChild({ stdout: "10.0.0\n" }));
    const res = await winProc().run("npm", ["-v"]);
    expect(res.stdout).toContain("10.0.0");
    expect(spawnMock).toHaveBeenCalledWith("npm", ["-v"], expect.objectContaining({ shell: true }));
  });

  it.each(["gradle", "mvn", "build.bat", "run.cmd"])(
    "run() spawns %s under a shell on win32 (needsWinShell)",
    async (cmd) => {
      spawnMock.mockImplementation(() => makeChild({}));
      await winProc().run(cmd, []);
      expect(spawnMock).toHaveBeenLastCalledWith(cmd, [], expect.objectContaining({ shell: true }));
    },
  );

  it("run() does NOT use a shell for a plain binary on win32", async () => {
    spawnMock.mockImplementation(() => makeChild({}));
    await winProc().run("git", ["status"]);
    expect(spawnMock).toHaveBeenLastCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("which() shells out to `where` on win32 and returns the first line (CRLF-trimmed)", async () => {
    spawnMock.mockImplementation(() =>
      makeChild({ stdout: "C:\\tools\\node.exe\r\nC:\\other\\node.exe\r\n" }),
    );
    const found = await winProc().which("node");
    expect(spawnMock).toHaveBeenCalledWith("where", ["node"], expect.anything());
    expect(found).toBe("C:\\tools\\node.exe");
  });

  it("which() returns undefined when `where` exits non-zero", async () => {
    spawnMock.mockImplementation(() => makeChild({ code: 1 }));
    expect(await winProc().which("nope")).toBeUndefined();
  });

  it("killTree() uses `taskkill /PID <pid> /T /F` on win32", async () => {
    spawnMock.mockImplementation(() => makeChild({}));
    await winProc().killTree(1234);
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "1234", "/T", "/F"],
      expect.anything(),
    );
  });

  it("spawnInTerminal() opens a PowerShell console on win32 (mode=terminal)", async () => {
    spawnMock.mockImplementation(() => makeChild({ pid: 999 }));
    const res = await winProc().spawnInTerminal("npm", ["run", "dev"], {
      cwd: "C:\\app",
      env: { PATH: "C:\\bin" },
      envDelta: {},
      logPath: "C:\\app\\run.log",
      title: "app",
    });
    expect(res).toEqual({ pid: 999, mode: "terminal" });
    const [cmd, args] = spawnMock.mock.calls[0] ?? [];
    expect(cmd).toBe("powershell");
    expect(args).toContain("-NoExit");
  });
});
