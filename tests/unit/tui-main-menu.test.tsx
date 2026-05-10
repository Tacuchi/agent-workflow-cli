import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { MainMenu } from "../../src/cli/tui/screens/main-menu.js";

const ARROW_DOWN = "[B";
const ENTER = "\r";

describe("MainMenu (TUI)", () => {
  it("renders header with version", () => {
    const onSelect = vi.fn();
    const { lastFrame } = render(<MainMenu version="9.9.9" onSelect={onSelect} />);
    expect(lastFrame()).toContain("agent-workflow");
    expect(lastFrame()).toContain("v9.9.9");
    expect(lastFrame()).toContain("Menú principal");
  });

  it("lists all menu items + section labels", () => {
    const onSelect = vi.fn();
    const { lastFrame } = render(<MainMenu version="9.9.9" onSelect={onSelect} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Verificar / configurar");
    expect(frame).toContain("Mantenimiento");
    expect(frame).toContain("Doctor");
    expect(frame).toContain("Install / Update skill");
    expect(frame).toContain("Configurar MCP database");
    expect(frame).toContain("Update CLI");
    expect(frame).toContain("Help");
    expect(frame).toContain("Salir");
  });

  it("first item ('doctor') is focused initially", () => {
    const onSelect = vi.fn();
    const { lastFrame } = render(<MainMenu version="9.9.9" onSelect={onSelect} />);
    const frame = lastFrame() ?? "";
    const doctorLine = frame.split("\n").find((line) => line.includes("Doctor"));
    expect(doctorLine).toBeDefined();
    expect(doctorLine).toContain("❯");
  });

  it("Enter selects the focused item (doctor by default)", async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(<MainMenu version="9.9.9" onSelect={onSelect} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSelect).toHaveBeenCalledWith("doctor");
    unmount();
  });

  it("DownArrow + Enter moves to second item ('install-skill')", async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(<MainMenu version="9.9.9" onSelect={onSelect} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ARROW_DOWN);
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSelect).toHaveBeenCalledWith("install-skill");
    unmount();
  });
});
