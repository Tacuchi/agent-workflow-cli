import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dsnKeyForInstance, readBootstrapDsn } from "../../src/application/dsn-reader-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("readBootstrapDsn", () => {
  let tmpRoot: string;
  let paths: PathsService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dsn-reader-"));
    paths = new PathsService(normalizeNamespace("workflow"), tmpRoot, tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns exists=false when file is missing", () => {
    const result = readBootstrapDsn(paths);
    expect(result.exists).toBe(false);
    expect(result.values).toEqual({});
    expect(result.path).toBe(paths.userDsnFile());
  });

  it("parses KEY=value lines, ignoring comments and empties", () => {
    const file = paths.userDsnFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      "# comentario\nDB_CERT_DSN=postgres://u:p@h:5432/db\n\nDB_PROD_DSN=postgres://u2@h2/db2\n",
    );
    const result = readBootstrapDsn(paths);
    expect(result.exists).toBe(true);
    expect(result.values).toEqual({
      DB_CERT_DSN: "postgres://u:p@h:5432/db",
      DB_PROD_DSN: "postgres://u2@h2/db2",
    });
  });

  it("dsnKeyForInstance maps cert→DB_CERT_DSN and prod→DB_PROD_DSN", () => {
    expect(dsnKeyForInstance("cert")).toBe("DB_CERT_DSN");
    expect(dsnKeyForInstance("prod")).toBe("DB_PROD_DSN");
    expect(dsnKeyForInstance("reporting")).toBe("DB_REPORTING_DSN");
    expect(dsnKeyForInstance("sales-qa")).toBe("DB_SALES_QA_DSN");
  });
});
