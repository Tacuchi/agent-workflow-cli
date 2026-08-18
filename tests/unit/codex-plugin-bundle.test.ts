// La vía de plugin de Codex: lo que el checkout SÍ puede producir, y la frontera
// que no cruza.
//
// El descriptor y sus fixtures son el contrato; que un codex instalado cargue el
// plugin es una observación de operador. Por eso todos los casos de acá miran
// bytes generados y ninguno abre un runtime.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  CODEX_PLUGIN_DIR,
  CODEX_PLUGIN_NAME,
  buildCodexPluginBundle,
  isOurCodexPlugin,
} from "../../src/application/self/codex-plugin.js";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { type HooksTemplate, selfInstallHooks } from "../../src/application/self/install-hooks.js";
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
        matcher: "Bash",
        hooks: [
          { type: "command", command: "agent-workflow hook git-commit-advisor", timeout: 10 },
        ],
      },
    ],
    PostCompact: [{ matcher: "", hooks: [{ type: "prompt", prompt: "reanudá" }] }],
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

describe("descriptor del plugin de Codex", () => {
  it("declara los campos que el validador de codex exige, y su hooks.json", () => {
    const { files } = buildCodexPluginBundle(TEMPLATE, "22.2.0");
    const descriptor = JSON.parse(files[".codex-plugin/plugin.json"] as string);
    expect(descriptor.name).toBe(CODEX_PLUGIN_NAME);
    expect(descriptor.version).toBe("22.2.0");
    expect(descriptor.hooks).toBe("./hooks.json");
    for (const field of ["description", "author"]) {
      expect(descriptor[field], field).toBeTruthy();
    }
    for (const key of [
      "displayName",
      "shortDescription",
      "longDescription",
      "developerName",
      "category",
      "capabilities",
      "defaultPrompt",
    ]) {
      expect(descriptor.interface[key], key).toBeDefined();
    }
  });

  it("una versión ilegible se degrada a semver estricto, no rompe el plugin", () => {
    const { files } = buildCodexPluginBundle(TEMPLATE, "unknown");
    expect(JSON.parse(files[".codex-plugin/plugin.json"] as string).version).toBe("0.0.0");
  });

  it("los cinco eventos viajan verbatim: codex es el host que no pierde nada", () => {
    const { files } = buildCodexPluginBundle(TEMPLATE, "1.0.0");
    expect(JSON.parse(files["hooks.json"] as string)).toEqual(TEMPLATE);
  });

  it("ningún byte emitido menciona un trusted_hash", () => {
    const { files } = buildCodexPluginBundle(TEMPLATE, "1.0.0");
    expect(Object.values(files).join("\n")).not.toContain("trusted_hash");
  });
});

describe("generación y retirada sobre HOME temporal", () => {
  let home: string;
  let templatePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "codex-plugin-"));
    templatePath = join(home, "hooks.template.json");
    await writeFile(templatePath, JSON.stringify(TEMPLATE), "utf8");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("escribe el bundle y dice que NO está armado, con los comandos que faltan", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "codex", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("generated");
      expect(result.data.warning).toContain("NOT armed");
      expect(result.data.warning).toContain("codex plugin install");
    }
    const root = join(home, ...CODEX_PLUGIN_DIR);
    expect(
      JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8")).name,
    ).toBe(CODEX_PLUGIN_NAME);
    expect(JSON.parse(await readFile(join(root, "hooks.json"), "utf8"))).toEqual(TEMPLATE);
  });

  it("--dry-run no escribe nada", async () => {
    await selfInstallHooks(
      buildArgs({ target: "codex", template: templatePath }, ["--dry-run"]),
      buildCtx(home),
    );
    await expect(stat(join(home, ...CODEX_PLUGIN_DIR))).rejects.toThrow();
  });

  it("desinstalar retira el bundle que generamos", async () => {
    const ctx = buildCtx(home);
    await selfInstallHooks(buildArgs({ target: "codex", template: templatePath }), ctx);
    await selfUninstall(buildArgs({ target: "codex" }, ["--with-hooks"]), ctx);
    await expect(stat(join(home, ...CODEX_PLUGIN_DIR))).rejects.toThrow();
  });

  it("un bundle ajeno en esa ruta NO se borra: la propiedad es del descriptor", async () => {
    const root = join(home, ...CODEX_PLUGIN_DIR);
    const descriptor = join(root, ".codex-plugin", "plugin.json");
    await mkdir(dirname(descriptor), { recursive: true });
    await writeFile(descriptor, JSON.stringify({ name: "someone-else" }), "utf8");

    const result = await selfUninstall(
      buildArgs({ target: "codex" }, ["--with-hooks"]),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(await readFile(descriptor, "utf8")).name).toBe("someone-else");
    expect(isOurCodexPlugin(await readFile(descriptor, "utf8"))).toBe(false);
  });
});

describe("proyección de estado", () => {
  it("codex se proyecta como degradado y nombra el bundle generado, nunca armado", () => {
    const codex = HARNESSES.find((h) => h.id === "codex");
    if (codex === undefined) throw new Error("codex debe estar en el catálogo");
    const hooks = capabilitiesFor(codex).find((c) => c.id === "hooks");
    expect(hooks?.status).toBe("degraded");
    expect(hooks?.detail).toContain("plugin bundle");
    expect(hooks?.detail).toContain("NOT armed");
    // Nombrar `trusted_hash` acá es correcto —es la RAZÓN por la que no se
    // administra—; lo prohibido es afirmar que quedó instalado.
    expect(hooks?.detail).not.toContain("installed into");
  });
});
