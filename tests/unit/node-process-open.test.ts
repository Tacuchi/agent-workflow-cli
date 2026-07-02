import { describe, expect, it } from "vitest";
import { NodeProcess } from "../../src/adapters/node-process.js";

describe("NodeProcess.openPath", () => {
  // Force platform "linux" so the builder yields `{cmd: app, args:[path]}` and we
  // can point it at a harmless binary instead of popping a real editor.
  it("resolves when the opener launches successfully", async () => {
    const proc = new NodeProcess("linux");
    // `true` exits 0 immediately → treated as a successful launch.
    await expect(proc.openPath("/tmp/whatever.log", { app: "true" })).resolves.toBeUndefined();
  });

  it("rejects when the opener binary is missing (ENOENT) — failure is observable", async () => {
    const proc = new NodeProcess("linux");
    await expect(
      proc.openPath("/tmp/x.log", { app: "aw-nonexistent-opener-xyz-123" }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects when the opener exits non-zero quickly (e.g. a bad app)", async () => {
    const proc = new NodeProcess("linux");
    // `false` exits 1 immediately → surfaced as an error, not swallowed.
    await expect(proc.openPath("/tmp/x.log", { app: "false" })).rejects.toThrow(/exited with code/);
  });
});
