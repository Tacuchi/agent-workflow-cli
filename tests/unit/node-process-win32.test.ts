import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { NodeProcess } from "../../src/adapters/node-process.js";

function child({ code = 0, stdout = "" }: { code?: number; stdout?: string } = {}) {
  const process = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void };
  };
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.stdin = { end: () => {} };
  queueMicrotask(() => {
    if (stdout) process.stdout.emit("data", Buffer.from(stdout));
    process.emit("close", code);
  });
  return process;
}

afterEach(() => spawnMock.mockReset());

describe("NodeProcess — ejecución Windows sin lanzador de fuentes", () => {
  const proc = () => new NodeProcess("win32", { PATH: "C:\\bin" });

  it.each(["npm", "gradle", "mvn", "build.bat", "run.cmd"])(
    "ejecuta %s bajo shell en Windows",
    async (cmd) => {
      spawnMock.mockImplementation(() => child({ stdout: "ok\n" }));
      expect((await proc().run(cmd, ["-v"])).stdout).toBe("ok\n");
      expect(spawnMock).toHaveBeenLastCalledWith(
        cmd,
        ["-v"],
        expect.objectContaining({ shell: true }),
      );
    },
  );

  it("no abre shell para git y where resuelve el primer ejecutable", async () => {
    spawnMock.mockImplementation(() => child({ stdout: "C:\\tools\\node.exe\r\n" }));
    await proc().run("git", ["status"]);
    expect(spawnMock).toHaveBeenLastCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ shell: false }),
    );
    expect(await proc().which("node")).toBe("C:\\tools\\node.exe");
    expect(spawnMock).toHaveBeenLastCalledWith("where", ["node"], expect.anything());
  });

  it("which devuelve undefined cuando where falla", async () => {
    spawnMock.mockImplementation(() => child({ code: 1 }));
    expect(await proc().which("nope")).toBeUndefined();
  });
});
