import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { loadLogs } from "../../src/cli/tui/data/logs.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/cwd");
const LOGS = "/home/u/.agent-workflow/logs";

function ctxWith(fs: unknown): CliContext {
  return { fs, paths } as unknown as CliContext;
}

describe("loadLogs", () => {
  it("lists only daily log files, newest (mtime) first, with date + size", async () => {
    // size comes from stat (content length); mtime from the seeded file mtime.
    const fs = new MemFs()
      .file(`${LOGS}/agent-workflow-2026-06-30.log`, "x".repeat(100), new Date(2026, 5, 30))
      .file(`${LOGS}/agent-workflow-2026-07-01.log`, "x".repeat(250), new Date(2026, 6, 1))
      .file(`${LOGS}/notes.txt`, "") // ignored: not a daily log
      .dir(`${LOGS}/subdir`); // ignored: not a file
    const logs = await loadLogs(ctxWith(fs));
    expect(logs.map((l) => l.name)).toEqual([
      "agent-workflow-2026-07-01.log",
      "agent-workflow-2026-06-30.log",
    ]);
    expect(logs[0]?.date).toBe("2026-07-01");
    expect(logs[0]?.sizeBytes).toBe(250);
    expect(logs[0]?.path).toBe(`${LOGS}/agent-workflow-2026-07-01.log`);
  });

  it("returns [] when the logs dir does not exist", async () => {
    // Unregistered dir → strict MemFs list() throws → loadLogs swallows to [].
    const logs = await loadLogs(ctxWith(new MemFs()));
    expect(logs).toEqual([]);
  });
});
