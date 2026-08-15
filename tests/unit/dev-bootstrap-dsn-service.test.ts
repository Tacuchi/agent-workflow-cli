import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBootstrapDsn, writeDsnValue } from "../../src/application/dev-bootstrap-dsn-service.js";
import { readBootstrapDsn } from "../../src/application/dsn-reader-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("runBootstrapDsn", () => {
  let tmpRoot: string;
  let paths: PathsService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "bootstrap-dsn-"));
    paths = new PathsService(normalizeNamespace("workflow"), tmpRoot, tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const seedDsnFile = (body: string): void => {
    const file = paths.userDsnFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };

  it("writes both DSNs into a fresh file", () => {
    const result = runBootstrapDsn(paths, {
      certDsn: "postgres://cert",
      prodDsn: "postgres://prod",
    });
    expect(result).toEqual({
      ok: true,
      path: paths.userDsnFile(),
      wrote: ["DB_CERT_DSN", "DB_PROD_DSN"],
    });
    expect(readBootstrapDsn(paths).values).toEqual({
      DB_CERT_DSN: "postgres://cert",
      DB_PROD_DSN: "postgres://prod",
    });
  });

  it("preserves keys it does not own instead of rewriting the whole file", () => {
    seedDsnFile("DB_QTC_CERT_DSN=postgres://otra\nDB_CERT_DSN=postgres://vieja\n");
    runBootstrapDsn(paths, { certDsn: "postgres://nueva", prodDsn: undefined });
    expect(readBootstrapDsn(paths).values).toEqual({
      DB_QTC_CERT_DSN: "postgres://otra",
      DB_CERT_DSN: "postgres://nueva",
    });
  });

  it("keeps comments and blank-separated content of the existing file", () => {
    seedDsnFile("# conexiones del equipo\nDB_REPORTING_DSN=postgres://rep\n");
    runBootstrapDsn(paths, { certDsn: undefined, prodDsn: "postgres://prod" });
    const text = readFileSync(paths.userDsnFile(), "utf-8");
    expect(text).toContain("# conexiones del equipo");
    expect(text).toContain("DB_REPORTING_DSN=postgres://rep");
    expect(text).toContain("DB_PROD_DSN=postgres://prod");
  });

  it("keeps the blank lines that group the file", () => {
    seedDsnFile("# grupo A\n\nDB_A_DSN=a\n\n# grupo B\nDB_B_DSN=b\n");
    runBootstrapDsn(paths, { certDsn: "postgres://cert", prodDsn: undefined });
    const text = readFileSync(paths.userDsnFile(), "utf-8");
    expect(text).toBe(
      "# grupo A\n\nDB_A_DSN=a\n\n# grupo B\nDB_B_DSN=b\nDB_CERT_DSN=postgres://cert\n",
    );
  });

  it("replaces an INDENTED assignment instead of leaving the old credential behind", () => {
    // Un DSN viejo sobreviviendo en un archivo 0600 que el usuario cree
    // actualizado es peor que un archivo mal formateado.
    seedDsnFile("  DB_CERT_DSN=postgres://vieja\n");
    runBootstrapDsn(paths, { certDsn: "postgres://nueva", prodDsn: undefined });
    const text = readFileSync(paths.userDsnFile(), "utf-8");
    expect(text).not.toContain("postgres://vieja");
    expect(readBootstrapDsn(paths).values.DB_CERT_DSN).toBe("postgres://nueva");
  });

  it("collapses a duplicated key into a single line", () => {
    seedDsnFile("DB_CERT_DSN=uno\nDB_OTRA_DSN=x\nDB_CERT_DSN=dos\n");
    runBootstrapDsn(paths, { certDsn: "tres", prodDsn: undefined });
    const text = readFileSync(paths.userDsnFile(), "utf-8");
    expect(text).toBe("DB_CERT_DSN=tres\nDB_OTRA_DSN=x\n");
  });

  it("fails with exit code 2 when neither variable is visible", () => {
    const result = runBootstrapDsn(paths, { certDsn: undefined, prodDsn: undefined });
    expect(result).toEqual({
      error: expect.stringContaining("Ni DB_CERT_DSN ni DB_PROD_DSN"),
      exitCode: 2,
    });
  });

  it("leaves the file readable only by its owner", () => {
    runBootstrapDsn(paths, { certDsn: "postgres://cert", prodDsn: undefined });
    const mode = statSync(paths.userDsnFile()).mode & 0o777;
    // Windows has no POSIX modes; the chmod there is best effort.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });
});

describe("writeDsnValue", () => {
  let tmpRoot: string;
  let paths: PathsService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "write-dsn-"));
    paths = new PathsService(normalizeNamespace("workflow"), tmpRoot, tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("upserts one key and leaves the rest untouched", () => {
    runBootstrapDsn(paths, { certDsn: "postgres://cert", prodDsn: "postgres://prod" });
    const result = writeDsnValue(paths, { key: "DB_PROD_DSN", value: "postgres://prod2" });
    expect(result).toEqual({ ok: true, path: paths.userDsnFile(), key: "DB_PROD_DSN" });
    expect(readBootstrapDsn(paths).values).toEqual({
      DB_CERT_DSN: "postgres://cert",
      DB_PROD_DSN: "postgres://prod2",
    });
  });
});
