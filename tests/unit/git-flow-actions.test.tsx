import type { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { GitFlowResult, GitFlowSourceResult } from "../../src/application/git-flow-service.js";
import { FlowResultView } from "../../src/cli/tui/components/git-flow-actions.js";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type FakeStdout = EventEmitter & { rows?: number; columns?: number };

/** ink-testing-library's stdout is not a TTY: fake the viewport + the resize. */
function setSize(stdout: unknown, size: { rows?: number; cols?: number }) {
  const fake = stdout as FakeStdout;
  if (size.rows !== undefined) fake.rows = size.rows;
  // `columns` is a getter on ink-testing-library's Stdout: assigning throws.
  if (size.cols !== undefined) {
    Object.defineProperty(fake, "columns", { value: size.cols, configurable: true });
  }
  fake.emit("resize");
}

function ok(source: string, ...steps: string[]): GitFlowSourceResult {
  return { source, status: "ok", steps: steps.map((step) => ({ step, status: "ok" })) };
}

function resultOf(...results: GitFlowSourceResult[]): GitFlowResult {
  const status = results.some((r) => r.status === "error")
    ? "error"
    : results.some((r) => r.status === "conflict")
      ? "conflict"
      : "ok";
  return { action: "sync", dry_run: false, status, results };
}

/** Every rendered line mentioning `alias` as a whole word. */
function rowsOf(frame: string, alias: string): string[] {
  const re = new RegExp(`\\b${alias}\\b`);
  return frame.split("\n").filter((l) => re.test(l));
}

function row(frame: string, alias: string): string {
  return rowsOf(frame, alias)[0] ?? "";
}

describe("FlowResultView — resultado compacto", () => {
  it("da UNA fila por fuente y encadena en ella sus pasos en orden (criterios 1 y 2)", () => {
    const result = resultOf(
      ok("alpha", "pull prod", "merge prod→work", "push work"),
      ok("beta", "merge prod→work"),
      ok("gamma", "pull prod", "push work"),
    );
    const { lastFrame } = render(
      <FlowResultView reservedRows={20} action="sync" result={result} isActive />,
    );
    const f = lastFrame() ?? "";

    for (const alias of ["alpha", "beta", "gamma"]) {
      // Exactamente una: el layout viejo abría un bloque con una fila por paso.
      expect(rowsOf(f, alias)).toHaveLength(1);
    }
    // La cadena vive EN la fila de su fuente, no en filas propias…
    const alpha = row(f, "alpha");
    for (const step of ["pull prod", "merge prod→work", "push work"]) {
      expect(alpha).toContain(step);
    }
    // …y en el orden que devolvió el servicio.
    const positions = ["pull prod", "merge prod→work", "push work"].map((s) => alpha.indexOf(s));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    // El alias y el estado abren la fila: son la zona fija.
    expect(alpha).toMatch(/alpha\s+ok/);
  });

  it("conserva las tres fuentes de un batch mixto con su estado y su motivo", () => {
    const result = resultOf(
      ok("core", "merge prod→work"),
      { source: "ui", status: "error", steps: [], error: "Working tree has uncommitted changes" },
      {
        source: "api",
        status: "conflict",
        steps: [{ step: "merge prod→work", status: "conflict" }],
        paused_at: "feat-c",
        conflicted_files: ["src/A.java"],
      },
    );
    const { lastFrame } = render(
      <FlowResultView reservedRows={20} action="sync" result={result} isActive />,
    );
    const f = lastFrame() ?? "";
    expect(row(f, "core")).toMatch(/core\s+ok/);
    // Sin pasos, la cadena de una fuente ES su motivo: la fila no queda muda.
    expect(row(f, "ui")).toMatch(/ui\s+error/);
    expect(row(f, "ui")).toContain("uncommitted");
    expect(row(f, "api")).toMatch(/api\s+conflict/);
    expect(row(f, "api")).toContain("merge prod→work");
  });

  it("rotula cada acción, to-dev incluida", () => {
    const result = resultOf(ok("alpha", "push develop"));
    const { lastFrame } = render(
      <FlowResultView reservedRows={20} action="to-dev" result={result} isActive />,
    );
    expect(lastFrame() ?? "").toContain("ENVIAR A DESARROLLO"); // SectionHead uppercases
  });

  it("↑/↓ alcanza la última fuente en un TTY corto e informa el rango (criterio 3)", async () => {
    const sources = Array.from({ length: 12 }, (_, i) => ok(`s${i}`, "merge prod→work"));
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView reservedRows={20} action="sync" result={resultOf(...sources)} isActive />,
    );
    setSize(stdout, { rows: 24, cols: 100 });
    await tick();
    // 24 filas − 20 reservadas = 4 visibles: s11 arranca fuera de la ventana.
    expect(rowsOf(lastFrame() ?? "", "s11")).toHaveLength(0);

    for (let i = 0; i < 11; i++) {
      stdin.write(DOWN);
      await tick(20);
    }
    const f = lastFrame() ?? "";
    expect(rowsOf(f, "s11")).toHaveLength(1); // la seleccionada SIEMPRE se pinta
    expect(rowsOf(f, "s0")).toHaveLength(0); // y la ventana avanzó de verdad
    expect(f).toContain("fuentes 9–12 de 12");
    expect(f.split("\n").length).toBeLessThanOrEqual(24); // acotado al viewport

    stdin.write(UP);
    await tick();
    expect(rowsOf(lastFrame() ?? "", "s10")).toHaveLength(1);
  });

  it("una cadena que no cabe se corta con … y ←/→ no la mueven: no son teclas de la TUI", async () => {
    const long = ok(
      "alpha",
      "pull prod",
      "merge prod→work",
      "push work",
      "merge work→qa",
      "push qa",
    );
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView action="sync" result={resultOf(long)} reservedRows={20} isActive />,
    );
    setSize(stdout, { rows: 40, cols: 60 });
    await tick();
    const start = row(lastFrame() ?? "", "alpha");
    expect(start).toContain("pull prod");
    expect(start).toContain("…");
    expect(start).toMatch(/alpha\s+ok/);
    stdin.write(RIGHT);
    await tick();
    stdin.write(LEFT);
    await tick();
    expect(row(lastFrame() ?? "", "alpha")).toBe(start);
  });

  it("en un terminal angosto con alias largo la fila sigue siendo UNA y conserva el estado", async () => {
    // El riesgo real: si la zona fija se dimensiona sólo por el alias, en 40
    // columnas construye una fila más ancha que su contenedor, Yoga la envuelve
    // y una fuente vuelve a ocupar dos filas — justo lo que esta vista elimina.
    const result = resultOf(
      {
        source: "servicio-de-facturacion-electronica-legacy",
        status: "conflict",
        steps: [{ step: "merge prod→work", status: "conflict" }],
        paused_at: "certificacion",
        conflicted_files: ["src/A.java"],
      },
      ok("api", "pull prod", "merge prod→work"),
    );
    const { lastFrame, stdout } = render(
      <FlowResultView reservedRows={20} action="sync" result={result} isActive />,
    );
    setSize(stdout, { rows: 40, cols: 40 });
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    const summary = lines.findIndex((l) => l.includes("en pausa por un conflicto"));
    const rows = lines.slice(summary + 1).filter((l) => l.trim().length > 0);
    expect(rows).toHaveLength(2); // una fila por fuente: nada envolvió
    expect(rows[0]).toContain("conflict"); // el estado sobrevive al recorte…
    expect(rows[1]).toContain("ok");
    expect(rows[0]).toMatch(/\S/); // …y el alias no queda vacío
  });

  it("⏎ sobre un conflicto abre el detalle íntegro y esc vuelve al mismo punto (criterio 5)", async () => {
    const conflict: GitFlowSourceResult = {
      source: "alpha",
      status: "conflict",
      steps: [
        { step: "pull prod", status: "ok" },
        { step: "merge prod→work", status: "conflict", detail: "paused on prod" },
      ],
      paused_at: "certificacion",
      conflicted_files: ["src/Foo.java", "src/Bar.java", "src/Baz.java"],
    };
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView reservedRows={20} action="sync" result={resultOf(conflict)} isActive />,
    );
    setSize(stdout, { rows: 40, cols: 60 });
    await tick();
    const before = row(lastFrame() ?? "", "alpha");

    stdin.write(ENTER);
    await tick();
    const detail = lastFrame() ?? "";
    expect(detail).toContain("merge prod→work"); // el paso afectado
    expect(detail).toContain("pausado en: certificacion"); // la rama de pausa
    expect(detail).toContain("archivos en conflicto (3)");
    for (const file of ["src/Foo.java", "src/Bar.java", "src/Baz.java"]) {
      expect(detail).toContain(file); // TODOS, no una muestra
    }

    stdin.write(ESC);
    await tick();
    expect(row(lastFrame() ?? "", "alpha")).toBe(before);
  });

  it("el detalle de un error trae el mensaje completo aunque exceda el ancho", async () => {
    const message = `fatal: ${"x".repeat(120)} END`;
    const failed: GitFlowSourceResult = {
      source: "alpha",
      status: "error",
      steps: [],
      error: message,
    };
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView reservedRows={20} action="sync" result={resultOf(failed)} isActive />,
    );
    setSize(stdout, { rows: 40, cols: 60 });
    await tick();
    stdin.write(ENTER);
    await tick();
    // Envuelto en filas, nunca recortado: el detalle existe para mostrarlo entero.
    const joined = (lastFrame() ?? "").split("\n").join("");
    expect(joined).toContain("END");
    expect(joined).not.toContain("…");
  });

  it("↑/↓ recorre un detalle más alto que el frame sin cambiar de fuente", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/File${i}.java`);
    const conflict: GitFlowSourceResult = {
      source: "alpha",
      status: "conflict",
      steps: [{ step: "merge prod→work", status: "conflict" }],
      paused_at: "certificacion",
      conflicted_files: files,
    };
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView reservedRows={20} action="sync" result={resultOf(conflict)} isActive />,
    );
    setSize(stdout, { rows: 26, cols: 100 });
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? "").not.toContain("src/File29.java");
    for (let i = 0; i < 40; i++) {
      stdin.write(DOWN);
      await tick(12);
    }
    expect(lastFrame() ?? "").toContain("src/File29.java");
    stdin.write(ESC);
    await tick();
    expect(rowsOf(lastFrame() ?? "", "alpha")).toHaveLength(1); // la misma fuente
  });

  it("⏎ sobre una fuente exitosa no abre detalle", async () => {
    const { stdin, lastFrame } = render(
      <FlowResultView
        reservedRows={20}
        action="sync"
        result={resultOf(ok("alpha", "merge prod→work"))}
        isActive
      />,
    );
    await tick();
    const before = lastFrame() ?? "";
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? "").toBe(before);
  });

  it("delega esc; ⏎ y r no reejecutan nada", async () => {
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(
      <FlowResultView
        action="sync"
        result={resultOf(ok("alpha", "merge prod→work"))}
        reservedRows={20}
        isActive
        onBack={onBack}
      />,
    );
    await tick();
    const before = lastFrame() ?? "";
    stdin.write(ENTER);
    await tick();
    stdin.write("r");
    await tick();
    expect(lastFrame() ?? "").toBe(before);
    expect(before).toContain("↑↓ mover · esc volver · q salir");
    expect(onBack).not.toHaveBeenCalled();
    stdin.write(ESC);
    await tick();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("conserva el error global cuando no hay resultados por fuente", () => {
    const result: GitFlowResult = {
      action: "sync",
      dry_run: false,
      status: "error",
      results: [],
      error: "WORKSPACE block not found",
    };
    const { lastFrame } = render(
      <FlowResultView reservedRows={20} action="sync" result={result} isActive />,
    );
    expect(lastFrame() ?? "").toContain("WORKSPACE block not found");
  });
});

describe("FlowResultView — confirm-prod y el detalle del merge a medias (SCR-002@r7)", () => {
  const preview: GitFlowResult = {
    action: "to-prod",
    dry_run: false,
    status: "error",
    error: "publicar en PROD exige la confirmación de la persona",
    consent_required: { sources: ["alpha"], plan: "d" },
    results: [
      {
        source: "alpha",
        status: "ok",
        steps: [
          { step: "merge work→prod", status: "skipped", preview: "merge feature/x→certificacion" },
          { step: "push certificacion", status: "skipped", preview: "push certificacion" },
        ],
      },
      { source: "beta", status: "error", steps: [], error: "PR-04: el plan mezclaría develop" },
    ],
  };

  it("pinta la vista previa con las ramas reales, sin glifos de estado, y la fila fallida con su error", () => {
    const { lastFrame } = render(
      <FlowResultView
        reservedRows={20}
        action="to-prod"
        result={preview}
        isActive
        confirm={{ onPublish: () => {}, onCancel: () => {} }}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("ENVIAR A PROD");
    expect(row(f, "alpha")).toContain("merge feature/x→certificacion → push certificacion");
    expect(row(f, "beta")).toContain("PR-04");
    expect(f).toContain("y publicar · n/esc cancelar");
  });

  it("y publica; n y esc cancelan; r no hace nada", async () => {
    const onPublish = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <FlowResultView
        reservedRows={20}
        action="to-prod"
        result={preview}
        isActive
        confirm={{ onPublish, onCancel }}
      />,
    );
    await tick();
    stdin.write("r");
    await tick();
    stdin.write("x");
    await tick();
    expect(onPublish).not.toHaveBeenCalled();
    stdin.write("n");
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(2);
    stdin.write("y");
    await tick();
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  function paused(merge_origin: string | null): GitFlowResult {
    return resultOf({
      source: "alpha",
      status: "error",
      steps: [],
      paused_at: "feature/x",
      merge_origin,
      error: "hay un merge a medias",
    });
  }

  it("el detalle nombra la rama donde quedó el merge y la que lo trajo", async () => {
    const { stdin, lastFrame } = render(
      <FlowResultView
        reservedRows={20}
        action="sync"
        result={paused("origin/feature/x")}
        isActive
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("pausado en: feature/x");
    expect(f).toContain("traído por: origin/feature/x");
  });

  it("cuando git no sabe nombrar la rama que lo trajo, el detalle lo dice", async () => {
    const { stdin, lastFrame } = render(
      <FlowResultView reservedRows={20} action="sync" result={paused(null)} isActive />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? "").toContain("traído por: git no sabe nombrar la rama que lo trajo");
  });
});
