// El plugin de opencode: una clase de artefacto nueva —código, no configuración—
// y por eso los casos miran DOS cosas que ninguna otra fase mira: que el módulo
// generado hable el protocolo que nuestros hooks entienden, y que retirarlo no
// se lleve por delante un plugin ajeno.
//
// Ningún caso abre un runtime: lo que se verifica son bytes generados.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeGlobalMcpFile } from "../../src/application/mcp-host-paths.js";
import { PathsService } from "../../src/application/paths-service.js";
import { isOurCommand } from "../../src/application/self/hooks-dialect.js";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { type HooksTemplate, selfInstallHooks } from "../../src/application/self/install-hooks.js";
import {
  OPENCODE_PLUGIN_FILE,
  buildOpencodePlugin,
  declareOpencodePlugin,
  isOurOpencodePlugin,
  undeclareOpencodePlugin,
} from "../../src/application/self/opencode-plugin.js";
import { selfUninstall } from "../../src/application/self/uninstall.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

const TEMPLATE: HooksTemplate = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [{ type: "command", command: "agent-workflow self namespace" }],
      },
    ],
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: "agent-workflow hook branch-check", timeout: 15 }],
      },
      {
        matcher: "mcp__.*__execute_sql",
        hooks: [
          { type: "command", command: "agent-workflow hook sql-mutation-guard", timeout: 10 },
        ],
      },
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "agent-workflow hook git-commit-advisor", timeout: 10 },
        ],
      },
    ],
    PreCompact: [
      { matcher: "", hooks: [{ type: "command", command: "agent-workflow checkpoint-write" }] },
    ],
  },
};

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: [],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new NoScanFs(),
    env: new FakeEnv(home),
    process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("generación del plugin", () => {
  it("lleva los guards de tool y declara con su razón todo lo que no viaja", () => {
    const plugin = buildOpencodePlugin(TEMPLATE);
    expect(plugin.carried).toEqual([
      "agent-workflow hook branch-check",
      "agent-workflow hook git-commit-advisor",
    ]);
    expect(plugin.skipped.map((s) => s.event).sort()).toEqual([
      "PreCompact",
      "PreToolUse",
      "SessionStart",
    ]);
    // El guard de SQL cae por su matcher, no por su evento: y lo dice.
    const sql = plugin.skipped.find((s) => s.event === "PreToolUse");
    expect(sql?.reason).toContain("mcp__");
    expect(sql?.reason).toContain("never guard");
  });

  it("el módulo traduce el tool de opencode al nombre que el hook entiende", () => {
    const { source } = buildOpencodePlugin(TEMPLATE);
    // Sin este puente el hook recibe `edit` y contesta «no es mi tool»: corre y
    // no guarda nada. Es el modo de fallo que esta fase existe para evitar.
    expect(source).toContain(
      '"edit": {\n    "as": "Edit",\n    "from": "filePath",\n    "into": "file_path"',
    );
    expect(source).toContain(
      '"bash": {\n    "as": "Bash",\n    "from": "command",\n    "into": "command"',
    );
    expect(source).toContain("tool.execute.before");
    expect(source).toContain("code === 2");
  });

  it("el encabezado del módulo dice qué omite, así nadie supone paridad", () => {
    const { source } = buildOpencodePlugin(TEMPLATE);
    expect(source).toContain("Omitted, with its reason");
    expect(source).toContain("SessionStart");
    expect(source).toContain("PreCompact");
  });

  it("todo comando generado es nuestro: el plugin no ejecuta binarios ajenos", () => {
    expect(buildOpencodePlugin(TEMPLATE).carried.every(isOurCommand)).toBe(true);
  });
});

describe("declaración en opencode.json", () => {
  it("se agrega una vez y no se duplica al reinstalar", () => {
    const once = declareOpencodePlugin({ model: "x" }, "/p/agent-workflow.js");
    expect(once).toEqual({ model: "x", plugin: ["/p/agent-workflow.js"] });
    expect(declareOpencodePlugin(once, "/p/agent-workflow.js")).toBe(once);
  });

  it("al retirarla, los plugins ajenos siguen declarados", () => {
    const config = { plugin: ["some-npm-plugin", "/p/agent-workflow.js"] };
    const { value, removed } = undeclareOpencodePlugin(config, "/p/agent-workflow.js");
    expect(removed).toBe(true);
    expect(value).toEqual({ plugin: ["some-npm-plugin"] });
  });
});

describe("instalación y retirada sobre HOME temporal", () => {
  let home: string;
  let templatePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencode-plugin-"));
    templatePath = join(home, "hooks.template.json");
    await writeFile(templatePath, JSON.stringify(TEMPLATE), "utf8");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function pluginPath(): string {
    return join(dirname(opencodeGlobalMcpFile(home)), "plugin", OPENCODE_PLUGIN_FILE);
  }

  it("escribe el módulo, lo declara y conserva el resto de opencode.json", async () => {
    const configPath = opencodeGlobalMcpFile(home);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ model: "anthropic/x", plugin: ["theirs"] }),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "opencode", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.warning).toContain("SessionStart");
    }
    expect(isOurOpencodePlugin(await readFile(pluginPath(), "utf8"))).toBe(true);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.model).toBe("anthropic/x");
    expect(config.plugin).toEqual(["theirs", pluginPath()]);
  });

  it("reinstalar es noop y desinstalar deja el plugin ajeno declarado", async () => {
    const ctx = buildCtx(home);
    await selfInstallHooks(buildArgs({ target: "opencode", template: templatePath }), ctx);
    const again = await selfInstallHooks(
      buildArgs({ target: "opencode", template: templatePath }),
      ctx,
    );
    if (again.ok && again.data) expect(again.data.status).toBe("noop");

    const configPath = opencodeGlobalMcpFile(home);
    const before = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify({ ...before, plugin: ["theirs", ...before.plugin] }),
      "utf8",
    );

    await selfUninstall(buildArgs({ target: "opencode" }, ["--with-hooks"]), ctx);
    await expect(stat(pluginPath())).rejects.toThrow();
    expect(JSON.parse(await readFile(configPath, "utf8")).plugin).toEqual(["theirs"]);
  });

  it("un módulo ajeno con nuestro nombre de archivo NO se borra", async () => {
    const path = pluginPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      "// alguien más escribió esto\nexport default async () => ({})\n",
      "utf8",
    );

    await selfUninstall(buildArgs({ target: "opencode" }, ["--with-hooks"]), buildCtx(home));
    expect(await readFile(path, "utf8")).toContain("alguien más");
  });
});

describe("proyección de estado", () => {
  it("opencode nombra su plugin generado y que la resumabilidad no viaja", () => {
    const opencode = HARNESSES.find((h) => h.id === "opencode");
    if (opencode === undefined) throw new Error("opencode debe estar en el catálogo");
    const hooks = capabilitiesFor(opencode).find((c) => c.id === "hooks");
    expect(hooks?.status).toBe("degraded");
    expect(hooks?.detail).toContain("plugin module");
    expect(hooks?.detail).toContain("omits SessionStart");
  });
});
