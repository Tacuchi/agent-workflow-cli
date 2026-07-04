import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import type { EnvPort } from "../../src/ports/env.js";

class FakeEnv implements EnvPort {
  constructor(private readonly _cwd: string) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this._cwd;
  }
  cwd() {
    return this._cwd;
  }
}

describe("runNextNumber", () => {
  let workspace: string;
  let env: FakeEnv;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "next-number-"));
    env = new FakeEnv(workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("crea el directorio faltante on-demand (created=true, exists reporta el estado previo)", async () => {
    const result = await runNextNumber(fs, env, { directory: "docs/specs" });
    expect(result.exists).toBe(false);
    expect(result.created).toBe(true);
    expect(result.next).toBe("001");
    expect(result.current_max).toBe(0);
    expect(result.files).toEqual([]);
    expect(existsSync(join(workspace, "docs", "specs"))).toBe(true);
  });

  it("--dry-run es consulta pura: nunca crea el directorio", async () => {
    const result = await runNextNumber(fs, env, { directory: "docs/plans", dryRun: true });
    expect(result.exists).toBe(false);
    expect(result.created).toBe(false);
    expect(result.next).toBe("001");
    expect(existsSync(join(workspace, "docs", "plans"))).toBe(false);
  });

  it("directorio existente: no re-crea y numera sobre archivos Y carpetas con prefijo NNN", async () => {
    const dir = join(workspace, "docs", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001-informe.md"), "x");
    mkdirSync(join(dir, "003-export-scripts-2026-07-03"));
    writeFileSync(join(dir, "sin-numero.md"), "x");
    const result = await runNextNumber(fs, env, { directory: "docs/reports" });
    expect(result.exists).toBe(true);
    expect(result.created).toBe(false);
    expect(result.current_max).toBe(3);
    expect(result.next).toBe("004");
    expect(result.files).toContain("001-informe.md");
    expect(result.files).toContain("sin-numero.md");
  });

  it("path absoluto se respeta tal cual (no se une al cwd)", async () => {
    const abs = join(workspace, "otro", "lado");
    const result = await runNextNumber(fs, env, { directory: abs });
    expect(result.created).toBe(true);
    expect(existsSync(abs)).toBe(true);
    expect(result.directory).toBe(abs.split("\\").join("/"));
  });

  it("dry-run sobre existente: mismos números que el modo normal", async () => {
    const dir = join(workspace, "docs", "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "007-x.sql"), "-- x");
    const result = await runNextNumber(fs, env, { directory: "docs/scripts", dryRun: true });
    expect(result.exists).toBe(true);
    expect(result.created).toBe(false);
    expect(result.next).toBe("008");
  });
});
