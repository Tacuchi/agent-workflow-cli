import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("runNextNumber", () => {
  let hub: string;
  let env: FakeEnv;
  let fs: NodeFileSystem;
  let paths: PathsService;

  beforeEach(() => {
    hub = mkdtempSync(join(tmpdir(), "next-number-"));
    env = new FakeEnv(hub, hub);
    fs = new NodeFileSystem();
    paths = new PathsService(normalizeNamespace("workflow"), hub, hub);
  });
  afterEach(() => {
    rmSync(hub, { recursive: true, force: true });
  });

  it("crea el directorio faltante on-demand (created=true, exists reporta el estado previo)", async () => {
    const result = await runNextNumber(fs, env, paths, { directory: "docs/specs" });
    expect(result.exists).toBe(false);
    expect(result.created).toBe(true);
    expect(result.next).toBe("001");
    expect(result.current_max).toBe(0);
    expect(result.files).toEqual([]);
    expect(existsSync(join(hub, "docs", "specs"))).toBe(true);
  });

  it("--dry-run es consulta pura: nunca crea el directorio", async () => {
    const result = await runNextNumber(fs, env, paths, { directory: "docs/plans", dryRun: true });
    expect(result.exists).toBe(false);
    expect(result.created).toBe(false);
    expect(result.next).toBe("001");
    expect(existsSync(join(hub, "docs", "plans"))).toBe(false);
  });

  it("directorio existente: no re-crea y numera sobre archivos Y carpetas con prefijo NNN", async () => {
    const dir = join(hub, "docs", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001-informe.md"), "x");
    mkdirSync(join(dir, "003-export-scripts-2026-07-03"));
    writeFileSync(join(dir, "sin-numero.md"), "x");
    const result = await runNextNumber(fs, env, paths, { directory: "docs/reports" });
    expect(result.exists).toBe(true);
    expect(result.created).toBe(false);
    expect(result.current_max).toBe(3);
    expect(result.next).toBe("004");
    expect(result.files).toContain("001-informe.md");
    expect(result.files).toContain("sin-numero.md");
  });

  it("path absoluto se respeta tal cual (no se une al cwd)", async () => {
    const abs = join(hub, "otro", "lado");
    const result = await runNextNumber(fs, env, paths, { directory: abs });
    expect(result.created).toBe(true);
    expect(existsSync(abs)).toBe(true);
    expect(result.directory).toBe(abs.split("\\").join("/"));
  });

  it("dry-run sobre existente: mismos números que el modo normal", async () => {
    const dir = join(hub, "docs", "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "007-x.sql"), "-- x");
    const result = await runNextNumber(fs, env, paths, { directory: "docs/scripts", dryRun: true });
    expect(result.exists).toBe(true);
    expect(result.created).toBe(false);
    expect(result.next).toBe("008");
  });

  it("continúa 999 hacia 1000 y conserva el orden numérico", async () => {
    const dir = join(hub, "docs", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "999-plan-legacy.md"), "x");

    const after999 = await runNextNumber(fs, env, paths, { directory: "docs/plans", dryRun: true });
    expect(after999.next).toBe("1000");

    writeFileSync(join(dir, "1000-plan-corte.md"), "x");
    const after1000 = await runNextNumber(fs, env, paths, {
      directory: "docs/plans",
      dryRun: true,
    });
    expect(after1000.current_max).toBe(1000);
    expect(after1000.next).toBe("1001");
  });
});
