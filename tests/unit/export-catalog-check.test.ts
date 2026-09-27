import { describe, expect, it } from "vitest";
import type { CatalogLookup } from "../../src/application/export-catalog-check.js";
import {
  applyExport,
  prepareExport,
  validateExportWithCatalog,
} from "../../src/application/export-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const env = new FakeEnv("/home", "/cwd");
const paths = () => new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
const date = "2026-09-27";

function fixture(): MemFs {
  const fs = new MemFs();
  fs.file("/cwd/.workflow/sessions/040-work/SESSION.md", "# SESSION\n\n## Objective\nMigrar\n");
  fs.file("/cwd/.workflow/sessions/040-work/SCRIPTS.sql", "CREATE TABLE esq.nueva (id int);");
  return fs;
}

function answer(
  prepared: Awaited<ReturnType<typeof prepareExport>> & { ok: true },
  forwards: Array<[string, string]>,
): string {
  const unit = prepared.value.unit;
  return JSON.stringify({
    version: 1,
    operation: "export-scripts",
    input_digest: prepared.value.request.input_digest,
    state: "proposed",
    scope: prepared.value.scope,
    decisions: { supersedes: [], requires: [] },
    artifacts: [
      { path: `${unit}/README.md`, content: "# Bundle\n" },
      { path: `${unit}/rollback/00-global/00-ROLLBACK.sql`, content: "-- global rollback\n" },
      ...forwards.flatMap(([file, content]) => [
        { path: `${unit}/${file}`, content },
        {
          path: `${unit}/rollback/${file.replace(/\.sql$/, ".rollback.sql")}`,
          content: "-- inverse\n",
        },
      ]),
    ],
  });
}

function catalog(
  columns: Array<{ schema: string; table: string; column: string }> = [],
): CatalogLookup & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async lookupColumns(_connection, schemas) {
      calls.push([...schemas]);
      return { ok: true, columns };
    },
  };
}

describe("export-scripts --catalog", () => {
  it("reporta todas las tablas y columnas faltantes juntas con el forward que las cita", async () => {
    const fs = fixture();
    const lookup = catalog([{ schema: "esq", table: "usuarios", column: "id" }]);
    const prepared = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      lookup,
    );
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const raw = answer(prepared, [
      ["03-migracion/01-update.sql", "UPDATE esq.usuarios SET ausente = 1;"],
      ["04-inserts/01-insert.sql", "INSERT INTO esq.no_existe (id) VALUES (1);"],
    ]);
    const checked = await validateExportWithCatalog(raw, prepared.value, lookup);
    if (checked.ok) throw new Error("expected missing catalog objects");
    expect(checked.failure.code).toBe("EXPORT_CATALOG_MISMATCH");
    for (const value of [
      "03-migracion/01-update.sql",
      "usuarios.ausente",
      "04-inserts/01-insert.sql",
      "no_existe",
    ]) {
      expect(checked.failure.message).toContain(value);
    }
    expect(await fs.exists(`/cwd/${prepared.value.unit}/README.md`)).toBe(false);
  });

  it("descuenta tablas y columnas que el propio bundle crea antes de usarlas", async () => {
    const fs = fixture();
    const lookup = catalog();
    const prepared = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      lookup,
    );
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const raw = answer(prepared, [
      ["01-ddl-tablas/01-new.sql", "CREATE TABLE IF NOT EXISTS esq.nueva (id int, nombre text);"],
      ["04-inserts/01-new.sql", "INSERT INTO esq.nueva (id, nombre) VALUES (1, 'x');"],
    ]);
    const checked = await validateExportWithCatalog(raw, prepared.value, lookup);
    if (!checked.ok) throw new Error(checked.failure.message);
    const applied = await applyExport(
      fs,
      env,
      paths(),
      { raw, prepared: prepared.value, approval: checked.value.approval_digest },
      lookup,
    );
    if (!applied.ok) throw new Error(applied.failure.message);
    expect(applied.value.written).toContain(`${prepared.value.unit}/README.md`);
    expect(lookup.calls.length).toBeGreaterThanOrEqual(3); // prepare, validate and apply
  });

  it("SET ignora comas dentro de funciones y REFERENCES comprueba la columna de destino", async () => {
    const fs = fixture();
    const lookup = catalog([
      { schema: "esq", table: "usuarios", column: "id" },
      { schema: "esq", table: "usuarios", column: "nombre" },
      { schema: "esq", table: "usuarios", column: "estado" },
    ]);
    const prepared = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      lookup,
    );
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const raw = answer(prepared, [
      [
        "01-ddl-tablas/01-fk.sql",
        "CREATE TABLE esq.nueva (id int, user_id int REFERENCES esq.usuarios(falta));",
      ],
      [
        "03-migracion/01-update.sql",
        "UPDATE esq.usuarios SET nombre = concat(estado, id), estado = 1 WHERE id = 1;",
      ],
    ]);
    const checked = await validateExportWithCatalog(raw, prepared.value, lookup);
    if (checked.ok) throw new Error("expected missing referenced column");
    expect(checked.failure.message).toContain("usuarios.falta");
    expect(checked.failure.message).not.toContain("usuarios.estado");
  });

  it("base inalcanzable falla en prepare y al aplicar sin dejar bundle", async () => {
    const fs = fixture();
    const unavailable: CatalogLookup = {
      async lookupColumns() {
        return { ok: false, code: "DATABASE_CONNECTION_FAILED", message: "sin conexión" };
      },
    };
    const denied = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      unavailable,
    );
    if (denied.ok) throw new Error("expected connection failure");
    expect(denied.failure.code).toBe("EXPORT_CATALOG_UNAVAILABLE");
    expect(denied.failure.message).toContain("alpha");
    const lookup = catalog();
    const prepared = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      lookup,
    );
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const raw = answer(prepared, [
      ["01-ddl-tablas/01-new.sql", "CREATE TABLE esq.nueva (id int);"],
    ]);
    const approved = await validateExportWithCatalog(raw, prepared.value, lookup);
    if (!approved.ok) throw new Error(approved.failure.message);
    const applied = await applyExport(
      fs,
      env,
      paths(),
      {
        raw,
        prepared: prepared.value,
        approval: approved.value.approval_digest,
      },
      unavailable,
    );
    if (applied.ok) throw new Error("expected unavailable catalog");
    expect(applied.failure.code).toBe("EXPORT_CATALOG_UNAVAILABLE");
    expect(await fs.exists(`/cwd/${prepared.value.unit}/README.md`)).toBe(false);
  });

  it("sin --catalog no consulta y un forward opaco se declara sin verificar cuando sí se pide", async () => {
    const fs = fixture();
    const lookup = catalog();
    const ordinary = await prepareExport(fs, env, paths(), "scripts", { date }, undefined, lookup);
    expect(ordinary.ok).toBe(true);
    expect(lookup.calls).toEqual([]);
    const requested = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      lookup,
    );
    if (!requested.ok) throw new Error(requested.failure.message);
    const raw = answer(requested, [
      ["03-migracion/01-dynamic.sql", "EXECUTE format('SELECT %I', 'x');"],
    ]);
    const checked = await validateExportWithCatalog(raw, requested.value, lookup);
    if (!checked.ok) throw new Error(checked.failure.message);
    expect(checked.value.preview.unverified).toContain(
      `${requested.value.unit}/03-migracion/01-dynamic.sql: sentencia sin referencias verificables`,
    );
  });

  it("declara cada sentencia opaca y las columnas de SELECT sin comprobar aunque haya una tabla verificable", async () => {
    const fs = fixture();
    const lookup = catalog([{ schema: "esq", table: "usuarios", column: "id" }]);
    const prepared = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      lookup,
    );
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const raw = answer(prepared, [
      [
        "03-migracion/01-mixed.sql",
        "SELECT columna_inexistente FROM esq.usuarios; EXECUTE format('SELECT %I', 'x');",
      ],
    ]);
    const checked = await validateExportWithCatalog(raw, prepared.value, lookup);
    if (!checked.ok) throw new Error(checked.failure.message);
    expect(checked.value.preview.unverified).toEqual(
      expect.arrayContaining([
        `${prepared.value.unit}/03-migracion/01-mixed.sql: columnas de consulta/predicado sin verificar`,
        `${prepared.value.unit}/03-migracion/01-mixed.sql: sentencia sin referencias verificables`,
      ]),
    );
  });

  it("un índice por expresión comprueba la tabla y declara sus columnas sin verificar", async () => {
    const fs = fixture();
    const lookup = catalog([{ schema: "esq", table: "usuarios", column: "id" }]);
    const prepared = await prepareExport(
      fs,
      env,
      paths(),
      "scripts",
      { date, catalog: "alpha" },
      undefined,
      lookup,
    );
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const raw = answer(prepared, [
      ["01-ddl-tablas/01-index.sql", "CREATE INDEX idx_name ON esq.usuarios (lower(nombre));"],
    ]);
    const checked = await validateExportWithCatalog(raw, prepared.value, lookup);
    if (!checked.ok) throw new Error(checked.failure.message);
    expect(checked.value.preview.unverified?.join(" ")).toContain("índice por expresión");
  });
});
