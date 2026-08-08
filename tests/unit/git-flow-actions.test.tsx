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
    const { lastFrame } = render(<FlowResultView action="sync" result={result} isActive />);
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
    const { lastFrame } = render(<FlowResultView action="sync" result={result} isActive />);
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
    const { lastFrame } = render(<FlowResultView action="to-dev" result={result} isActive />);
    expect(lastFrame() ?? "").toContain("GIT FLOW · → DEV"); // SectionHead uppercases
  });

  it("↑/↓ alcanza la última fuente en un TTY corto e informa el rango (criterio 3)", async () => {
    const sources = Array.from({ length: 12 }, (_, i) => ok(`s${i}`, "merge prod→work"));
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView action="sync" result={resultOf(...sources)} isActive />,
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

  it("←/→ recorre la cadena de inicio a fin sin mover alias ni estado (criterio 4)", async () => {
    const long = ok(
      "alpha",
      "pull prod",
      "merge prod→work",
      "push work",
      "merge work→qa",
      "push qa",
      "checkout work",
    );
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView action="sync" result={resultOf(long)} isActive />,
    );
    setSize(stdout, { rows: 40, cols: 60 }); // estrecha: la cadena no cabe
    await tick();

    const start = row(lastFrame() ?? "", "alpha");
    expect(start).toContain("pull prod"); // el inicio
    expect(start).not.toContain("checkout work"); // el final, todavía no
    expect(start).toContain("›"); // y lo dice
    expect(start).not.toContain("‹");

    // El clamp garantiza que ir hasta el tope deje el último segmento completo.
    for (let i = 0; i < 20; i++) {
      stdin.write(RIGHT);
      await tick(15);
    }
    const end = row(lastFrame() ?? "", "alpha");
    expect(end).toContain("checkout work");
    expect(end).toContain("‹");
    expect(end).not.toContain("›");
    // La zona fija no se movió: es el punto del criterio.
    expect(end).toMatch(/alpha\s+ok/);
    expect(start.indexOf("alpha")).toBe(end.indexOf("alpha"));

    for (let i = 0; i < 20; i++) {
      stdin.write(LEFT);
      await tick(15);
    }
    expect(row(lastFrame() ?? "", "alpha")).toBe(start); // vuelve exacto al inicio

    // Ensanchar re-ancla la ventana en vez de dejarla más allá del final.
    for (let i = 0; i < 20; i++) {
      stdin.write(RIGHT);
      await tick(15);
    }
    setSize(stdout, { rows: 40, cols: 200 });
    await tick();
    const wide = row(lastFrame() ?? "", "alpha");
    expect(wide).toContain("pull prod");
    expect(wide).toContain("checkout work");
    expect(wide).not.toContain("‹");
    expect(wide).not.toContain("›");
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
    const { lastFrame, stdout } = render(<FlowResultView action="sync" result={result} isActive />);
    setSize(stdout, { rows: 40, cols: 40 });
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    const summary = lines.findIndex((l) => l.includes("paused on conflict"));
    const rows = lines.slice(summary + 1).filter((l) => l.trim().length > 0);
    expect(rows).toHaveLength(2); // una fila por fuente: nada envolvió
    expect(rows[0]).toContain("conflict"); // el estado sobrevive al recorte…
    expect(rows[1]).toContain("ok");
    expect(rows[0]).toMatch(/\S/); // …y el alias no queda vacío
  });

  it("cambiar de fuente devuelve la cadena nueva a su inicio", async () => {
    const result = resultOf(
      ok("alpha", "pull prod", "merge prod→work", "push work", "merge work→qa", "push qa"),
      ok("beta", "pull prod", "merge prod→work", "push work", "merge work→qa", "push qa"),
    );
    const { stdin, lastFrame, stdout } = render(
      <FlowResultView action="sync" result={result} isActive />,
    );
    setSize(stdout, { rows: 40, cols: 60 });
    await tick();
    for (let i = 0; i < 3; i++) {
      stdin.write(RIGHT);
      await tick(15);
    }
    expect(row(lastFrame() ?? "", "alpha")).toContain("‹");
    stdin.write(DOWN);
    await tick();
    const beta = row(lastFrame() ?? "", "beta");
    expect(beta).toContain("pull prod");
    expect(beta).not.toContain("‹");
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
      <FlowResultView action="sync" result={resultOf(conflict)} isActive />,
    );
    setSize(stdout, { rows: 40, cols: 60 });
    await tick();
    stdin.write(RIGHT); // deja un offset horizontal que el regreso debe preservar
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
      <FlowResultView action="sync" result={resultOf(failed)} isActive />,
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
      <FlowResultView action="sync" result={resultOf(conflict)} isActive />,
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
      <FlowResultView action="sync" result={resultOf(ok("alpha", "merge prod→work"))} isActive />,
    );
    await tick();
    const before = lastFrame() ?? "";
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? "").toBe(before);
  });

  it("delega r y esc, y ⏎ no reejecuta (criterio 6)", async () => {
    const onRerun = vi.fn();
    const onBack = vi.fn();
    const { stdin } = render(
      <FlowResultView
        action="sync"
        result={resultOf(ok("alpha", "merge prod→work"))}
        isActive
        onRerun={onRerun}
        onBack={onBack}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onRerun).not.toHaveBeenCalled();
    stdin.write("r");
    await tick();
    expect(onRerun).toHaveBeenCalledTimes(1);
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
    const { lastFrame } = render(<FlowResultView action="sync" result={result} isActive />);
    expect(lastFrame() ?? "").toContain("WORKSPACE block not found");
  });
});
