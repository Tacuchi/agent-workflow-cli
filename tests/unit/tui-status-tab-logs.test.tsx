import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import type { LogEntry } from "../../src/cli/tui/data/logs.js";
import { StatusTab } from "../../src/cli/tui/tabs/status-tab.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const ENTER = "\r";
const RIGHT = "\x1B[C";
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const logs: LogEntry[] = [
  {
    path: "/home/u/.agent-workflow/logs/agent-workflow-2026-07-01.log",
    name: "agent-workflow-2026-07-01.log",
    date: "2026-07-01",
    sizeBytes: 2048,
    mtime: new Date(2026, 6, 1, 9, 0, 0),
  },
];

function buildCtx(opened: string[]): CliContext {
  return {
    fs: {
      exists: async (p: string) => p === logs[0]?.path,
      readText: async () => {
        throw new Error("nyi");
      },
      list: async () => [],
      stat: async () => {
        throw new Error("nyi");
      },
      appendText: async () => {},
    },
    env: { homeDir: () => "/home/u", cwd: () => "/ws", get: () => undefined },
    process: {
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      openPath: async (p: string) => {
        opened.push(p);
      },
    },
    paths: new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/ws"),
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default",
    },
    namespace: { namespace: normalizeNamespace("agent-workflow"), source: "default" },
    skills: {},
  } as unknown as CliContext;
}

describe("StatusTab — Logs section", () => {
  it("shows the Logs section in place of Recent", async () => {
    const { lastFrame } = render(
      <StatusTab ctx={buildCtx([])} version="9.9.9" isActive={true} logs={logs} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("LOGS");
    expect(frame).not.toContain("Recent");
    expect(frame).not.toContain("RECENT");
    expect(frame).toContain("agent-workflow-2026-07-01.log");
  });

  it("shows an empty-state when there are no logs", async () => {
    const { lastFrame } = render(
      <StatusTab ctx={buildCtx([])} version="9.9.9" isActive={true} logs={[]} />,
    );
    await tick();
    expect((lastFrame() ?? "").toLowerCase()).toContain("sin logs");
  });

  it("Enter on the logs tile enters Logs mode; Enter opens the log via openPath", async () => {
    const opened: string[] = [];
    const { stdin } = render(
      <StatusTab ctx={buildCtx(opened)} version="9.9.9" isActive={true} logs={logs} />,
    );
    await tick();
    // Move the tile cursor cli→hosts→hooks→mcp→logs, enter Logs mode, then open.
    for (let i = 0; i < 4; i++) {
      stdin.write(RIGHT);
      await tick(20);
    }
    stdin.write(ENTER); // enter Logs mode
    await tick(40);
    stdin.write(ENTER); // open selected log
    await tick(60);
    expect(opened).toEqual(["/home/u/.agent-workflow/logs/agent-workflow-2026-07-01.log"]);
  });

  it("Enter on the hosts tile activates the Workline tab (admin moved there)", async () => {
    const activated: string[] = [];
    const { stdin } = render(
      <StatusTab
        ctx={buildCtx([])}
        version="9.9.9"
        isActive={true}
        logs={logs}
        onActivateTab={(t) => activated.push(t)}
      />,
    );
    await tick();
    stdin.write(RIGHT); // cli → hosts
    await tick(20);
    stdin.write(ENTER);
    await tick(40);
    expect(activated).toEqual(["workflow"]);
  });
});
