import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DbhubBannerFilter,
  type DbhubLauncherDeps,
  DbhubLauncherError,
  forwardDbhubStdout,
  resolveDsn,
} from "../../src/application/mcp-dbhub-launcher.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("resolveDsn — candidate chain", () => {
  let tmpRoot: string;
  let paths: PathsService;
  let notes: string[];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dbhub-launcher-"));
    paths = new PathsService(normalizeNamespace("workflow"), tmpRoot, tmpRoot);
    notes = [];
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const depsWith = (env: Record<string, string | undefined>): DbhubLauncherDeps => ({
    env,
    paths,
    platform: "darwin",
    stderr: (chunk) => {
      notes.push(chunk);
    },
  });

  const writeDsnFile = (body: string): void => {
    const file = paths.userDsnFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };

  it("resolves the canonical variable silently and reports where it came from", () => {
    const resolved = resolveDsn("cert", depsWith({ DB_CERT_DSN: "postgres://env" }));
    expect(resolved).toEqual({
      dsn: "postgres://env",
      variable: "DB_CERT_DSN",
      source: "env",
    });
    expect(notes).toEqual([]);
  });

  it("accepts the alias without the organisation prefix and says so on stderr", () => {
    const resolved = resolveDsn("qtc-cert", depsWith({ DB_CERT_DSN: "postgres://env" }));
    expect(resolved.variable).toBe("DB_CERT_DSN");
    expect(resolved.source).toBe("env");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("DB_CERT_DSN");
    expect(notes[0]).toContain("DB_QTC_CERT_DSN");
    expect(notes[0]).toContain("process.env");
  });

  it("names the dsn.env file when the non-canonical value was persisted there", () => {
    writeDsnFile("DB_CERT_DSN=postgres://file\n");
    const resolved = resolveDsn("qtc-cert", depsWith({}));
    expect(resolved).toEqual({
      dsn: "postgres://file",
      variable: "DB_CERT_DSN",
      source: "dsn.env",
    });
    expect(notes[0]).toContain(paths.userDsnFile());
  });

  it("gives an exported variable precedence over a persisted, more specific one", () => {
    writeDsnFile("DB_QTC_CERT_DSN=postgres://file\n");
    const resolved = resolveDsn("qtc-cert", depsWith({ DB_CERT_DSN: "postgres://env" }));
    expect(resolved).toEqual({
      dsn: "postgres://env",
      variable: "DB_CERT_DSN",
      source: "env",
    });
  });

  it("gives the most specific candidate precedence inside the same source", () => {
    writeDsnFile("DB_QTC_CERT_DSN=postgres://specific\nDB_CERT_DSN=postgres://generic\n");
    const resolved = resolveDsn("qtc-cert", depsWith({}));
    expect(resolved.dsn).toBe("postgres://specific");
    expect(resolved.variable).toBe("DB_QTC_CERT_DSN");
    expect(notes).toEqual([]);
  });

  it("lists every candidate, both lookup places and both real ways out", () => {
    let message = "";
    try {
      resolveDsn("qtc-cert", depsWith({}));
    } catch (err) {
      message = err instanceof DbhubLauncherError ? err.message : String(err);
    }
    expect(message).toContain("DB_QTC_CERT_DSN");
    expect(message).toContain("DB_CERT_DSN");
    expect(message).toContain("process.env");
    expect(message).toContain(paths.userDsnFile());
    expect(message).toContain("DBHUB_DSN_VAR");
    expect(message).toContain("--dsn-var");
    expect(message).toContain("qtc-cert");
  });

  it("probes only DBHUB_DSN_VAR when it is set — no derived candidates", () => {
    const deps = depsWith({ DBHUB_DSN_VAR: "MY_DSN", DB_CERT_DSN: "postgres://env" });
    expect(() => resolveDsn("qtc-cert", deps)).toThrow(DbhubLauncherError);
    try {
      resolveDsn("qtc-cert", deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("MY_DSN");
      expect(message).not.toContain("DB_QTC_CERT_DSN");
    }
  });

  it("uses the value of an explicit DBHUB_DSN_VAR without any stderr note", () => {
    const resolved = resolveDsn("qtc-cert", depsWith({ DBHUB_DSN_VAR: "my_dsn", MY_DSN: "x" }));
    expect(resolved).toEqual({ dsn: "x", variable: "MY_DSN", source: "env" });
    expect(notes).toEqual([]);
  });

  it("rejects an invalid DBHUB_DSN_VAR by name", () => {
    expect(() => resolveDsn("cert", depsWith({ DBHUB_DSN_VAR: "1-bad" }))).toThrow(
      /DBHUB_DSN_VAR inválida '1-bad'/,
    );
  });

  it("reports an unreadable dsn.env instead of pretending the DSN is absent", () => {
    // A directory where the file should be: the read fails, and the diagnostic
    // must name that cause rather than the generic "no está exportada".
    mkdirSync(paths.userDsnFile(), { recursive: true });
    let message = "";
    try {
      resolveDsn("cert", depsWith({}));
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("no se pudo leer");
    expect(message).toContain(paths.userDsnFile());
  });
});

describe("DbhubBannerFilter", () => {
  const utf8 = (buf: Buffer): string => buf.toString("utf-8");

  it("routes every banner line to stderr and nothing to stdout", () => {
    const filter = new DbhubBannerFilter();
    const routed = filter.push(Buffer.from("  ____  _   _\n | dbhub v1.2.3 |\n\n"));
    expect(utf8(routed.stderr)).toBe("  ____  _   _\n | dbhub v1.2.3 |\n\n");
    expect(routed.stdout).toHaveLength(0);
    expect(filter.started).toBe(false);
  });

  it("splits a chunk that carries the banner and the first JSON message", () => {
    const filter = new DbhubBannerFilter();
    const routed = filter.push(
      Buffer.from('banner line\n{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n'),
    );
    expect(utf8(routed.stderr)).toBe("banner line\n");
    expect(utf8(routed.stdout)).toBe('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n');
    expect(filter.started).toBe(true);
  });

  it("rescues the first message when the banner does not end in a newline", () => {
    // Sin el corte por marcador, la linea entera arranca con 'd' y el mensaje
    // pegado al banner se iba a stderr: el protocolo perdia su primer message.
    const filter = new DbhubBannerFilter();
    const routed = filter.push(Buffer.from('dbhub listo{"jsonrpc":"2.0","id":1}\n'));
    expect(utf8(routed.stderr)).toBe("dbhub listo");
    expect(utf8(routed.stdout)).toBe('{"jsonrpc":"2.0","id":1}\n');
    expect(filter.started).toBe(true);
  });

  it("releases a JSON line split across two chunks without waiting for its newline", () => {
    // The marker identifies the protocol before the line is complete, so the
    // handover happens earlier than the newline. What matters is that the bytes
    // arrive whole and in order: holding them back only adds latency.
    const filter = new DbhubBannerFilter();
    const first = filter.push(Buffer.from('banner\n{"jsonrpc":"2.0"'));
    expect(utf8(first.stderr)).toBe("banner\n");
    expect(utf8(first.stdout)).toBe('{"jsonrpc":"2.0"');
    expect(filter.started).toBe(true);

    const second = filter.push(Buffer.from(',"id":1}\n'));
    expect(second.stderr).toHaveLength(0);
    expect(utf8(second.stdout)).toBe(',"id":1}\n');
    expect(utf8(first.stdout) + utf8(second.stdout)).toBe('{"jsonrpc":"2.0","id":1}\n');
  });

  it("hands every later chunk through verbatim, without re-slicing lines", () => {
    const filter = new DbhubBannerFilter();
    filter.push(Buffer.from('{"jsonrpc":"2.0","id":1}\n'));
    const routed = filter.push(Buffer.from('{"partial": "no newline yet, and { braces }'));
    expect(utf8(routed.stdout)).toBe('{"partial": "no newline yet, and { braces }');
    expect(routed.stderr).toHaveLength(0);
  });

  it("indents do not fool it: a leading-blank JSON line still opens the protocol", () => {
    const filter = new DbhubBannerFilter();
    const routed = filter.push(Buffer.from('   {"jsonrpc":"2.0"}\n'));
    expect(utf8(routed.stdout)).toBe('   {"jsonrpc":"2.0"}\n');
    expect(filter.started).toBe(true);
  });

  it("dumps the leftover buffer to stderr when the child dies without JSON", () => {
    const filter = new DbhubBannerFilter();
    const routed = filter.push(Buffer.from("Error: ECONNREFUSED\nhalf a line"));
    expect(utf8(routed.stderr)).toBe("Error: ECONNREFUSED\n");
    const rest = filter.end();
    expect(utf8(rest.stderr)).toBe("half a line");
    expect(rest.stdout).toHaveLength(0);
    expect(filter.started).toBe(false);
  });

  it("keeps nothing buffered once the protocol started", () => {
    const filter = new DbhubBannerFilter();
    filter.push(Buffer.from('{"jsonrpc":"2.0","id":1}\nhalf'));
    expect(filter.end().stderr).toHaveLength(0);
  });
});

describe("forwardDbhubStdout", () => {
  const drive = async (chunks: string[]): Promise<{ protocol: string; diagnostics: string }> => {
    const source = new PassThrough();
    const protocol = new PassThrough();
    let received = "";
    protocol.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf-8");
    });
    let diagnostics = "";
    forwardDbhubStdout(source, {
      protocol,
      diagnostics: (chunk) => {
        diagnostics += chunk;
      },
    });
    for (const chunk of chunks) {
      source.write(chunk);
      // Let the stream deliver each chunk before the next one is queued, so the
      // listener→pipe handover happens mid-stream as it does in production.
      await new Promise((resolve) => setImmediate(resolve));
    }
    source.end();
    await new Promise((resolve) => setImmediate(resolve));
    return { protocol: received, diagnostics };
  };

  it("loses no byte across the handover from filtering to raw passthrough", async () => {
    const out = await drive([
      "  dbhub banner\n",
      'v1.0.0 ready\n{"jsonrpc":"2.0","id":1}\n',
      '{"jsonrpc":"2.0","id":2}\n',
      '{"jsonrpc"',
      ':"2.0","id":3}\n',
    ]);
    expect(out.protocol).toBe(
      '{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n{"jsonrpc":"2.0","id":3}\n',
    );
    expect(out.diagnostics).toBe("  dbhub banner\nv1.0.0 ready\n");
  });

  it("sends everything to diagnostics when the child never speaks JSON-RPC", async () => {
    const out = await drive(["Error: connection refused\n", "no trailing newline"]);
    expect(out.protocol).toBe("");
    expect(out.diagnostics).toBe("Error: connection refused\nno trailing newline");
  });
});
