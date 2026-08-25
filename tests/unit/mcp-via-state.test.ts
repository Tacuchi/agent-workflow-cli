import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { offerWorklineServer } from "../../src/application/self/mcp-offer.js";
import { readMcpViaState } from "../../src/application/self/mcp-via-state.js";
import { type HarnessId, harnessById } from "../../src/domain/harnesses.js";

function specOf(id: HarnessId) {
  const spec = harnessById(id);
  if (spec === null) throw new Error(`host ausente: ${id}`);
  return spec;
}

/**
 * Las tres preguntas por separado, porque no son la misma.
 *
 * Una vía puede estar disponible sin estar ofrecida, y ofrecida sin ser utilizable.
 * Colapsarlas dejaría a la persona sin saber cuál de las tres arreglar.
 */
describe("el estado de la vía MCP en un host", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "via-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("disponible pero NO ofrecida, con la acción que lo resuelve", () => {
    const state = readMcpViaState(specOf("codex"), home);

    expect(state.available.yes).toBe(true);
    expect(state.available.reason).toContain("2026-08-22");
    expect(state.offered.yes).toBe(false);
    expect(state.offered.reason).toContain("instalación de superficies");
    expect(state.usable.yes).toBe(false);
  });

  it("una vez ofrecida, las tres contestan y la tercera nombra lo único que puede desmentirla", () => {
    offerWorklineServer({ targets: ["codex"], scopeDir: home });

    const state = readMcpViaState(specOf("codex"), home);

    expect(state.available.yes).toBe(true);
    expect(state.offered.yes).toBe(true);
    // Utilizable es lo único que no se puede afirmar leyendo: lo decide la política
    // de arranque, y eso sólo se sabe al pedir la primera elección.
    expect(state.usable.yes).toBe(true);
    expect(state.usable.reason).toContain("--yolo");
    expect(state.usable.reason).toContain("default approval policy");
  });

  it("un host sin evidencia se declara NO disponible, nunca desconocido", () => {
    const state = readMcpViaState(specOf("kimi"), home);

    // Que nadie la haya observado acá no es lo mismo que haberla observado y que
    // falle; decir «desconocido» invitaría a suponer la que no se probó.
    expect(state.available.yes).toBe(false);
    expect(state.available.reason).toContain("nadie observó");
    expect(state.usable.yes).toBe(false);
  });

  it("toda respuesta negativa trae su razón, sin excepción", () => {
    writeFileSync(join(home, ".codex", "config.toml"), "");
    for (const id of ["codex", "kimi", "warp", "claude-code"] as const) {
      const state = readMcpViaState(specOf(id), home);
      for (const answer of [state.available, state.offered, state.usable]) {
        expect(answer.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
