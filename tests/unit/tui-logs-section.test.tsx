import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { LogsSection } from "../../src/cli/tui/components/logs-section.js";
import type { LogEntry } from "../../src/cli/tui/data/logs.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date(2026, 6, 1, 12, 0, 0);

const logs: LogEntry[] = [
  {
    path: "/home/u/.agent-workflow/logs/agent-workflow-2026-07-01.log",
    name: "agent-workflow-2026-07-01.log",
    date: "2026-07-01",
    sizeBytes: 2048,
    mtime: new Date(2026, 6, 1, 9, 0, 0),
  },
  {
    path: "/home/u/.agent-workflow/logs/agent-workflow-2026-06-30.log",
    name: "agent-workflow-2026-06-30.log",
    date: "2026-06-30",
    sizeBytes: 500,
    mtime: new Date(2026, 5, 30, 9, 0, 0),
  },
];

const noop = () => {};

describe("LogsSection", () => {
  it("renders the daily logs with date and clear path", () => {
    const { lastFrame } = render(
      <LogsSection
        logs={logs}
        focused={false}
        now={NOW}
        onOpen={noop}
        onOpenWith={noop}
        onExit={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("LOGS"); // SectionHead uppercases the label
    expect(frame).toContain("2026-07-01");
    expect(frame).toContain("agent-workflow-2026-07-01.log");
  });

  it("shows an empty-state when there are no logs", () => {
    const { lastFrame } = render(
      <LogsSection
        logs={[]}
        focused={false}
        now={NOW}
        onOpen={noop}
        onOpenWith={noop}
        onExit={noop}
      />,
    );
    expect((lastFrame() ?? "").toLowerCase()).toContain("sin logs");
  });

  it("Enter (focused) opens the selected log with the default app", async () => {
    const opened: LogEntry[] = [];
    const { stdin } = render(
      <LogsSection
        logs={logs}
        focused={true}
        now={NOW}
        onOpen={(e) => opened.push(e)}
        onOpenWith={noop}
        onExit={noop}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(opened[0]?.date).toBe("2026-07-01");
  });

  it("Down then Enter opens the second log", async () => {
    const opened: LogEntry[] = [];
    const { stdin } = render(
      <LogsSection
        logs={logs}
        focused={true}
        now={NOW}
        onOpen={(e) => opened.push(e)}
        onOpenWith={noop}
        onExit={noop}
      />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(opened[0]?.date).toBe("2026-06-30");
  });

  it("'a' + typing an app + Enter opens-with that app", async () => {
    const withApp: Array<[string, string]> = [];
    const { stdin } = render(
      <LogsSection
        logs={logs}
        focused={true}
        now={NOW}
        lastApp=""
        onOpen={noop}
        onOpenWith={(e, app) => withApp.push([e.date, app])}
        onExit={noop}
      />,
    );
    await tick();
    stdin.write("a");
    await tick();
    stdin.write("vim");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(withApp[0]).toEqual(["2026-07-01", "vim"]);
  });

  it("ignores input when not focused", async () => {
    const opened: LogEntry[] = [];
    const { stdin } = render(
      <LogsSection
        logs={logs}
        focused={false}
        now={NOW}
        onOpen={(e) => opened.push(e)}
        onOpenWith={noop}
        onExit={noop}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(opened).toEqual([]);
  });
});
