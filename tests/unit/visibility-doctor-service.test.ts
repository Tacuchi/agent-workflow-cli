import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type VisibilityDoctorResult,
  runVisibilityDoctor,
} from "../../src/application/visibility-doctor-service.js";
import { visibilityCommand } from "../../src/cli/commands/visibility.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

function writeProjectBlock(workspace: string, fuentes: { alias: string; path: string }[]): void {
  const start = "<!-- WORKFLOW-PROJECT-START -->";
  const end = "<!-- WORKFLOW-PROJECT-END -->";
  const lines = [
    start,
    "",
    "## Proyecto",
    "",
    "Test workspace.",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
  ];
  for (const f of fuentes) lines.push(`| ${f.alias} | ${f.path} | certificacion |`);
  lines.push(
    "",
    "## Stack",
    "",
    "_Stack sin detectar._",
    "",
    "## Status",
    "",
    "- Ramas de trabajo actuales: _ninguna_",
    "- Sesiones activas: _ninguna_",
    "",
    end,
  );
  writeFileSync(join(workspace, "CLAUDE.md"), `${lines.join("\n")}\n`);
}

function writeClaudeSettings(workspace: string, file: string, dirs: string[]): void {
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  writeFileSync(
    join(workspace, ".claude", file),
    JSON.stringify({ permissions: { additionalDirectories: dirs } }),
  );
}

function claudeOf(result: VisibilityDoctorResult) {
  return result.reports.find((r) => r.host === "claude");
}

describe("runVisibilityDoctor", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "vis-doctor-"));
    env = new FakeEnv(workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("status=no-project-block cuando no hay CLAUDE.md", async () => {
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    expect(result.summary.no_project_block).toBe(2);
    expect(result.reports[0]?.status).toBe("no-project-block");
  });

  it("status=no-settings cuando hay fuentes pero falta .claude/settings.json", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    expect(result.summary.no_settings).toBe(2);
    expect(result.reports[0]?.status).toBe("no-settings");
  });

  it("status=ok cuando settings.json y config.toml tienen las fuentes registradas", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: ["/tmp/a", "/tmp/b"] } }),
    );
    mkdirSync(join(workspace, ".codex"), { recursive: true });
    writeFileSync(
      join(workspace, ".codex", "config.toml"),
      'additional_writable_roots = [\n  "/tmp/a",\n  "/tmp/b"\n]\n',
    );
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    expect(result.summary.ok).toBe(3);
    for (const r of result.reports) expect(r.status).toBe("ok");
  });

  it("claude status=ok cuando las fuentes viven sólo en settings.local.json", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    // Per-machine convention: settings.local.json (gitignored), no settings.json.
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { additionalDirectories: ["/tmp/a", "/tmp/b"] } }),
    );
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const claude = result.reports.find((r) => r.host === "claude");
    expect(claude?.status).toBe("ok");
    expect(claude?.missing).toHaveLength(0);
  });

  it("status=missing-paths si settings tiene menos de los declarados", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: ["/tmp/a"] } }),
    );
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const claude = result.reports.find((r) => r.host === "claude");
    expect(claude?.status).toBe("missing-paths");
    expect(claude?.missing).toEqual(["/tmp/b"]);
  });

  it("status=extra-paths si settings tiene paths que no son fuentes", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { additionalDirectories: ["/tmp/a", "/tmp/b", "/tmp/extra"] },
      }),
    );
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const claude = result.reports.find((r) => r.host === "claude");
    expect(claude?.status).toBe("extra-paths");
    expect(claude?.extra).toEqual(["/tmp/extra"]);
  });

  it("warp siempre reporta status=ok (no tiene additionalDirectories)", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const warp = result.reports.find((r) => r.host === "warp");
    expect(warp).toBeDefined();
    expect(warp?.status).toBe("ok");
    expect(warp?.missing).toHaveLength(0);
    expect(warp?.extra).toHaveLength(0);
    expect(warp?.declared_paths).toHaveLength(0);
    expect(warp?.registered_paths).toHaveLength(0);
  });

  it("reports tiene exactamente 3 entradas: claude, codex, warp", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    expect(result.reports).toHaveLength(3);
    const hosts = result.reports.map((r) => r.host);
    expect(hosts).toContain("claude");
    expect(hosts).toContain("codex");
    expect(hosts).toContain("warp");
  });

  // Residual 1: the report used to name `.claude/settings.json` unconditionally,
  // so with only the .local file present it answered `ok` while pointing at a
  // file that does not exist.
  it("targets nombra sólo settings.local.json cuando settings.json no existe", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/a"]);
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const claude = claudeOf(result);
    expect(claude?.status).toBe("ok");
    expect(claude?.targets).toEqual([join(workspace, ".claude", "settings.local.json")]);
    expect(claude?.target).toBe(join(workspace, ".claude", "settings.local.json"));
  });

  it("targets nombra los DOS archivos cuando los dos existen", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    writeClaudeSettings(workspace, "settings.json", ["/tmp/a"]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/b"]);
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const claude = claudeOf(result);
    expect(claude?.status).toBe("ok");
    expect(claude?.targets).toEqual([
      join(workspace, ".claude", "settings.json"),
      join(workspace, ".claude", "settings.local.json"),
    ]);
    // `target` keeps the one-path shape: the FIRST file actually read.
    expect(claude?.target).toBe(join(workspace, ".claude", "settings.json"));
  });

  it("sin ningún settings el target sigue siendo settings.json (el archivo a crear)", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const claude = claudeOf(result);
    expect(claude?.status).toBe("no-settings");
    expect(claude?.target).toBe(join(workspace, ".claude", "settings.json"));
    expect(claude?.targets).toEqual([join(workspace, ".claude", "settings.json")]);
    expect(claude?.detail).toContain("settings.local.json");
  });

  it("codex y warp reportan targets con su único archivo", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    const result = await runVisibilityDoctor(fs, env, paths, { workspace });
    const codex = result.reports.find((r) => r.host === "codex");
    const warp = result.reports.find((r) => r.host === "warp");
    expect(codex?.targets).toEqual([join(workspace, ".codex", "config.toml")]);
    expect(warp?.targets).toEqual([warp?.target]);
  });

  // Residual 2: the same path in both files is ONE registration, not two.
  it("registered_paths no duplica una ruta declarada en settings.json Y en el .local", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    writeClaudeSettings(workspace, "settings.json", ["/tmp/a", "/tmp/b"]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/b", "/tmp/a"]);
    const claude = claudeOf(await runVisibilityDoctor(fs, env, paths, { workspace }));
    // Orden de primera aparición, sin repetidos.
    expect(claude?.registered_paths).toEqual(["/tmp/a", "/tmp/b"]);
    expect(claude?.status).toBe("ok");
  });

  it("la deduplicación no cambia missing ni extra", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    writeClaudeSettings(workspace, "settings.json", ["/tmp/a", "/tmp/extra"]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/extra"]);
    const claude = claudeOf(await runVisibilityDoctor(fs, env, paths, { workspace }));
    expect(claude?.status).toBe("extra-paths");
    expect(claude?.extra).toEqual(["/tmp/extra"]);
    expect(claude?.missing).toEqual([]);
  });

  it("global=true reporta global-pollution si ~/.claude tiene fuentes del hub", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a-test-pollution" },
      { alias: "b", path: "/tmp/b-test-pollution" },
    ]);
    // El home sale del EnvPort inyectado, así que el scope global es observable
    // sin parchear node:os.
    const homeStub = mkdtempSync(join(tmpdir(), "vis-doctor-home-"));
    mkdirSync(join(homeStub, ".claude"), { recursive: true });
    writeFileSync(
      join(homeStub, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { additionalDirectories: ["/tmp/a-test-pollution", "/tmp/ajeno"] },
      }),
    );
    const globalEnv = new FakeEnv(homeStub, workspace);

    const result = await runVisibilityDoctor(fs, globalEnv, paths, { workspace, global: true });

    expect(result.global_reports).toHaveLength(2);
    const claudeGlobal = result.global_reports.find((r) => r.host === "claude");
    expect(claudeGlobal?.status).toBe("global-pollution");
    // Sólo las fuentes del hub son contaminación; lo ajeno del home no se toca.
    expect(claudeGlobal?.extra).toEqual(["/tmp/a-test-pollution"]);
    expect(claudeGlobal?.targets).toEqual([join(homeStub, ".claude", "settings.local.json")]);
    expect(result.summary.global_pollution).toBe(1);
    rmSync(homeStub, { recursive: true, force: true });
  });

  it("global sin ningún settings de claude apunta al settings.json a crear", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    const homeStub = mkdtempSync(join(tmpdir(), "vis-doctor-home-"));
    const result = await runVisibilityDoctor(fs, new FakeEnv(homeStub, workspace), paths, {
      workspace,
      global: true,
    });
    const claudeGlobal = result.global_reports.find((r) => r.host === "claude");
    expect(claudeGlobal?.status).toBe("ok");
    expect(claudeGlobal?.registered_paths).toEqual([]);
    expect(claudeGlobal?.targets).toEqual([join(homeStub, ".claude", "settings.json")]);
    rmSync(homeStub, { recursive: true, force: true });
  });
});

// Residual 3: `aw visibility doctor --format human` printed the same JSON as
// `--json` because the command declared no human projection at all.
describe("aw visibility doctor — proyección humana", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "vis-render-"));
    env = new FakeEnv(workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  async function render(detail = false): Promise<string> {
    const data = await runVisibilityDoctor(fs, env, paths, { workspace });
    return visibilityCommand.renderHuman?.({ ok: true, data, exitCode: 0 }, { detail }) ?? "";
  }

  it("no es JSON: una línea por host con estado y archivo real", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/a"]);
    const text = await render();
    expect(text.startsWith("{")).toBe(false);
    expect(text).toContain("claude");
    expect(text).toContain("codex");
    expect(text).toContain("warp");
    // El target impreso es el archivo del que salieron las rutas, no settings.json.
    expect(text).toContain(join(workspace, ".claude", "settings.local.json"));
    expect(text).not.toContain(join(workspace, ".claude", "settings.json"));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("imprime los dos archivos cuando el doctor leyó los dos", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    writeClaudeSettings(workspace, "settings.json", ["/tmp/a"]);
    writeClaudeSettings(workspace, "settings.local.json", []);
    const text = await render();
    expect(text).toContain(
      `${join(workspace, ".claude", "settings.json")} + ${join(workspace, ".claude", "settings.local.json")}`,
    );
  });

  it("lista faltantes y sobrantes, y ofrece el comando que corresponde", async () => {
    writeProjectBlock(workspace, [
      { alias: "a", path: "/tmp/a" },
      { alias: "b", path: "/tmp/b" },
    ]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/a", "/tmp/sobra"]);
    const text = await render();
    expect(text).toContain("faltan: /tmp/b");
    expect(text).toContain("sobran: /tmp/sobra");
    expect(text).toContain("missing-paths");
    // `status` se queda con el drift más grave; los DOS comandos igual se ofrecen.
    expect(text).toContain("aw attach-multiroot --from-sources");
    expect(text).toContain("aw detach-multiroot --path <dir>");
  });

  it("sin drift no propone ningún comando de corrección", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/a"]);
    mkdirSync(join(workspace, ".codex"), { recursive: true });
    writeFileSync(
      join(workspace, ".codex", "config.toml"),
      "additional_writable_roots = ['/tmp/a']\n",
    );
    const text = await render();
    expect(text).toContain("3/3 host(s) sin drift");
    expect(text).not.toContain("Para corregir:");
  });

  it("--detail agrega declarados/registrados sin cambiar el veredicto", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    writeClaudeSettings(workspace, "settings.local.json", ["/tmp/a"]);
    const brief = await render(false);
    const wide = await render(true);
    expect(brief).not.toContain("declarados:");
    expect(wide).toContain("declarados: /tmp/a");
    expect(wide).toContain("registrados: /tmp/a");
  });

  it("con drift el reporte viaja en action: ok:false sólo renderiza el error", async () => {
    writeProjectBlock(workspace, [{ alias: "a", path: "/tmp/a" }]);
    const ctx = { fs, env, paths } as unknown as CliContext;
    const result = await visibilityCommand.execute(parseArgv(["visibility", "doctor"]), ctx);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const action = (result.data as unknown as { action?: string }).action ?? "";
    expect(action).toContain("no-settings");
    expect(action).toContain("aw attach-multiroot --from-sources");
    // El modelo JSON sigue completo: `action` se suma, no reemplaza.
    expect(result.data?.reports).toHaveLength(3);
  });
});
