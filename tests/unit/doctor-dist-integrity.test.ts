import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDistManifest } from "../../scripts/write-dist-manifest.mjs";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { checkDistIntegrity } from "../../src/application/doctor/dist-integrity.js";
import { createInstallationProvider } from "../../src/application/doctor/provider-installation.js";
import { runDoctor } from "../../src/application/doctor/report.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { readPackageVersion } from "../../src/runtime/version.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "aw-dist-integrity-"));
  dirs.push(dir);
  mkdirSync(join(dir, "cli"));
  writeFileSync(join(dir, "cli", "main.js"), "export {};\n");
  writeFileSync(join(dir, "cli", "main.js.map"), "{}\n");
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("manifiesto del build y doctor sin red", () => {
  it("el script sella todos los bytes del árbol excepto su propio manifiesto", async () => {
    const dir = fixture();
    await writeDistManifest(dir, readPackageVersion());
    const manifest = JSON.parse(readFileSync(join(dir, "dist-manifest.json"), "utf8"));
    expect(manifest.version).toBe(readPackageVersion());
    expect(manifest.files).toEqual([
      {
        path: "cli/main.js",
        sha256: `sha256:${createHash("sha256").update("export {};\n").digest("hex")}`,
      },
      {
        path: "cli/main.js.map",
        sha256: `sha256:${createHash("sha256").update("{}\n").digest("hex")}`,
      },
    ]);
    await writeDistManifest(dir, readPackageVersion());
    expect(manifest).toEqual(JSON.parse(readFileSync(join(dir, "dist-manifest.json"), "utf8")));
  });

  it("avisa de un editado, borrado y agregado por nombre sin subir el exit code", async () => {
    const dir = fixture();
    await writeDistManifest(dir, readPackageVersion());
    writeFileSync(join(dir, "cli", "main.js"), "parchado");
    rmSync(join(dir, "cli", "main.js.map"));
    writeFileSync(join(dir, "extra.js"), "extra");
    const finding = await checkDistIntegrity(new NodeFileSystem(), dir);
    expect(finding.state).toBe("warning");
    expect(finding.evidence).toEqual([
      "editado: cli/main.js",
      "borrado: cli/main.js.map",
      "agregado: extra.js",
    ]);
    const proc = new FakeProcess();
    const home = join(dir, "home");
    mkdirSync(home);
    mkdirSync(join(home, ".claude", "skills", "w"), { recursive: true });
    const ctx = {
      fs: new NodeFileSystem(),
      env: new FakeEnv(home, dir),
      process: proc,
      paths: new PathsService(normalizeNamespace("workflow"), home, dir),
      namespace: { namespace: normalizeNamespace("workflow"), source: "default" },
      runtime: { packageName: "@tacuchi/agent-workflow-cli", binName: "aw", source: "default" },
    } as CliContext;
    const report = await runDoctor(ctx, {}, { providers: [createInstallationProvider(dir)] });
    expect(report.findings.find((entry) => entry.id === finding.id)?.evidence).toEqual(
      finding.evidence,
    );
    expect(report.verdict.exit_code).toBe(0);
    expect(proc.calls).toEqual([]);
  });

  it("sin referencia y con versión ajena declara sin verificar, no parche", async () => {
    const dir = fixture();
    const fs = new NodeFileSystem();
    expect((await checkDistIntegrity(fs, dir)).state).toBe("unverified");
    expect((await checkDistIntegrity(fs, dir)).summary).toContain("sin verificar");
    await writeDistManifest(dir, "99.0.0");
    const finding = await checkDistIntegrity(fs, dir);
    expect(finding.state).toBe("unverified");
    expect(finding.summary).toContain("otra versión");
    expect(finding.summary).not.toContain("no coincide");
  });
});
