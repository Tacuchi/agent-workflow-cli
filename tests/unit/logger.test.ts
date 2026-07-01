import { describe, expect, it } from "vitest";
import { Logger } from "../../src/application/logging/logger.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const paths = new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/cwd");

/** Minimal in-memory sink: only `appendText` is exercised by the Logger. */
class MemFs {
  appended = new Map<string, string>();
  async appendText(path: string, content: string): Promise<void> {
    this.appended.set(path, (this.appended.get(path) ?? "") + content);
  }
}

const asFs = (m: unknown) => m as FileSystemPort;

describe("Logger", () => {
  it("appends a timestamped INFO line to the daily GLOBAL log", async () => {
    const fs = new MemFs();
    const logger = new Logger({ fs: asFs(fs), paths, now: () => new Date(2026, 6, 1, 10, 0, 0) });
    await logger.info("run: status");
    const file = "/home/u/.agent-workflow/logs/agent-workflow-2026-07-01.log";
    const written = fs.appended.get(file) ?? "";
    expect(written).toContain("INFO");
    expect(written).toContain("run: status");
    expect(written.endsWith("\n")).toBe(true);
  });

  it("rotates to a new file when the calendar day changes", async () => {
    const fs = new MemFs();
    let d = new Date(2026, 6, 1, 23, 59);
    const logger = new Logger({ fs: asFs(fs), paths, now: () => d });
    await logger.info("a");
    d = new Date(2026, 6, 2, 0, 1);
    await logger.info("b");
    expect(fs.appended.has("/home/u/.agent-workflow/logs/agent-workflow-2026-07-01.log")).toBe(
      true,
    );
    expect(fs.appended.has("/home/u/.agent-workflow/logs/agent-workflow-2026-07-02.log")).toBe(
      true,
    );
  });

  it("records the level for warnings and errors", async () => {
    const fs = new MemFs();
    const logger = new Logger({ fs: asFs(fs), paths, now: () => new Date(2026, 6, 1) });
    await logger.warn("careful");
    await logger.error("boom");
    const all = [...fs.appended.values()].join("");
    expect(all).toContain("WARN careful");
    expect(all).toContain("ERROR boom");
  });

  it("redacts secret-looking values (never writes tokens/passwords)", async () => {
    const fs = new MemFs();
    const logger = new Logger({ fs: asFs(fs), paths, now: () => new Date(2026, 6, 1) });
    await logger.info("run: mcp add --token sk-supersecret123 --password hunter2 --name db");
    const all = [...fs.appended.values()].join("");
    expect(all).not.toContain("sk-supersecret123");
    expect(all).not.toContain("hunter2");
    expect(all).toContain("--token ***");
    expect(all).toContain("--password ***");
    expect(all).toContain("--name db"); // non-secret args survive
  });

  it("never throws even if the sink fails (logging is best-effort)", async () => {
    const failing = {
      appendText: async () => {
        throw new Error("disk full");
      },
    };
    const logger = new Logger({ fs: asFs(failing), paths, now: () => new Date(2026, 6, 1) });
    await expect(logger.info("x")).resolves.toBeUndefined();
  });
});
