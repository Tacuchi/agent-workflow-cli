import { describe, expect, it } from "vitest";
import {
  type HistoryRowInput,
  buildRow,
  ensureHistoryFile,
  upsertRow,
} from "../../src/application/history-table.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

// Slim HISTORY table (artifact-slim round): 4 columns keyed by the Sesión cell
// (`NNN-<slug>-<flow>`); legacy 7-col (`# | Flujo | Sesión | … | Resumen | …`)
// and 6-col (without Flujo) tables migrate in place on the first upsert.
const HISTORY = "/cwd/.workflow/HISTORY.md";
const SNAPSHOT = "/cwd/.workflow/HISTORY.legacy.md";

const SLIM_HEADER = "| Sesión | Fecha | Estado | Refs |\n|--------|-------|--------|------|";

function fields(code: string, name: string, state = "active"): HistoryRowInput {
  return { code, sesionName: name, date: "2026-07-01", state, refs: "—" };
}

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
    await upsertRow(fs, HISTORY, fields("104", "104-foo-plan-exec"));
    const updated = await upsertRow(fs, HISTORY, fields("104", "104-foo-plan-exec", "closed"));
    expect(updated).toBe("updated");
    const text = await fs.readText(HISTORY);
    expect(text.match(/104-foo-plan-exec/g)).toHaveLength(1);
    expect(text).toContain("| 104-foo-plan-exec | 2026-07-01 | closed | — |");
  });
});

// S027/AC-07 — a cell the caller did not name is a cell nobody asked to change.
describe("history-table — an upsert conserves what it was not told", () => {
  const WITH_REFS = `# Session History\n\n${SLIM_HEADER}\n| 047-algo-quick | 2026-03-04 | active | [DEC](../docs/decisiones/007-x.md) |\n`;

  async function seeded(): Promise<FakeFs> {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, WITH_REFS);
    return fs;
  }

  it("updating only the state keeps the date and the references", async () => {
    const fs = await seeded();
    const action = await upsertRow(fs, HISTORY, { code: "047", state: "closed" });
    expect(action).toBe("updated");
    expect(await fs.readText(HISTORY)).toContain(
      "| 047-algo-quick | 2026-03-04 | closed | [DEC](../docs/decisiones/007-x.md) |",
    );
  });

  it("a second update does not erase what the first one preserved", async () => {
    const fs = await seeded();
    await upsertRow(fs, HISTORY, { code: "047", sesionName: "algo-quick", state: "closed" });
    await upsertRow(fs, HISTORY, { code: "047", sesionName: "algo-quick", state: "closed" });
    const text = await fs.readText(HISTORY);
    expect(text).toContain("[DEC](../docs/decisiones/007-x.md)");
    expect(text).toContain("2026-03-04");
    expect(text.match(/^\| 047-/gm)).toHaveLength(1);
  });

  it("named cells still win: refs given explicitly replace the ones on record", async () => {
    const fs = await seeded();
    await upsertRow(fs, HISTORY, { code: "047", state: "closed", refs: "—" });
    expect(await fs.readText(HISTORY)).toContain("| 047-algo-quick | 2026-03-04 | closed | — |");
  });

  it("a row nobody dated gets today ONCE, and never re-dates itself afterwards", async () => {
    const fs = new FakeFs({ lenient: true });
    await upsertRow(fs, HISTORY, { code: "050", sesionName: "050-nueva-quick", state: "active" });
    const born = await fs.readText(HISTORY);
    const date = born
      .split("\n")
      .find((l) => l.startsWith("| 050-"))
      ?.split("|")[2]
      ?.trim();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await upsertRow(fs, HISTORY, { code: "050", sesionName: "050-nueva-quick", state: "closed" });
    const after = await fs.readText(HISTORY);
    expect(after).toContain(`| 050-nueva-quick | ${date} | closed | — |`);
  });
});

// S027/AC-10 / AC-11 — the row belongs to the table, and one session has one row.
describe("history-table — the row lands inside the table", () => {
  it("inserts inside the table even with prose below it, leaving the prose intact", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(
      HISTORY,
      `# Session History\n\n${SLIM_HEADER}\n| 001-alpha-quick | 2026-01-01 | closed | — |\n\n## Notas\n\nel hub arrancó en enero.\n`,
    );
    await upsertRow(fs, HISTORY, fields("002", "002-beta-quick"));
    const lines = (await fs.readText(HISTORY)).split("\n");
    const table = lines.findIndex((l) => l.startsWith("| 001-alpha-quick"));
    const added = lines.findIndex((l) => l.startsWith("| 002-beta-quick"));
    const notes = lines.findIndex((l) => l === "## Notas");
    expect(added).toBe(table + 1);
    expect(added).toBeLessThan(notes);
    expect(lines[lines.length - 2]).toBe("el hub arrancó en enero.");
  });

  it("closing a legacy folder updates its row instead of adding a second one", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(
      HISTORY,
      `# Session History\n\n${SLIM_HEADER}\n| session047-legacy-x | 2026-02-02 | active | docs/x.md |\n`,
    );
    const action = await upsertRow(fs, HISTORY, {
      code: "047",
      sesionName: "legacy-x",
      state: "closed",
    });
    expect(action).toBe("updated");
    const text = await fs.readText(HISTORY);
    expect(text.match(/^\|.*047/gm)).toHaveLength(1);
    // The key is re-spelled in the current shape; the cells nobody named survive.
    expect(text).toContain("| 047-legacy-x | 2026-02-02 | closed | docs/x.md |");
  });

  it("a numeric identity never reaches a longer number", async () => {
    const fs = new FakeFs({ lenient: true });
    await upsertRow(fs, HISTORY, fields("1000", "1000-decoy-quick"));
    const action = await upsertRow(fs, HISTORY, fields("100", "100-target-quick"));
    expect(action).toBe("added");
    const text = await fs.readText(HISTORY);
    expect(text).toContain("| 1000-decoy-quick |");
    expect(text).toContain("| 100-target-quick |");
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

  const LEGACY_EMPTY_EXTRAS =
    "# Session History\n\n" +
    "| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n" +
    "|---|-------|--------|-------|--------|---------|------|\n" +
    "| 001 | — | 001-foo-quick | 2026-01-01 | active | — | — |\n";

  it("migrates a 7-col table (drops #/Flujo/Resumen, re-keys Sesión with its code)", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_7COL);
    const action = await upsertRow(fs, HISTORY, fields("001", "001-dev-foo", "closed"));
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

  // S027/AC-12 — the slim shape has no column for Flujo/Resumen and its render
  // is frozen, so the columns are preserved beside the record, verbatim.
  it("parks the previous bytes in HISTORY.legacy.md when a column with content is dropped", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_7COL);
    await upsertRow(fs, HISTORY, fields("001", "001-dev-foo", "closed"));
    const snapshot = await fs.readText(SNAPSHOT);
    expect(snapshot).toBe(LEGACY_7COL);
    expect(snapshot).toContain("Tarea foo");
    expect(snapshot).toContain("| Flujo |");
  });

  it("keeps the FIRST snapshot: a later lossy rewrite never overwrites it", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_7COL);
    await upsertRow(fs, HISTORY, fields("001", "001-dev-foo", "closed"));
    await fs.writeText(HISTORY, LEGACY_6COL);
    await upsertRow(fs, HISTORY, fields("001", "001-dev-foo", "closed"));
    expect(await fs.readText(SNAPSHOT)).toBe(LEGACY_7COL);
  });

  it("does not snapshot when the dropped columns were empty", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_EMPTY_EXTRAS);
    await upsertRow(fs, HISTORY, fields("001", "001-foo-quick", "closed"));
    expect(await fs.exists(SNAPSHOT)).toBe(false);
    expect(await fs.readText(HISTORY)).toContain("| 001-foo-quick | 2026-07-01 | closed | — |");
  });

  it("migrates a 6-col table (without Flujo) the same way", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_6COL);
    const action = await upsertRow(fs, HISTORY, fields("003", "003-baz-quick"));
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
    await upsertRow(fs, HISTORY, fields("001", "001-dev-foo"));
    const action = await upsertRow(fs, HISTORY, fields("001", "001-dev-foo", "closed"));
    expect(action).toBe("updated");
    const text = await fs.readText(HISTORY);
    expect(text.match(/^\| 001-/gm)).toHaveLength(1);
  });

  it("persists the migration even when the upserted row is unchanged", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, LEGACY_7COL);
    // The legacy 002 row migrates to exactly this shape → "unchanged"…
    const action = await upsertRow(fs, HISTORY, {
      code: "002",
      sesionName: "002-bar-quick",
      date: "2026-01-02",
      state: "closed",
      refs: "docs/x.md",
    });
    expect(action).toBe("unchanged");
    // …but the migrated table must still hit disk, and what it dropped survives.
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).not.toContain("Flujo");
    expect(await fs.readText(SNAPSHOT)).toBe(LEGACY_7COL);
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
    const action = await upsertRow(fs, HISTORY, fields("058", "058-nueva-plan-exec"));
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
    const action = await upsertRow(fs, HISTORY, fields("058", "058-nueva-plan-exec"));
    expect(action).toBe("added");
    const text = await fs.readText(HISTORY);
    // Unmappable → left verbatim. Losing the row would be worse than a mixed table.
    expect(text).toContain("| 001 | — | 001-alpha-plan-exec | 2026-07-01 | closed | alpha | — |");
    expect(text).toContain("| 058-nueva-plan-exec | 2026-07-01 | active | — |");
  });

  it("preserves a legacy row's date by its header when the table cannot migrate", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(
      HISTORY,
      "# Session History\n\n" +
        "| # | Flujo | Sesión | Estado | Fecha | Resumen | Refs |\n" +
        "| 001 | dev | alpha | active | 2025-01-12 | alpha | docs/a.md |\n",
    );

    await upsertRow(fs, HISTORY, { code: "001", sesionName: "001-alpha", state: "closed" });

    expect(await fs.readText(HISTORY)).toContain("| 001-alpha | 2025-01-12 | closed | — |");
  });

  it("records an unknown legacy date as an em dash, never the migration day", async () => {
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(
      HISTORY,
      "# Session History\n\n" +
        "| # | Flujo | Sesión | Estado | Resumen | Refs |\n" +
        "| 001 | dev | alpha | active | alpha | docs/a.md |\n",
    );

    await upsertRow(fs, HISTORY, { code: "001", sesionName: "001-alpha", state: "closed" });

    expect(await fs.readText(HISTORY)).toContain("| 001-alpha | — | closed | — |");
  });

  it("snapshots before replacing a row of a shape it cannot map", async () => {
    const unmappable =
      "# Session History\n\n" +
      "| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n" +
      "| 001 | dev | 001-alpha-plan-exec | 2026-07-01 | active | alpha | — |\n";
    const fs = new FakeFs({ lenient: true });
    await fs.mkdirp("/cwd/.workflow");
    await fs.writeText(HISTORY, unmappable);
    const action = await upsertRow(fs, HISTORY, fields("001", "001-alpha-plan-exec", "closed"));
    expect(action).toBe("updated");
    expect(await fs.readText(SNAPSHOT)).toBe(unmappable);
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
    await upsertRow(fs, HISTORY, fields("058", "058-nueva-plan-exec"));
    const text = await fs.readText(HISTORY);
    expect(text).toContain(SLIM_HEADER);
    expect(text).toContain("| 001-alpha-plan-exec | 2026-07-01 | closed | — |");
    // The unrelated table keeps its own columns.
    expect(text).toContain("| Tema | Dueño |");
    expect(text).toContain("| deploy | ana |");
  });

  it("rejects an empty code instead of matching the separator row", async () => {
    const fs = new FakeFs({ lenient: true });
    await expect(upsertRow(fs, HISTORY, { code: " ", state: "active" })).rejects.toThrow(
      /must not be empty/,
    );
  });
});
