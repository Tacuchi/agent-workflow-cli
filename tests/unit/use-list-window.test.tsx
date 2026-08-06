import type { EventEmitter } from "node:events";
import { Box, Text, useInput } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { notificationStackRows } from "../../src/cli/tui/components/notification-stack.js";
import {
  NotificationCenterProvider,
  useNotifications,
} from "../../src/cli/tui/notification-center.js";
import { useListCursor } from "../../src/cli/tui/use-list-cursor.js";
import { useListWindow } from "../../src/cli/tui/use-list-window.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const tick = () => new Promise((r) => setTimeout(r, 30));

type FakeStdout = EventEmitter & { rows?: number };

function setRows(stdout: unknown, rows: number) {
  const fake = stdout as FakeStdout;
  fake.rows = rows;
  fake.emit("resize");
}

function Harness({
  count,
  reserved,
  maxVisible,
}: {
  count: number;
  reserved: number;
  maxVisible?: number;
}) {
  const { cursor, moveUp, moveDown } = useListCursor(count);
  const win = useListWindow(count, cursor, reserved, maxVisible);
  useInput((_input, key) => {
    if (key.downArrow) moveDown();
    if (key.upArrow) moveUp();
  });
  const rows: number[] = [];
  for (let i = win.start; i < Math.min(count, win.start + win.visible); i++) rows.push(i);
  return (
    <Box flexDirection="column">
      <Text>{`cursor=${cursor} start=${win.start} visible=${win.visible} above=${win.hiddenAbove} below=${win.hiddenBelow}`}</Text>
      {rows.map((i) => (
        <Text key={i}>{`row<${i}>`}</Text>
      ))}
    </Box>
  );
}

describe("useListWindow", () => {
  it("covers the whole list when the height is unknown (non-TTY)", async () => {
    const { lastFrame } = render(<Harness count={15} reserved={6} />);
    await tick();
    expect(lastFrame()).toContain("visible=15");
    expect(lastFrame()).toContain("row<0>");
    expect(lastFrame()).toContain("row<14>");
  });

  it("windows to the viewport: only `rows - reserved` rows render", async () => {
    const { lastFrame, stdout } = render(<Harness count={15} reserved={6} />);
    await tick();
    setRows(stdout, 12);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("visible=6");
    expect(frame).toContain("below=9");
    expect(frame).toContain("row<0>");
    expect(frame).toContain("row<5>");
    expect(frame).not.toContain("row<6>");
  });

  it("keeps the cursor reachable: scrolling down moves the window", async () => {
    const { stdin, lastFrame, stdout } = render(<Harness count={15} reserved={6} />);
    await tick();
    setRows(stdout, 12);
    await tick();
    for (let i = 0; i < 14; i++) {
      stdin.write(DOWN);
      await tick();
    }
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cursor=14");
    expect(frame).toContain("start=9");
    expect(frame).toContain("above=9");
    expect(frame).toContain("below=0");
    expect(frame).toContain("row<14>");
    expect(frame).not.toContain("row<8>");
  });

  it("scrolls up only when the cursor reaches the top edge", async () => {
    const { stdin, lastFrame, stdout } = render(<Harness count={15} reserved={6} />);
    await tick();
    setRows(stdout, 12);
    await tick();
    for (let i = 0; i < 14; i++) {
      stdin.write(DOWN);
      await tick();
    }
    for (let i = 0; i < 3; i++) {
      stdin.write(UP);
      await tick();
    }
    // cursor=11 still inside window 9..14 → the window does not move.
    expect(lastFrame()).toContain("start=9");
    for (let i = 0; i < 4; i++) {
      stdin.write(UP);
      await tick();
    }
    // cursor=7 crossed the top edge → the window follows.
    expect(lastFrame()).toContain("start=7");
  });

  it("adapts the window when the terminal is resized", async () => {
    const { lastFrame, stdout } = render(<Harness count={15} reserved={6} />);
    await tick();
    setRows(stdout, 12);
    await tick();
    expect(lastFrame()).toContain("visible=6");
    setRows(stdout, 18);
    await tick();
    expect(lastFrame()).toContain("visible=12");
    expect(lastFrame()).toContain("row<11>");
  });

  it("honors maxVisible even when the viewport is taller", async () => {
    const { lastFrame, stdout } = render(<Harness count={15} reserved={0} maxVisible={8} />);
    await tick();
    setRows(stdout, 50);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("visible=8");
    expect(frame).toContain("row<7>");
    expect(frame).not.toContain("row<8>");
  });

  it("handles an empty list", async () => {
    const { lastFrame, stdout } = render(<Harness count={0} reserved={6} />);
    await tick();
    setRows(stdout, 12);
    await tick();
    expect(lastFrame()).toContain("start=0");
    expect(lastFrame()).toContain("visible=0");
    expect(lastFrame()).toContain("below=0");
  });

  it("clamps the window when the list shrinks under it", async () => {
    const { stdin, lastFrame, stdout, rerender } = render(<Harness count={15} reserved={6} />);
    await tick();
    setRows(stdout, 12);
    await tick();
    for (let i = 0; i < 14; i++) {
      stdin.write(DOWN);
      await tick();
    }
    expect(lastFrame()).toContain("start=9");
    rerender(<Harness count={5} reserved={6} />);
    await tick();
    // count=5 fits the viewport (visible=5) → maxStart=0 pulls the window home.
    expect(lastFrame()).toContain("start=0");
    expect(lastFrame()).toContain("row<4>");
  });

  it("shrinks the window while a notification occupies rows", async () => {
    const { stdin, lastFrame, stdout } = render(
      <NotificationCenterProvider>
        <NotifHarness count={15} reserved={6} />
      </NotificationCenterProvider>,
    );
    await tick();
    setRows(stdout, 12);
    await tick();
    // Banner with body = 2 rows + stack marginBottom 1 → reserved 6+3=9 → 3 fit.
    expect(lastFrame()).toContain("visible=3");
    for (let i = 0; i < 14; i++) {
      stdin.write(DOWN);
      await tick();
    }
    expect(lastFrame()).toContain("cursor=14");
    expect(lastFrame()).toContain("row<14>");
  });
});

/** Pushes one persistent notification (title + body) and reserves its height. */
function NotifHarness({ count, reserved }: { count: number; reserved: number }) {
  const { items, push } = useNotifications();
  const { cursor, moveUp, moveDown } = useListCursor(count);
  const win = useListWindow(count, cursor, reserved + notificationStackRows(items));
  useInput((_input, key) => {
    if (key.downArrow) moveDown();
    if (key.upArrow) moveUp();
  });
  useEffect(() => {
    push({ id: "banner", title: "update available", body: "v22" });
  }, [push]);
  const rows: number[] = [];
  for (let i = win.start; i < Math.min(count, win.start + win.visible); i++) rows.push(i);
  return (
    <Box flexDirection="column">
      <Text>{`cursor=${cursor} start=${win.start} visible=${win.visible}`}</Text>
      {rows.map((i) => (
        <Text key={i}>{`row<${i}>`}</Text>
      ))}
    </Box>
  );
}
