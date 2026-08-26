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
 * Disponibilidad y oferta van por separado, porque no son lo mismo.
 *
 * Una vía puede estar disponible sin estar ofrecida. La aceptación del selector
 * no se adivina desde el filesystem.
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
  });

  it("una vez ofrecida, disponibilidad y oferta contestan sin estado especulativo", () => {
    offerWorklineServer({ targets: ["codex"], scopeDir: home });

    const state = readMcpViaState(specOf("codex"), home);

    expect(state.available.yes).toBe(true);
    expect(state.offered.yes).toBe(true);
    expect("usable" in state).toBe(false);
  });

  it("una entrada homónima ajena se reporta como conflicto y nunca como ofrecida", () => {
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[mcp_servers.agent-workflow]\ncommand = "node"\nargs = ["foreign.js"]\n',
      "utf8",
    );

    const state = readMcpViaState(specOf("codex"), home);

    expect(state.available.yes).toBe(true);
    expect(state.offered).toMatchObject({ yes: false });
    expect(state.offered.reason).toContain("conflicto");
    expect(state.offered.reason).toContain("ajena");
  });

  it("también conserva el conflicto cuando la forma homónima ni siquiera es un record", () => {
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'mcp_servers.agent-workflow = "foreign"\n',
      "utf8",
    );

    const state = readMcpViaState(specOf("codex"), home);

    expect(state.offered).toMatchObject({ yes: false });
    expect(state.offered.reason).toContain("conflicto");
  });

  it("un host sin evidencia se declara NO disponible, nunca desconocido", () => {
    const state = readMcpViaState(specOf("kimi"), home);

    // Que nadie la haya observado acá no es lo mismo que haberla observado y que
    // falle; decir «desconocido» invitaría a suponer la que no se probó.
    expect(state.available.yes).toBe(false);
    expect(state.available.reason).toContain("nadie observó");
  });

  it("toda respuesta negativa trae su razón, sin excepción", () => {
    writeFileSync(join(home, ".codex", "config.toml"), "");
    for (const id of ["codex", "kimi", "warp", "claude-code"] as const) {
      const state = readMcpViaState(specOf(id), home);
      for (const answer of [state.available, state.offered]) {
        expect(answer.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
