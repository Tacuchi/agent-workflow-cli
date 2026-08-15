import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dsnKeyForInstance,
  readDsnFile,
  resolveExactDsn,
} from "../../src/application/dsn-reader-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("readDsnFile", () => {
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
    const result = readDsnFile(paths);
    expect(result.exists).toBe(false);
    expect(result.values).toEqual({});
    expect(result.path).toBe(paths.userDsnFile());
  });

  it("parses KEY=value lines, ignoring comments and empties", () => {
    const file = paths.userDsnFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      "# comentario\nDB_ALPHA_DSN=postgres://u:p@h:5432/db\n\nDB_BETA_DSN=postgres://u2@h2/db2\n",
    );
    const result = readDsnFile(paths);
    expect(result.exists).toBe(true);
    expect(result.values).toEqual({
      DB_ALPHA_DSN: "postgres://u:p@h:5432/db",
      DB_BETA_DSN: "postgres://u2@h2/db2",
    });
  });

  it("dsnKeyForInstance suggests a generic variable from an alias", () => {
    expect(dsnKeyForInstance("alpha")).toBe("DB_ALPHA_DSN");
    expect(dsnKeyForInstance("beta")).toBe("DB_BETA_DSN");
    expect(dsnKeyForInstance("reporting")).toBe("DB_REPORTING_DSN");
    expect(dsnKeyForInstance("sales-qa")).toBe("DB_SALES_QA_DSN");
  });
});

describe("resolveExactDsn", () => {
  let tmpRoot: string;
  let paths: PathsService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dsn-resolve-"));
    paths = new PathsService(normalizeNamespace("workflow"), tmpRoot, tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const writeDsnFile = (body: string): void => {
    const file = paths.userDsnFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };

  it("prefers the exact exported variable over the persisted value", () => {
    writeDsnFile("ALPHA_DATABASE_URL=from-file\n");
    const resolved = resolveExactDsn(
      "ALPHA_DATABASE_URL",
      { ALPHA_DATABASE_URL: "from-env" },
      paths,
    );
    expect(resolved).toEqual({
      dsn: "from-env",
      variable: "ALPHA_DATABASE_URL",
      source: "env",
    });
  });

  it("reads the exact registered variable from dsn.env", () => {
    writeDsnFile("BETA_DATABASE_URL=from-file\n");
    const resolved = resolveExactDsn("BETA_DATABASE_URL", {}, paths);
    expect(resolved).toEqual({
      dsn: "from-file",
      variable: "BETA_DATABASE_URL",
      source: "dsn.env",
    });
  });

  it("does not derive or fall back to a differently named variable", () => {
    writeDsnFile("DB_ALPHA_DSN=from-file\n");
    expect(resolveExactDsn("TENANT_ALPHA_DSN", { DB_ALPHA_DSN: "from-env" }, paths)).toBeNull();
  });

  it("returns null when the exact variable exists nowhere", () => {
    expect(resolveExactDsn("ALPHA_DATABASE_URL", {}, paths)).toBeNull();
  });
});
