import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
const root = "/cwd/.workflow/sessions/040-migracion-plan-exec";
const sql = "-- [M1] Type: B\nCREATE TABLE t (id integer);\n";

function fixture(file?: string): MemFs {
  const fs = new MemFs();
  fs.file(`${root}/SESSION.md`, "# SESSION\n\n## Objective\nmigrar\n");
  if (file !== undefined) fs.file(`${root}/SCRIPTS.sql`, file);
  return fs;
}

async function close(fs: MemFs) {
  const result = await runSessionClose(fs, paths, { code: "040" });
  if (!("sessionClose" in result)) throw new Error(`close failed: ${JSON.stringify(result)}`);
  return result.sessionClose;
}

describe("session-close · migraciones aún no exportadas", () => {
  it("propone el export sin impedir el cierre", async () => {
    const output = await close(fixture(sql));
    expect(output.closed).toBe(true);
    expect(output.sql_pending_export).toEqual({
      files: ["SCRIPTS.sql"],
      command: "aw export-scripts prepare --sessions 040",
    });
  });

  it("no propone la migración cuyo digest consta en el origen de un bundle", async () => {
    const fs = fixture(sql);
    const digest = `sha256:${createHash("sha256").update(sql).digest("hex")}`;
    const bundle = "/cwd/docs/scripts/001-export-scripts-2026-09-27";
    fs.file(`${bundle}/01-ddl-tablas/01-t.sql`, sql);
    fs.file(
      `${bundle}/bundle.json`,
      JSON.stringify({
        origin: {
          sessions: [
            { session: "040-migracion-plan-exec", files: [{ path: "SCRIPTS.sql", digest }] },
          ],
        },
      }),
    );
    expect((await close(fs)).sql_pending_export).toBeUndefined();
  });

  it("las consultas tipo A y una sesión sin SQL no generan propuesta", async () => {
    expect(
      (await close(fixture("-- [Q1] Type: A — inspect CREATE TABLE usage\nSELECT 1;\n")))
        .sql_pending_export,
    ).toBeUndefined();
    expect((await close(fixture())).sql_pending_export).toBeUndefined();
  });
});
