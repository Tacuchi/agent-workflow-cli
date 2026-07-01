import { describe, expect, it } from "vitest";
import { NodeProcess } from "../../src/adapters/node-process.js";

describe("NodeProcess.openPath", () => {
  // Force platform "linux" so the builder yields `{cmd: app, args:[path]}` and we
  // can point it at a harmless binary (`true`) instead of popping a real editor.
  it("spawns the opener for a specific app (best-effort, resolves)", async () => {
    const proc = new NodeProcess("linux");
    await expect(proc.openPath("/tmp/whatever.log", { app: "true" })).resolves.toBeUndefined();
  });

  it("is best-effort: a missing opener does not throw", async () => {
    const proc = new NodeProcess("linux");
    await expect(
      proc.openPath("/tmp/x.log", { app: "aw-nonexistent-opener-xyz-123" }),
    ).resolves.toBeUndefined();
  });
});
