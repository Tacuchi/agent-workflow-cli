import { describe, expect, it } from "vitest";
import { buildRow, ensureHistoryFile, upsertRow } from "../../src/application/history-table.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

// Slim HISTORY table (artifact-slim round): 4 columns keyed by the Sesión cell
// (`NNN-<slug>-<flow>`); legacy 7-col (`# | Flujo | Sesión | … | Resumen | …`)
// and 6-col (without Flujo) tables migrate in place on the first upsert.
const HISTORY = "/cwd/.workflow/HISTORY.md";

const SLIM_HEADER = "| Sesión | Fecha | Estado | Refs |\n|--------|-------|--------|------|";

function row(code: string, name: string, state = "active"): string {
  return buildRow({ code, sesionName: name, date: "2026-07-01", state, refs: "—" });
}

describe("history-table — slim 4-column shape", () => {
  it("ensureHistoryFile writes the slim header", async () => {
    const fs = new FakeFs({ lenient: true });
    await ensureHistoryFile(fs, HISTORY);
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).not.toContain("Flujo");
    expect(text).not.toContain("Resumen");
  });

  it("buildRow keys the first cell by code (prefixing the name when needed)", () => {
    expect(row("104", "104-foo-plan-exec")).toBe("| 104-foo-plan-exec | 2026-07-01 | active | — |");
    expect(row("001", "dev-foo")).toBe("| 001-dev-foo | 2026-07-01 | active | — |");
    expect(row("002", "002")).toBe("| 002 | 2026-07-01 | active | — |");
  });

  it("upsert adds then updates by the code-prefixed key, never duplicating", async () => {
    const fs = new FakeFs({ lenient: true });
    await upsertRow(fs, HISTORY, "104", () => row("104", "104-foo-plan-exec"));
    const updated = await upsertRow(fs, HISTORY, "104", () =>
      row("104", "104-foo-plan-exec", "closed"),
    );
    expect(updated).toBe("updated");
    const text = await fs.readText(HISTORY);
    expect(text.match(/104-foo-plan-exec/g)).toHaveLength(1);
    expect(text).toContain("| 104-foo-plan-exec | 2026-07-01 | closed | — |");
  });
});

describe("history-table — legacy table migration on upsert", () => {
  const LEGACY_7COL =
    "# Session History\n\n" +
    "| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n" +
    "|---|-------|--------|-------|--------|---------|------|\n" +
    "| 001 | dev | foo | 2026-01-01 | active | Tarea foo | — |\n" +
    "| 002 | analyze | 002-bar-quick | 2026-01-02 | closed | Pregunta bar | docs/x.md |\n";

  const LEGACY_6COL =
    "# Session History\n\n" +
    "| # | Sesión | Fecha | Estado | Resumen | Refs |\n" +
    "|---|--------|-------|--------|---------|------|\n" +
    "| 001 | foo | 2026-01-01 | active | Tarea foo | — |\n";

  it("migrates a 7-col table (drops #/Flujo/Resumen, re-keys Sesión with its code)", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_7COL);
    const action = await upsertRow(fs, HISTORY, "001", () => row("001", "001-dev-foo", "closed"));
    expect(action).toBe("updated");
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).not.toContain("Flujo");
    expect(text).not.toContain("Tarea foo");
    // The upserted row replaced the migrated 001 row; the untouched row kept
    // its data (already code-prefixed names are not double-prefixed).
    expect(text).toContain("| 001-dev-foo | 2026-07-01 | closed | — |");
    expect(text).toContain("| 002-bar-quick | 2026-01-02 | closed | docs/x.md |");
    expect(text.match(/^\| 00/gm)).toHaveLength(2);
  });

  it("migrates a 6-col table (without Flujo) the same way", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_6COL);
    const action = await upsertRow(fs, HISTORY, "003", () => row("003", "003-baz-quick"));
    expect(action).toBe("added");
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).toContain("| 001-foo | 2026-01-01 | active | — |");
    expect(text).toContain("| 003-baz-quick | 2026-07-01 | active | — |");
  });

  it("a later upsert on a migrated row matches by code prefix (no duplicate rows)", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_7COL);
    await upsertRow(fs, HISTORY, "001", () => row("001", "001-dev-foo"));
    const action = await upsertRow(fs, HISTORY, "001", () => row("001", "001-dev-foo", "closed"));
    expect(action).toBe("updated");
    const text = await fs.readText(HISTORY);
    expect(text.match(/^\| 001-/gm)).toHaveLength(1);
  });

  it("persists the migration even when the upserted row is unchanged", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_7COL);
    const same = () => row("002", "002-bar-quick", "closed");
    // The legacy 002 row migrates to exactly this shape → "unchanged"…
    const action = await upsertRow(fs, HISTORY, "002", () =>
      buildRow({
        code: "002",
        sesionName: "002-bar-quick",
        date: "2026-01-02",
        state: "closed",
        refs: "docs/x.md",
      }),
    );
    expect(action).toBe("unchanged");
    // …but the migrated table must still hit disk.
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).not.toContain("Flujo");
    void same;
  });
});

// HISTORY.md is the workspace's durable, git-tracked, hand-editable record: a
// table the migration cannot safely map must be left alone, never rewritten.
describe("history-table — migration never destroys unmappable content", () => {
  it("tolerates a hand-edited separator (no trailing pipe) — migrates, loses no row", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(
      HISTORY,
      "# Session History\n\n" +
        "| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n" +
        "|---|-------|--------|-------|--------|---------|------\n" + // no trailing pipe
        "| 001 | — | 001-alpha-plan-exec | 2026-07-01 | closed | alpha | — |\n",
    );
    const action = await upsertRow(fs, HISTORY, "058", () => row("058", "058-nueva-plan-exec"));
    expect(action).toBe("added");
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).toContain("| 001-alpha-plan-exec | 2026-07-01 | closed | — |");
    expect(text).toContain("| 058-nueva-plan-exec | 2026-07-01 | active | — |");
  });

  it("refuses to rewrite a legacy table with no separator row at all (append-only)", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(
      HISTORY,
      "# Session History\n\n" +
        "| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n" +
        "| 001 | — | 001-alpha-plan-exec | 2026-07-01 | closed | alpha | — |\n",
    );
    const action = await upsertRow(fs, HISTORY, "058", () => row("058", "058-nueva-plan-exec"));
    expect(action).toBe("added");
    const text = await fs.readText(HISTORY);
    // Unmappable → left verbatim. Losing the row would be worse than a mixed table.
    expect(text).toContain("| 001 | — | 001-alpha-plan-exec | 2026-07-01 | closed | alpha | — |");
    expect(text).toContain("| 058-nueva-plan-exec | 2026-07-01 | active | — |");
  });

  it("migrates only the history table, leaving a second table below it intact", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(
      HISTORY,
      "# Session History\n\n" +
        "| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n" +
        "|---|-------|--------|-------|--------|---------|------|\n" +
        "| 001 | — | 001-alpha-plan-exec | 2026-07-01 | closed | alpha | — |\n" +
        "\n## Notas\n\n" +
        "| Tema | Dueño |\n|------|-------|\n| deploy | ana |\n",
    );
    await upsertRow(fs, HISTORY, "058", () => row("058", "058-nueva-plan-exec"));
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).toContain("| 001-alpha-plan-exec | 2026-07-01 | closed | — |");
    // The unrelated table keeps its own columns.
    expect(text).toContain("| Tema | Dueño |");
    expect(text).toContain("| deploy | ana |");
  });
});
