import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import {
  NotificationCenterProvider,
  useNotifications,
} from "../../src/cli/tui/notification-center.js";

const settle = () => new Promise((r) => setTimeout(r, 30));

function Emitter({
  tone,
  title,
  body,
}: { tone: "ok" | "info" | "err"; title: string; body?: string }) {
  const { pushToast } = useNotifications();
  useEffect(() => {
    pushToast({ tone, title, ...(body ? { body } : {}) });
  }, [pushToast, tone, title, body]);
  return <Text>ready</Text>;
}

describe("NotificationCenter — err safety net", () => {
  it("mirrors every err toast to the logger (title + body)", async () => {
    const logged: string[] = [];
    const logger = { error: (m: string) => void logged.push(m) };
    render(
      <NotificationCenterProvider logger={logger}>
        <Emitter tone="err" title="Test failed" body="boom" />
      </NotificationCenterProvider>,
    );
    await settle();
    expect(logged).toContain("tui: Test failed — boom");
  });

  it("does NOT log ok/info toasts", async () => {
    const logged: string[] = [];
    const logger = { error: (m: string) => void logged.push(m) };
    render(
      <NotificationCenterProvider logger={logger}>
        <Emitter tone="ok" title="Installed" />
      </NotificationCenterProvider>,
    );
    await settle();
    expect(logged).toEqual([]);
  });

  it("is a no-op without a logger (never throws)", async () => {
    const { lastFrame } = render(
      <NotificationCenterProvider>
        <Emitter tone="err" title="No logger here" />
      </NotificationCenterProvider>,
    );
    await settle();
    expect(lastFrame()).toContain("ready");
  });
});
