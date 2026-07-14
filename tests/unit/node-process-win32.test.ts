import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const winProc = (pidfilePollMs?: number) =>
  new NodeProcess("win32", { PATH: "C:\\bin" }, pidfilePollMs);

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

  it("spawnInTerminal() launches via the Start-Process hop and reads the console PID from the pidfile", async () => {
    let pidFilePath = "";
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "powershell") {
        // Mimic the real chain: Start-Process opens a console whose inline body
        // writes its own $PID to the pidfile (path baked into the payload,
        // with '' = escaped quote inside the single-quoted body element).
        pidFilePath =
          /Set-Content -LiteralPath ''([^']+)'' -Value \$PID/.exec(args[4] ?? "")?.[1] ?? "";
        if (pidFilePath) writeFileSync(pidFilePath, "999");
      }
      return makeChild({ pid: 555 });
    });
    const logPath = join(tmpdir(), "aw-win32-test.log");
    const res = await winProc().spawnInTerminal("npm", ["run", "dev"], {
      cwd: "C:\\app",
      env: { PATH: "C:\\bin" },
      envDelta: {},
      logPath,
      title: "app",
    });
    // The registered pid is the visible console's (from the pidfile), never the launcher's.
    expect(res).toEqual({ pid: 999, mode: "terminal" });
    const [cmd, args, spawnOpts] = spawnMock.mock.calls[0] ?? [];
    expect(cmd).toBe("powershell");
    expect(args[4]).toContain("Start-Process");
    expect(args[4]).toContain("'-NoProfile','-NoExit'");
    // Env (with the launch deltas) travels via spawn — the chain inherits it.
    expect(spawnOpts).toMatchObject({ env: { PATH: "C:\\bin" } });
    // The pidfile is consumed on success: a leftover would be read as a FUTURE
    // launch's console under a recycled process.pid (→ taskkill on a foreign pid).
    expect(existsSync(pidFilePath)).toBe(false);
    // Terminal mode leaves a marker so "Ver log" never shows a stale run as current.
    expect(readFileSync(logPath, "utf8")).toBe(
      "[lanzado en consola — la salida vive en la ventana]\n",
    );
  });

  it("spawnInTerminal() drops the abort marker on a silent hop-1 timeout and still cascades to conhost", async () => {
    let hop1PidFile = "";
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "powershell") {
        // Launcher "succeeds" (exit 0) but no console ever writes the pidfile.
        hop1PidFile =
          /Set-Content -LiteralPath ''([^']+)'' -Value \$PID/.exec(args[4] ?? "")?.[1] ?? "";
        return makeChild({ code: 0, pid: 555 });
      }
      if (cmd === "conhost.exe") {
        const pidFilePath =
          /Set-Content -LiteralPath '([^']+)' -Value \$PID/.exec(args[6] ?? "")?.[1] ?? "";
        if (pidFilePath) writeFileSync(pidFilePath, "888");
      }
      return makeChild({ pid: 556 });
    });
    const res = await winProc(150).spawnInTerminal("npm", ["run", "dev"], {
      cwd: "C:\\app",
      env: { PATH: "C:\\bin" },
      envDelta: {},
      logPath: join(tmpdir(), "aw-win32-test.log"),
      title: "app",
    });
    expect(res).toEqual({ pid: 888, mode: "terminal" });
    // The double-launch guard: hop 1's timed-out attempt leaves ITS abort marker
    // so a very late console self-aborts instead of starting the app again.
    expect(existsSync(`${hop1PidFile}.abort`)).toBe(true);
    rmSync(`${hop1PidFile}.abort`, { force: true });
  });

  it("spawnInTerminal() cascades to the conhost hop when Start-Process fails", async () => {
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "powershell") return makeChild({ code: 1, pid: 555 });
      if (cmd === "conhost.exe") {
        // The body rides argv verbatim on this hop (its OWN pidfile, un-doubled quotes).
        const pidFilePath =
          /Set-Content -LiteralPath '([^']+)' -Value \$PID/.exec(args[6] ?? "")?.[1] ?? "";
        if (pidFilePath) writeFileSync(pidFilePath, "888");
      }
      return makeChild({ pid: 556 });
    });
    const res = await winProc().spawnInTerminal("npm", ["run", "dev"], {
      cwd: "C:\\app",
      env: { PATH: "C:\\bin" },
      envDelta: {},
      logPath: join(tmpdir(), "aw-win32-test.log"),
      title: "app",
    });
    expect(res).toEqual({ pid: 888, mode: "terminal" });
    expect(spawnMock.mock.calls.map((c) => c[0])).toEqual(["powershell", "conhost.exe"]);
  });

  it("spawnInTerminal() falls back to background with the per-hop reasons when every hop fails", async () => {
    spawnMock.mockImplementation((cmd: string) =>
      cmd === "powershell" || cmd === "conhost.exe"
        ? makeChild({ code: 1, pid: 555 })
        : makeChild({ pid: 777 }),
    );
    const res = await winProc().spawnInTerminal("npm", ["run", "dev"], {
      cwd: "C:\\app",
      env: { PATH: "C:\\bin" },
      envDelta: {},
      logPath: join(tmpdir(), "aw-win32-test.log"),
      title: "app",
    });
    expect(res).toEqual({
      pid: 777,
      mode: "background",
      terminalError:
        "Start-Process: powershell salió con código 1 · conhost: conhost.exe salió con código 1",
    });
  });
});
