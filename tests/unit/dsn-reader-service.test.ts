import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dsnKeyCandidates,
  dsnKeyForInstance,
  readBootstrapDsn,
  resolveDsnFromCandidates,
} from "../../src/application/dsn-reader-service.js";
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

describe("dsnKeyCandidates", () => {
  it("drops the organisation prefix, canonical first", () => {
    expect(dsnKeyCandidates("qtc-cert")).toEqual(["DB_QTC_CERT_DSN", "DB_CERT_DSN"]);
  });

  it("drops exactly ONE segment, so aliases of different orgs never share a name", () => {
    // DB_RO_DSN is absent on purpose: collapsing to the last segment would make
    // `qtc-cert-ro` and `acme-cert-ro` collide, and connecting a server to
    // another environment's credential is worse than refusing to start.
    expect(dsnKeyCandidates("qtc-cert-ro")).toEqual(["DB_QTC_CERT_RO_DSN", "DB_CERT_RO_DSN"]);
    expect(dsnKeyCandidates("a-b-c")).toEqual(["DB_A_B_C_DSN", "DB_B_C_DSN"]);
  });

  it("yields exactly the canonical key for a single-segment instance", () => {
    expect(dsnKeyCandidates("cert")).toEqual(["DB_CERT_DSN"]);
  });

  it("leads with the canonical key of dsnKeyForInstance", () => {
    for (const instance of ["cert", "qtc-cert", "a-b-c", "sales_qa"]) {
      expect(dsnKeyCandidates(instance)[0]).toBe(dsnKeyForInstance(instance));
    }
  });
});

describe("resolveDsnFromCandidates", () => {
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

  it("prefers an exported variable over a persisted one, even a less specific one", () => {
    writeDsnFile("DB_QTC_CERT_DSN=from-file\n");
    const resolved = resolveDsnFromCandidates(
      ["DB_QTC_CERT_DSN", "DB_CERT_DSN"],
      { DB_CERT_DSN: "from-env" },
      paths,
    );
    expect(resolved).toEqual({ dsn: "from-env", variable: "DB_CERT_DSN", source: "env" });
  });

  it("prefers the most specific candidate within the same source", () => {
    writeDsnFile("DB_QTC_CERT_DSN=specific\nDB_CERT_DSN=generic\n");
    const resolved = resolveDsnFromCandidates(["DB_QTC_CERT_DSN", "DB_CERT_DSN"], {}, paths);
    expect(resolved).toEqual({ dsn: "specific", variable: "DB_QTC_CERT_DSN", source: "dsn.env" });

    const fromEnv = resolveDsnFromCandidates(
      ["DB_QTC_CERT_DSN", "DB_CERT_DSN"],
      { DB_QTC_CERT_DSN: "env-specific", DB_CERT_DSN: "env-generic" },
      paths,
    );
    expect(fromEnv?.variable).toBe("DB_QTC_CERT_DSN");
  });

  it("falls to the file only after every candidate missed the environment", () => {
    writeDsnFile("DB_CERT_DSN=from-file\n");
    const resolved = resolveDsnFromCandidates(
      ["DB_QTC_CERT_DSN", "DB_CERT_DSN"],
      { DB_QTC_CERT_DSN: "" },
      paths,
    );
    expect(resolved).toEqual({ dsn: "from-file", variable: "DB_CERT_DSN", source: "dsn.env" });
  });

  it("returns null when no candidate exists anywhere", () => {
    expect(resolveDsnFromCandidates(["DB_CERT_DSN"], {}, paths)).toBeNull();
  });
});
