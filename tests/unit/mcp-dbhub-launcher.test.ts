import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertMcpConnection } from "../../src/application/mcp-connections-service.js";
import {
  DbhubBannerFilter,
  type DbhubLauncherDeps,
  DbhubLauncherError,
  forwardDbhubStdout,
  resolveDsn,
} from "../../src/application/mcp-dbhub-launcher.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("resolveDsn — registered exact variable", () => {
  let tmpRoot: string;
  let paths: PathsService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dbhub-launcher-"));
    paths = new PathsService(normalizeNamespace("workflow"), tmpRoot, tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const depsWith = (env: Record<string, string | undefined>): DbhubLauncherDeps => ({
    env,
    paths,
    platform: "darwin",
  });

  const register = (name: string, dsnVar: string): void => {
    upsertMcpConnection(paths, { name, dsnVar });
  };

  const writeDsnFile = (body: string): void => {
    const file = paths.userDsnFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };

  it("resolves the exact variable registered for the selected connection", () => {
    register("alpha", "ALPHA_DATABASE_URL");
    const resolved = resolveDsn("alpha", depsWith({ ALPHA_DATABASE_URL: "postgres://env" }));
    expect(resolved).toEqual({
      dsn: "postgres://env",
      variable: "ALPHA_DATABASE_URL",
      source: "env",
    });
  });

  it("uses the sole registered connection when no instance is supplied", () => {
    register("alpha", "ALPHA_DATABASE_URL");
    const resolved = resolveDsn(undefined, depsWith({ ALPHA_DATABASE_URL: "postgres://env" }));
    expect(resolved.variable).toBe("ALPHA_DATABASE_URL");
  });

  it("reads the exact registered variable from dsn.env", () => {
    register("beta", "BETA_DATABASE_URL");
    writeDsnFile("BETA_DATABASE_URL=postgres://file\n");
    const resolved = resolveDsn("beta", depsWith({}));
    expect(resolved).toEqual({
      dsn: "postgres://file",
      variable: "BETA_DATABASE_URL",
      source: "dsn.env",
    });
  });

  it("does not fall back to a variable derived from the connection name", () => {
    register("tenant-alpha", "TENANT_ALPHA_DATABASE_URL");
    let message = "";
    try {
      resolveDsn("tenant-alpha", depsWith({ ALPHA_DATABASE_URL: "postgres://env" }));
    } catch (err) {
      message = err instanceof DbhubLauncherError ? err.message : String(err);
    }
    expect(message).toContain("TENANT_ALPHA_DATABASE_URL");
    expect(message).toContain("tenant-alpha");
  });

  it("ignores DBHUB_DSN_VAR as an override", () => {
    register("alpha", "ALPHA_DATABASE_URL");
    const resolved = resolveDsn(
      "alpha",
      depsWith({ DBHUB_DSN_VAR: "OTHER_DATABASE_URL", ALPHA_DATABASE_URL: "postgres://env" }),
    );
    expect(resolved.variable).toBe("ALPHA_DATABASE_URL");
  });

  it("fails closed when no connection is registered", () => {
    expect(() => resolveDsn(undefined, depsWith({}))).toThrow(/No hay conexiones MCP registradas/);
  });

  it("requires --instance when more than one connection is registered", () => {
    register("alpha", "ALPHA_DATABASE_URL");
    register("beta", "BETA_DATABASE_URL");
    expect(() => resolveDsn(undefined, depsWith({}))).toThrow(/Indicá --instance/);
  });

  it("rejects an unregistered explicit connection", () => {
    register("alpha", "ALPHA_DATABASE_URL");
    expect(() => resolveDsn("beta", depsWith({}))).toThrow(/no está registrada/);
  });

  it("reports an unreadable dsn.env instead of pretending the DSN is absent", () => {
    // A directory where the file should be: the read fails, and the diagnostic
    // must name that cause rather than the generic "no está exportada".
    register("alpha", "ALPHA_DATABASE_URL");
    mkdirSync(paths.userDsnFile(), { recursive: true });
    let message = "";
    try {
      resolveDsn("alpha", depsWith({}));
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
