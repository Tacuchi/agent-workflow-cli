import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type MenuItem, SectionedMenu } from "../../src/cli/tui/components/sectioned-menu.js";

const ARROW_DOWN = "[B";
const ARROW_UP = "[A";
const ENTER = "\r";

describe("SectionedMenu (TUI)", () => {
  it("renderiza secciones con label en formato ── X ──", () => {
    const items: MenuItem<string>[] = [
      { kind: "section", label: "Grupo A" },
      { kind: "item", label: "uno", value: "1" },
    ];
    const { lastFrame } = render(<SectionedMenu items={items} onSelect={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("── Grupo A ──");
    expect(frame).toContain("uno");
  });

  it("salta separadores al navegar (sólo selecciona items)", async () => {
    const onSelect = vi.fn();
    const items: MenuItem<string>[] = [
      { kind: "section", label: "Sec1" },
      { kind: "item", label: "alpha", value: "a" },
      { kind: "section", label: "Sec2" },
      { kind: "item", label: "beta", value: "b" },
      { kind: "item", label: "gamma", value: "g" },
    ];
    const { stdin, unmount } = render(<SectionedMenu items={items} onSelect={onSelect} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ARROW_DOWN);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSelect).toHaveBeenCalledWith("b");
    unmount();
  });

  it("wrap-around: arriba desde el primer item lleva al último", async () => {
    const onSelect = vi.fn();
    const items: MenuItem<string>[] = [
      { kind: "item", label: "first", value: "1" },
      { kind: "item", label: "second", value: "2" },
      { kind: "item", label: "third", value: "3" },
    ];
    const { stdin, unmount } = render(<SectionedMenu items={items} onSelect={onSelect} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ARROW_UP);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSelect).toHaveBeenCalledWith("3");
    unmount();
  });

  it("defaultValue posiciona el foco inicial", async () => {
    const onSelect = vi.fn();
    const items: MenuItem<string>[] = [
      { kind: "item", label: "alpha", value: "a" },
      { kind: "item", label: "beta", value: "b" },
      { kind: "item", label: "gamma", value: "g" },
    ];
    const { stdin, unmount } = render(
      <SectionedMenu items={items} onSelect={onSelect} defaultValue="g" />,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSelect).toHaveBeenCalledWith("g");
    unmount();
  });
});
