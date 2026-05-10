import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ConfirmModal } from "../../src/cli/tui/components/confirm-modal.js";

describe("ConfirmModal", () => {
  it("renderea título con icono y body multi-line", () => {
    const { lastFrame } = render(
      <ConfirmModal
        tone="danger"
        title="Eliminar conexión"
        body={["Línea 1", "Línea 2"]}
        confirmKey="y"
        confirmLabel="Sí"
        cancelKey="n"
        cancelLabel="No"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚠");
    expect(frame).toContain("Eliminar conexión");
    expect(frame).toContain("Línea 1");
    expect(frame).toContain("Línea 2");
    expect(frame).toContain("y");
    expect(frame).toContain("Sí");
    expect(frame).toContain("n");
    expect(frame).toContain("No");
  });

  it("body string también funciona como una línea", () => {
    const { lastFrame } = render(
      <ConfirmModal
        tone="warning"
        title="Hola"
        body="Solo una"
        confirmKey="⏎"
        confirmLabel="ok"
        cancelKey="Esc"
        cancelLabel="cancel"
      />,
    );
    expect(lastFrame()).toContain("Solo una");
  });

  it("borde redondeado en frame", () => {
    const { lastFrame } = render(
      <ConfirmModal
        tone="danger"
        title="X"
        body="Y"
        confirmKey="y"
        confirmLabel="ok"
        cancelKey="n"
        cancelLabel="no"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/[╭╰]/);
  });
});
