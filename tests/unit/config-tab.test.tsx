import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ConfigTab } from "../../src/cli/tui/tabs/config-tab.js";
import { DEFAULT_TUI_PREFS } from "../../src/cli/tui/tui-prefs.js";
import type { CliContext } from "../../src/cli/types.js";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const tick = () => new Promise((r) => setTimeout(r, 50));
const noop = () => {};

function buildCtx(): CliContext {
  return {
    namespace: { namespace: "workflow", source: "default" },
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default",
    },
    paths: {
      userRuntimeJson: () => "/home/test/.config/agent-workflow/profile.json",
      userLibConfigDir: () => "/tmp",
    },
  } as unknown as CliContext;
}

describe("ConfigTab", () => {
  it("renders the sections, workspace info and host list (no density)", () => {
    const { lastFrame } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    for (const label of [
      "APPEARANCE",
      "Accent color",
      "ON OPEN",
      "Initial screen",
      "WORKSPACE",
      "Namespace",
      "Profile",
      "Claude Code",
    ]) {
      expect(frame).toContain(label);
    }
    expect(frame).not.toContain("Density");
    expect(frame).toContain("workflow"); // namespace value
    expect(frame).toContain("profile.json");
  });

  it("→ on the focused accent cycles to the next color (violet → cyan)", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={onChange}
        onSaveNamespace={noop}
      />,
    );
    await tick();
    stdin.write(RIGHT);
    await tick();
    expect(onChange).toHaveBeenCalledWith({ accentColor: "cyan" });
  });

  it("toggles a backed host into disabledHosts", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={onChange}
        onSaveNamespace={noop}
      />,
    );
    await tick();
    // accent(0) → initialScreen(1) → namespace(2) → claude(3)
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(" ");
    await tick();
    expect(onChange).toHaveBeenCalledWith({ disabledHosts: ["claude"] });
  });

  it("enter on namespace opens edit mode and submit persists it", async () => {
    const onSaveNamespace = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={noop}
        onSaveNamespace={onSaveNamespace}
      />,
    );
    await tick();
    stdin.write(DOWN); // → initialScreen
    await tick();
    stdin.write(DOWN); // → namespace
    await tick();
    stdin.write(ENTER); // open edit
    await tick();
    stdin.write(ENTER); // submit default value
    await tick();
    expect(onSaveNamespace).toHaveBeenCalledWith("workflow");
  });

  it("r resets all prefs to defaults", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <ConfigTab
        ctx={buildCtx()}
        isActive
        prefs={DEFAULT_TUI_PREFS}
        onChange={onChange}
        onSaveNamespace={noop}
      />,
    );
    await tick();
    stdin.write("r");
    await tick();
    expect(onChange).toHaveBeenCalledWith(DEFAULT_TUI_PREFS);
  });
});
