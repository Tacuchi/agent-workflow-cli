// crush y agy: la plantilla única llevada a sus dos dialectos JSON, y la
// propiedad de lo que se escribe.
//
// Lo que estos casos defienden no es que el archivo se escriba, sino que se
// escriba SIN pisar lo del usuario y que lo que no viaja se DIGA. Un matcher de
// Claude copiado tal cual a crush instala un hook que no dispara nunca, y ese
// es el modo de fallo silencioso que el transform tiene que hacer ruidoso.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crushGlobalMcpFile } from "../../src/application/mcp-host-paths.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  AGY_HOOK_NAME,
  countOurAgyHooks,
  countOurCrushHooks,
  hooksTemplateToAgy,
  hooksTemplateToCrush,
  stripOurAgyHooks,
  stripOurCrushHooks,
} from "../../src/application/self/hooks-json.js";
import { reportHooksArmed } from "../../src/application/self/host-states.js";
import { type HooksTemplate, selfInstallHooks } from "../../src/application/self/install-hooks.js";
import { selfUninstall } from "../../src/application/self/uninstall.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

const TEMPLATE: HooksTemplate = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear",
        hooks: [{ type: "command", command: "agent-workflow self namespace --pin workflow" }],
      },
    ],
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: "agent-workflow hook branch-check", timeout: 15 }],
      },
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "agent-workflow hook git-commit-advisor", timeout: 10 },
        ],
      },
    ],
    PostCompact: [{ matcher: "", hooks: [{ type: "prompt", prompt: "resumí el estado" }] }],
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("dialecto de crush", () => {
  it("sólo viaja PreToolUse, y los demás eventos se saltan con su razón", () => {
    const { emitted, skipped } = hooksTemplateToCrush(TEMPLATE);
    expect(Object.keys(emitted)).toEqual(["PreToolUse"]);
    expect(skipped.map((s) => s.event).sort()).toEqual(["PostCompact", "SessionStart"]);
    for (const skip of skipped) expect(skip.reason.length).toBeGreaterThan(0);
  });

  it("los matchers se traducen a los nombres de tool de crush, no se copian", () => {
    const { emitted } = hooksTemplateToCrush(TEMPLATE);
    expect(emitted.PreToolUse).toEqual([
      {
        matcher: "^(edit|write|multiedit)$",
        command: "agent-workflow hook branch-check",
        timeout: 15,
      },
      { matcher: "^bash$", command: "agent-workflow hook git-commit-advisor", timeout: 10 },
    ]);
  });

  it("un matcher sin equivalente NO se copia: se salta el hook y se dice", () => {
    const { emitted, skipped } = hooksTemplateToCrush({
      hooks: {
        PreToolUse: [
          {
            matcher: "SomeToolNobodyMapped",
            hooks: [{ type: "command", command: "agent-workflow hook x" }],
          },
        ],
      },
    });
    expect(emitted).toEqual({});
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("never fires");
  });
});

describe("dialecto de agy", () => {
  it("emite UN hook con nombre, agrupado como el de Claude y con los tools de agy", () => {
    const { emitted, skipped } = hooksTemplateToAgy(TEMPLATE);
    expect(emitted).toEqual({
      PreToolUse: [
        {
          matcher: "^(file_change|edit_notebook)$",
          hooks: [{ type: "command", command: "agent-workflow hook branch-check", timeout: 15 }],
        },
        {
          matcher: "^run_command$",
          hooks: [
            { type: "command", command: "agent-workflow hook git-commit-advisor", timeout: 10 },
          ],
        },
      ],
    });
    expect(skipped.map((s) => s.event).sort()).toEqual(["PostCompact", "SessionStart"]);
  });
});

describe("instalación y retirada sobre HOME temporal", () => {
  let home: string;
  let templatePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hooks-json-"));
    templatePath = join(home, "hooks.template.json");
    await writeFile(templatePath, JSON.stringify(TEMPLATE), "utf8");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("crush: el resto de crush.json sobrevive y el hook del usuario se conserva", async () => {
    const configPath = crushGlobalMcpFile(home);
    const mine = { command: "./hooks/mine.sh", matcher: "^bash$" };
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ models: { large: "gpt" }, mcp: { db: {} }, hooks: { PreToolUse: [mine] } }),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "crush", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.config_path).toBe(configPath);
      expect(result.data.warning).toContain("SessionStart");
    }

    const written = await readJson(configPath);
    expect(written.models).toEqual({ large: "gpt" });
    expect(written.mcp).toEqual({ db: {} });
    const entries = (written.hooks as Record<string, unknown[]>).PreToolUse;
    expect(entries[0]).toEqual(mine);
    expect(countOurCrushHooks(written)).toBe(2);
  });

  it("crush: reinstalar no duplica — la segunda pasada es noop", async () => {
    const ctx = buildCtx(home);
    await selfInstallHooks(buildArgs({ target: "crush", template: templatePath }), ctx);
    const second = await selfInstallHooks(
      buildArgs({ target: "crush", template: templatePath }),
      ctx,
    );
    expect(second.ok).toBe(true);
    if (second.ok && second.data) expect(second.data.status).toBe("noop");
    expect(countOurCrushHooks(await readJson(crushGlobalMcpFile(home)))).toBe(2);
  });

  it("agy: escribe su hook con nombre y declara que la raíz global no está verificada", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "gemini", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.warning).toContain("NOT verified");
    }
    const written = await readJson(join(home, ".agents", "hooks.json"));
    expect(Object.keys(written)).toEqual([AGY_HOOK_NAME]);
    expect(countOurAgyHooks(written)).toBe(2);
  });

  it("agy: un hook ajeno con otro nombre sigue ahí después de instalar y de desinstalar", async () => {
    const path = join(home, ".agents", "hooks.json");
    await mkdir(dirname(path), { recursive: true });
    const theirs = { PreToolUse: [{ matcher: "", hooks: [{ command: "./lint.sh" }] }] };
    await writeFile(path, JSON.stringify({ "lint-checker": theirs }), "utf8");

    const ctx = buildCtx(home);
    await selfInstallHooks(buildArgs({ target: "gemini", template: templatePath }), ctx);
    expect((await readJson(path))["lint-checker"]).toEqual(theirs);

    await selfUninstall(buildArgs({ target: "gemini" }, ["--with-hooks"]), ctx);
    const after = await readJson(path);
    expect(after["lint-checker"]).toEqual(theirs);
    expect(after[AGY_HOOK_NAME]).toBeUndefined();
  });

  it("la sonda de armados sigue el archivo real: encendida tras instalar, apagada tras retirar", async () => {
    const ctx = buildCtx(home);
    await selfInstallHooks(buildArgs({ target: "crush", template: templatePath }), ctx);
    const armed = await reportHooksArmed(ctx);
    expect(armed.find((h) => h.target === "crush")?.armed).toBe(true);
    expect(armed.find((h) => h.target === "gemini")?.armed).toBe(false);

    await selfUninstall(buildArgs({ target: "crush" }, ["--with-hooks"]), ctx);
    const after = await reportHooksArmed(ctx);
    expect(after.find((h) => h.target === "crush")?.armed).toBe(false);
  });
});

describe("propiedad: lo ajeno no se toca", () => {
  it("crush: se van sólo nuestras entradas y el evento vacío desaparece", () => {
    const mine = { command: "./mine.sh" };
    const swept = stripOurCrushHooks({
      models: {},
      hooks: {
        PreToolUse: [mine, { command: "agent-workflow hook branch-check" }],
        PostToolUse: [{ command: "agent-workflow hook x" }],
      },
    });
    expect(swept.removed).toBe(2);
    expect(swept.preserved).toBe(1);
    expect(swept.value).toEqual({ models: {}, hooks: { PreToolUse: [mine] } });
  });

  it("agy: un hook que se llama como el nuestro pero NO es nuestro se conserva", () => {
    const impostor = {
      [AGY_HOOK_NAME]: {
        PreToolUse: [{ matcher: "", hooks: [{ command: "agent-workflow-lookalike run" }] }],
      },
    };
    const swept = stripOurAgyHooks(impostor);
    expect(swept.removed).toBe(0);
    expect(swept.value).toEqual(impostor);
  });
});
