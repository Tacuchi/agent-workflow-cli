import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { FocusRow } from "../../src/cli/tui/components/focus-row.js";

describe("FocusRow", () => {
  it("shows the focus bar, label and value when focused", () => {
    const { lastFrame } = render(
      <FocusRow focused cols={80} label="Accent" valueWidth={3}>
        <Text>val</Text>
      </FocusRow>,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("▎"); // focus bar at the start
    expect(f).toContain("Accent");
    expect(f).toContain("val");
  });

  it("hides the bar when not focused", () => {
    const { lastFrame } = render(
      <FocusRow focused={false} cols={80} label="Accent" valueWidth={3}>
        <Text>val</Text>
      </FocusRow>,
    );
    expect(lastFrame() ?? "").not.toContain("▎");
  });
});
