import { describe, expect, it } from "vitest";
import { parseExecutionBatches } from "../../src/application/parsers/execution-batches.js";

const PLAN = `# Plan\n## Tasks\n${[1, 2, 3, 4].map((n) => `### F${n} — fase\n> Estado: pendiente\n`).join("\n")}`;
const parse = (rows: string) => parseExecutionBatches(`${PLAN}\n## Execution batches\n${rows}\n`);

describe("partición declarada de ejecución", () => {
  it("rechaza fases interiores fuera de orden aunque coincidan los extremos y la longitud", () => {
    const text = `# Plan\n## Tasks\n${[1, 3, 2, 4].map((n) => `### F${n}\n> Estado: pendiente\n`).join("\n")}\n## Execution batches\n- B1 · continuous · F1-F4`;
    expect(parseExecutionBatches(text).status).toBe("invalid");
  });
  it("lee rangos y conserva las filas crudas que protege amend", () => {
    const rows = "- B1 · continuous · F1-F2\n- B2 · continuous · F3-F4";
    expect(parse(rows)).toEqual({
      status: "valid",
      raw: rows,
      reason: null,
      rows: [
        { id: "B1", mode: "continuous", phases: [1, 2] },
        { id: "B2", mode: "continuous", phases: [3, 4] },
      ],
    });
  });

  it("distingue ausencia de sección vacía e ignora títulos dentro de fences", () => {
    expect(
      parseExecutionBatches(
        `${PLAN}\n\`\`\`md\n## Execution batches\n- B1 · continuous · F1-F4\n\`\`\``,
      ).status,
    ).toBe("absent");
    expect(parse("").status).toBe("invalid");
  });

  it("acepta isolated y la cabecera bilingüe sin capturar la sección siguiente", () => {
    const rows = "- B1 · isolated · F1\n- B2 · continuous · F2–F4";
    const result = parseExecutionBatches(
      `${PLAN}\n## Lotes de ejecución\n  ${rows}\n## Validations\nprosa\n`,
    );
    expect(result.status).toBe("valid");
    expect(result.raw).toBe(rows);
    expect(result.rows[0]).toEqual({ id: "B1", mode: "isolated", phases: [1] });
  });

  it.each([
    "- B1 · continuous · F1-F3",
    "- B1 · continuous · F1-F2\n- B2 · continuous · F2-F4",
    "- B1 · continuous · F3-F4\n- B2 · continuous · F1-F2",
    "- B2 · continuous · F1-F4",
    "- B1 · isolated · F1-F4",
    "- B1 · continuous · F1-F9999999999999999",
    "- B1 · continuous · F4-F1",
    "- B1 · unknown · F1-F4",
    "- B1 · continuous · F1-F4\nprosa no declarativa",
    "- B1 · continuous · F1-F4\n## Execution batches\n- B1 · continuous · F1-F4",
    "```md\n- B1 · continuous · F1-F4\n```",
  ])("una sección ilegible no produce una partición parcial: %s", (rows) => {
    expect(parse(rows)).toMatchObject({ status: "invalid", rows: [], reason: expect.any(String) });
  });
});
