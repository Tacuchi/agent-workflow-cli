import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TabBar, type TabDescriptor } from "../../src/cli/tui/components/tab-bar.js";

const TABS: TabDescriptor<"a" | "b" | "c">[] = [
  { id: "a", label: "Alpha", key: "1" },
  { id: "b", label: "Beta", key: "2" },
  { id: "c", label: "Gamma", key: "3" },
];

describe("TabBar", () => {
  it("renderiza key + label de cada tab", () => {
    const { lastFrame } = render(<TabBar tabs={TABS} activeId="b" />);
    const frame = lastFrame() ?? "";
    // Inactive tabs: `<key> <label>` (1 space). Active tab tiene un wrap
    // de espacios alrededor del label (inverse highlight).
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("Gamma");
    expect(frame).toMatch(/1 Alpha/);
    expect(frame).toMatch(/2 +Beta/);
    expect(frame).toMatch(/3 Gamma/);
  });

  it("active label se renderiza visible (con inverse highlight)", () => {
    const { lastFrame } = render(<TabBar tabs={TABS} activeId="b" />);
    const frame = lastFrame() ?? "";
    // No debe tener corchetes ni chevron del estilo anterior
    expect(frame).not.toContain("[ Beta ]");
    expect(frame).not.toContain("›2");
    expect(frame).toContain("Beta");
    // Active tab tiene espacios envolviendo el label (para que el inverse
    // background tenga padding visual).
    expect(frame).toMatch(/ Beta /);
  });

  it("renderiza todos los labels", () => {
    const { lastFrame } = render(<TabBar tabs={TABS} activeId="a" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("Gamma");
  });

  it("muestra badge cuando se provee", () => {
    const tabs: TabDescriptor<"x">[] = [{ id: "x", label: "MCP", key: "1", badge: "3" }];
    const { lastFrame } = render(<TabBar tabs={tabs} activeId="x" />);
    expect(lastFrame()).toContain("MCP");
    expect(lastFrame()).toContain("3");
  });

  it("muestra alert dot cuando alert=true", () => {
    const tabs: TabDescriptor<"x">[] = [{ id: "x", label: "Update", key: "6", alert: true }];
    const { lastFrame } = render(<TabBar tabs={tabs} activeId="x" />);
    expect(lastFrame()).toContain("•");
  });
});
