import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { writeMcpEntry } from "../../src/application/mcp-host-writer.js";
import { runMultiroot } from "../../src/application/multiroot-service.js";
import { attachClaude } from "../../src/application/multiroot/claude.js";
import { attachCodex } from "../../src/application/multiroot/codex.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runVisibilityDoctor } from "../../src/application/visibility-doctor-service.js";
import { buildMcpEntry } from "../../src/domain/mcp-entry.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { worktreeFixture } from "../helpers/worktree-fixture.js";

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

it("dos altas simultáneas de Claude conservan ambas rutas, sin respaldos ni lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-atomic-multiroot-"));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  await Promise.all([
    Promise.resolve().then(() => attachClaude(["/tmp/alpha"], root)),
    Promise.resolve().then(() => attachClaude(["/tmp/beta"], root)),
  ]);
  const target = join(root, ".claude", "settings.local.json");
  const data = JSON.parse(readFileSync(target, "utf8"));
  expect(data.permissions.additionalDirectories).toEqual(["/tmp/alpha", "/tmp/beta"]);
  expect(
    readdirSync(join(root, ".claude")).filter(
      (name) => name.includes(".bak.") || name.endsWith(".agent-workflow.lock"),
    ),
  ).toEqual([]);
});

it("MCP y multiroot comparten el candado Codex y conservan ambas secciones", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-atomic-codex-"));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  await Promise.all([
    Promise.resolve().then(() => attachCodex(["/tmp/alpha"], root)),
    Promise.resolve().then(() =>
      writeMcpEntry("codex", buildMcpEntry("alpha", "ALPHA_DATABASE_URL", { host: "codex" }), {
        scopeDir: root,
      }),
    ),
  ]);
  const content = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  expect(content).toContain("/tmp/alpha");
  expect(content).toContain("[mcp_servers.alpha]");
  expect(
    readdirSync(join(root, ".codex")).filter(
      (name) => name.includes(".bak.") || name.endsWith(".agent-workflow.lock"),
    ),
  ).toEqual([]);
});

it("JSON inválido sale como error por host, sin pisar el contenido", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-bad-multiroot-"));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.local.json"), "{malformed");
  const result = await runMultiroot(
    new NodeFileSystem(),
    new FakeEnv(root, root),
    new PathsService(normalizeNamespace("workflow"), root, root),
    "attach",
    { paths: ["/tmp/alpha"], skipCodex: true, skipWarp: true, skipOz: true },
  );
  expect(result).toMatchObject({ error: "claude: invalid_json" });
  expect(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")).toBe("{malformed");
});

it("visibility doctor reconoce la unidad registrada de otro flujo aun con sesión cerrada", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  f.close();
  const report = await runVisibilityDoctor(f.deps.fs, f.deps.env, f.deps.paths, {});
  for (const host of report.reports.filter((entry) => entry.host !== "warp")) {
    expect(host.registered_paths).toContain(unit.path);
    expect(host.declared_paths).toContain(unit.path);
    expect(host.extra).not.toContain(unit.path);
  }
});

it("reparar un sobrante conserva fuente y unidad viva en ambos hosts", async () => {
  const f = worktreeFixture();
  dispose.push(f.dispose);
  const unit = await f.run("ensure");
  if (!("path" in unit)) throw new Error("no unit");
  const intrusa = join(f.root, "intrusa");
  mkdirSync(intrusa);
  attachClaude([f.repo, intrusa], f.workspace);
  attachCodex([f.repo, intrusa], f.workspace);
  const before = await runVisibilityDoctor(f.deps.fs, f.deps.env, f.deps.paths, {});
  for (const report of before.reports.filter((item) => item.host !== "warp")) {
    expect(report.extra).toEqual([intrusa]);
    expect(report.extra).not.toContain(unit.path);
  }
  const repair = await runMultiroot(f.deps.fs, f.deps.env, f.deps.paths, "detach", {
    paths: [intrusa],
    skipWarp: true,
    skipOz: true,
  });
  expect(repair).not.toHaveProperty("error");
  const after = await runVisibilityDoctor(f.deps.fs, f.deps.env, f.deps.paths, {});
  for (const report of after.reports.filter((item) => item.host !== "warp")) {
    expect(report.extra).toEqual([]);
    expect(report.registered_paths).toContain(f.repo);
    expect(report.registered_paths).toContain(unit.path);
  }
});
