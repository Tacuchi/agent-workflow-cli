import { describe, expect, it } from "vitest";
import { type HubInitPrompts, collectHubInitInteractive } from "../../src/cli/commands/hub-init.js";
import type { EnvPort } from "../../src/ports/env.js";

class FakeEnv implements EnvPort {
  constructor(private readonly root: string) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this.root;
  }
  cwd() {
    return this.root;
  }
}

interface PromptCall {
  type: "input" | "confirm";
  message: string;
  default?: string | boolean;
}

/**
 * Prompts scripteados: `inputs`/`confirms` se consumen en orden. Si la cola se
 * agota, devuelve el `default` del prompt (simula al usuario aceptando con ⏎,
 * que es exactamente lo que inquirer retorna). Registra cada llamada.
 */
function scriptedPrompts(script: {
  inputs?: string[];
  confirms?: boolean[];
}): HubInitPrompts & { calls: PromptCall[] } {
  const inputQ = [...(script.inputs ?? [])];
  const confirmQ = [...(script.confirms ?? [])];
  const calls: PromptCall[] = [];
  return {
    calls,
    async input(opts) {
      calls.push({ type: "input", message: opts.message, default: opts.default });
      const next = inputQ.shift();
      return next ?? opts.default ?? "";
    },
    async confirm(opts) {
      calls.push({ type: "confirm", message: opts.message, default: opts.default });
      const next = confirmQ.shift();
      return next ?? opts.default ?? false;
    },
  };
}

describe("collectHubInitInteractive", () => {
  it("infiere el alias del basename del path y recolecta ≥2 fuentes", async () => {
    const prompts = scriptedPrompts({
      inputs: [
        "mi-hub",
        "/Users/me/Git/agent-workflow-cli",
        "/Users/me/Git/qtc-workflow-plugin",
        "certificacion",
      ],
      confirms: [false],
    });

    const result = await collectHubInitInteractive(prompts, new FakeEnv("/tmp/ws"));

    expect(result.proyecto).toBe("mi-hub");
    expect(result.fuentes).toEqual([
      { alias: "agent-workflow-cli", path: "/Users/me/Git/agent-workflow-cli" },
      { alias: "qtc-workflow-plugin", path: "/Users/me/Git/qtc-workflow-plugin" },
    ]);
    expect(result.mainBranch).toBe("certificacion");
  });

  it("ofrece defaults: proyecto = basename(cwd) y rama = certificacion", async () => {
    // El usuario acepta los defaults con ⏎ → inquirer retorna el propio default.
    const prompts = scriptedPrompts({
      inputs: ["mi-workspace", "/a/repo-uno", "/b/repo-dos", "certificacion"],
      confirms: [false],
    });

    const result = await collectHubInitInteractive(prompts, new FakeEnv("/home/dev/mi-workspace"));

    expect(prompts.calls[0]).toMatchObject({ type: "input", default: "mi-workspace" });
    expect(prompts.calls.at(-1)).toMatchObject({ type: "input", default: "certificacion" });
    expect(result.proyecto).toBe("mi-workspace");
    expect(result.mainBranch).toBe("certificacion");
  });

  it("acepta más de 2 fuentes mientras el usuario confirme", async () => {
    const prompts = scriptedPrompts({
      inputs: ["hub", "/a/uno", "/b/dos", "/c/tres", "main"],
      confirms: [true, false],
    });

    const result = await collectHubInitInteractive(prompts, new FakeEnv("/tmp/ws"));

    expect(result.fuentes.map((f) => f.alias)).toEqual(["uno", "dos", "tres"]);
    expect(result.mainBranch).toBe("main");
  });

  it("no pregunta '¿agregar otra?' antes de tener 2 fuentes", async () => {
    const prompts = scriptedPrompts({
      inputs: ["hub", "/a/uno", "/b/dos", "certificacion"],
      confirms: [false],
    });

    await collectHubInitInteractive(prompts, new FakeEnv("/tmp/ws"));

    // Un solo confirm, disparado recién tras la 2da fuente.
    expect(prompts.calls.filter((c) => c.type === "confirm")).toHaveLength(1);
  });

  it("desambigua aliases duplicados cuando dos paths comparten carpeta", async () => {
    const prompts = scriptedPrompts({
      inputs: ["hub", "/repos-a/core", "/repos-b/core", "certificacion"],
      confirms: [false],
    });

    const result = await collectHubInitInteractive(prompts, new FakeEnv("/tmp/ws"));

    expect(result.fuentes.map((f) => f.alias)).toEqual(["core", "core-2"]);
  });

  it("ignora barras finales al inferir el alias", async () => {
    const prompts = scriptedPrompts({
      inputs: ["hub", "/a/cli/", "/b/plugin/", "certificacion"],
      confirms: [false],
    });

    const result = await collectHubInitInteractive(prompts, new FakeEnv("/tmp/ws"));

    expect(result.fuentes.map((f) => f.alias)).toEqual(["cli", "plugin"]);
  });
});
