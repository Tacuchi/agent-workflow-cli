import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LogsListOutput, runLogs } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("runLogs — global daily log", () => {
  let home: string;
  let paths: PathsService;
  const env: EnvPort = { get: () => undefined, homeDir: () => home, cwd: () => home };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aw-logs-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), home, home);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads today's global daily log (tailing lines)", async () => {
    const today = paths.userDailyLogFile(new Date());
    mkdirSync(dirname(today), { recursive: true });
    writeFileSync(today, "l1\nl2\n");
    const out = (await runLogs(env, paths, { tail: 10 })) as LogsListOutput;
    expect(out.path).toBe(today);
    expect(out.lines).toEqual(["l1", "l2"]);
  });

  it("--clear removes ALL daily logs (today + older)", async () => {
    const today = paths.userDailyLogFile(new Date());
    mkdirSync(dirname(today), { recursive: true });
    writeFileSync(today, "x");
    const older = join(paths.userLogsDir(), "agent-workflow-2020-01-01.log");
    writeFileSync(older, "old");
    const out = await runLogs(env, paths, { clear: true });
    expect("cleared" in out && out.cleared).toBe(true);
    expect(existsSync(today)).toBe(false);
    expect(existsSync(older)).toBe(false);
  });

  it("reports no log file when today's daily is absent", async () => {
    const out = (await runLogs(env, paths, {})) as LogsListOutput;
    expect(out.message).toBe("No log file found");
  });
});
