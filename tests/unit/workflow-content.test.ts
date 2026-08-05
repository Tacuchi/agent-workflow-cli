// La TUI lleva la lista de hooks escrita a mano. Este guard la ata a la plantilla
// real del bundle: una copia sin verificar es una copia que va a divergir, y el
// panel diría que el bundle arma un evento que la plantilla ya no declara (o al
// revés). Es el mismo motivo por el que los guards de catálogo existen.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveBundledHookTemplate } from "../../src/application/self/install-hooks.js";
import { WORKFLOW_CONTENT } from "../../src/cli/tui/data/workflow-content.js";

describe("workflow-content — la lista de hooks de la TUI no puede divergir de la plantilla", () => {
  it("nombra exactamente los eventos que declara hooks.template.json, en su orden", async () => {
    const path = await resolveBundledHookTemplate();
    expect(path, "la plantilla del bundle tiene que resolverse").not.toBeNull();
    const template = JSON.parse(await readFile(path as string, "utf8")) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string }[] }[]>;
    };
    expect(WORKFLOW_CONTENT.hooks.map((h) => h.name)).toEqual(Object.keys(template.hooks));
  });

  it("cada entrada dice su matcher y qué dispara: una fila sin eso no informa nada", () => {
    for (const hook of WORKFLOW_CONTENT.hooks) {
      expect(hook.matcher.length, hook.name).toBeGreaterThan(0);
      expect(hook.fires.length, hook.name).toBeGreaterThan(0);
    }
  });

  it("los comandos que anuncia son los del bundle, con el prefijo /w:", () => {
    expect(WORKFLOW_CONTENT.slashCommands.length).toBeGreaterThan(0);
    for (const command of WORKFLOW_CONTENT.slashCommands) {
      expect(command, command).toMatch(/^\/w:/);
    }
  });
});
