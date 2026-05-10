import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TabBar, type TabDescriptor } from "../../src/cli/tui/components/tab-bar.js";

const TABS: TabDescriptor<"a" | "b" | "c">[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

describe("TabBar", () => {
  it("active tab tiene brackets [ ]", () => {
    const { lastFrame } = render(<TabBar tabs={TABS} activeId="b" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[ Beta ]");
    expect(frame).not.toContain("[ Alpha ]");
    expect(frame).not.toContain("[ Gamma ]");
  });

  it("renderiza todos los labels", () => {
    const { lastFrame } = render(<TabBar tabs={TABS} activeId="a" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("Gamma");
  });

  it("muestra badge cuando se provee", () => {
    const tabs: TabDescriptor<"x">[] = [{ id: "x", label: "MCP", badge: "3" }];
    const { lastFrame } = render(<TabBar tabs={tabs} activeId="x" />);
    expect(lastFrame()).toContain("MCP (3)");
  });

  it("renderea en una sola línea (sin barra debajo)", () => {
    const { lastFrame } = render(<TabBar tabs={TABS} activeId="b" />);
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(1);
  });
});
