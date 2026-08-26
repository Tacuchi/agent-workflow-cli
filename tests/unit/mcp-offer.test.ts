import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKLINE_MCP_ENTRY_NAME,
  offerWorklineServer,
  withdrawWorklineServer,
} from "../../src/application/self/mcp-offer.js";
import { worklineMcpEntry } from "../../src/domain/workline-mcp-entry.js";

/**
 * Instalar deja el servidor ofrecido; retirar lo quita; y lo que la persona ya
 * tenía configurado sobrevive a las dos cosas byte a byte.
 *
 * Esa última mitad es la que importa: ofrecer un servidor toca la configuración
 * del host de alguien, y una escritura que se lleve por delante un servidor ajeno
 * rompe herramientas que nada tienen que ver con Workline.
 */
describe("ofrecer y retirar el servidor propio", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "offer-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function codexToml(): string {
    const p = join(home, ".codex", "config.toml");
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return "";
    }
  }

  it("deja la entrada propia donde el catálogo declara la vía", () => {
    const outcomes = offerWorklineServer({ targets: ["codex"], scopeDir: home });

    expect(outcomes).toEqual([{ host: "codex", state: "offered" }]);
    expect(codexToml()).toContain(WORKLINE_MCP_ENTRY_NAME);
    expect(codexToml()).toContain("serve");
  });

  it("NO la deja en un host donde nadie observó la vía", () => {
    // Escribirla donde nadie la observó dejaría una entrada apuntando a un
    // selector que quizá no existe, y el estampado de ese host tampoco la nombra:
    // serían dos superficies diciendo cosas distintas.
    const outcomes = offerWorklineServer({ targets: ["claude", "kimi"], scopeDir: home });

    expect(outcomes).toEqual([]);
  });

  it("un servidor que la persona ya tenía sobrevive a ofrecer Y a retirar", () => {
    const previo = `[mcp_servers.otro]\ncommand = "npx"\nargs = ["-y", "@otro/servidor"]\n`;
    writeFileSync(join(home, ".codex", "config.toml"), previo);

    offerWorklineServer({ targets: ["codex"], scopeDir: home });
    const conAmbos = codexToml();
    expect(conAmbos).toContain("mcp_servers.otro");
    expect(conAmbos).toContain(WORKLINE_MCP_ENTRY_NAME);

    withdrawWorklineServer({ targets: ["codex"], scopeDir: home });
    const despues = codexToml();

    // La propia se fue y la ajena quedó, con su comando y sus argumentos.
    expect(despues).not.toContain(`mcp_servers.${WORKLINE_MCP_ENTRY_NAME}`);
    expect(despues).toContain("mcp_servers.otro");
    expect(despues).toContain("@otro/servidor");
  });

  it("retirar sobre una configuración que ya no la tiene no falla ni toca nada", () => {
    const previo = `[mcp_servers.otro]\ncommand = "npx"\nargs = ["-y", "@otro/servidor"]\n`;
    writeFileSync(join(home, ".codex", "config.toml"), previo);

    const outcomes = withdrawWorklineServer({ targets: ["codex"], scopeDir: home });

    expect(outcomes[0]?.state).toBe("unchanged");
    expect(codexToml()).toBe(previo);
  });

  it("una segunda instalación no vuelve a escribir lo que ya estaba", () => {
    offerWorklineServer({ targets: ["codex"], scopeDir: home });
    const outcomes = offerWorklineServer({ targets: ["codex"], scopeDir: home });

    // Informar un cambio que no ocurrió haría que una reinstalación pareciera
    // haber tocado la configuración de la persona.
    expect(outcomes[0]?.state).toBe("unchanged");
  });

  it("una entrada homónima de otra forma queda en conflicto y no se sobreescribe", () => {
    const foreign = `[mcp_servers.${WORKLINE_MCP_ENTRY_NAME}]\ncommand = "npx"\nargs = ["-y", "@otro/servidor"]\n`;
    writeFileSync(join(home, ".codex", "config.toml"), foreign);

    const outcomes = offerWorklineServer({ targets: ["codex"], scopeDir: home });

    expect(outcomes).toEqual([{ host: "codex", state: "conflict" }]);
    expect(codexToml()).toBe(foreign);
  });

  it("retirar una entrada homónima ajena también queda en conflicto y no escribe", () => {
    const foreign = `[mcp_servers.${WORKLINE_MCP_ENTRY_NAME}]\ncommand = "npx"\nargs = ["-y", "@otro/servidor"]\n`;
    writeFileSync(join(home, ".codex", "config.toml"), foreign);

    const outcomes = withdrawWorklineServer({ targets: ["codex"], scopeDir: home });

    expect(outcomes).toEqual([{ host: "codex", state: "conflict" }]);
    expect(codexToml()).toBe(foreign);
  });

  it("el dry-run informa el efecto MCP sin crear configuración", () => {
    const outcomes = offerWorklineServer({ targets: ["codex"], scopeDir: home, dryRun: true });

    expect(outcomes).toEqual([{ host: "codex", state: "dry-run" }]);
    expect(codexToml()).toBe("");
  });

  it("la entrada declara EN QUÉ host corre, porque el servidor no puede detectarlo", () => {
    // Lo lanza el host por entrada y salida estándar, sin variable que lo
    // identifique. El servidor usa ese dato para habilitar sólo una vía observada.
    offerWorklineServer({ targets: ["codex"], scopeDir: home });
    expect(codexToml()).toContain("--host");
    expect(codexToml()).toContain("codex");
  });

  it("el comando es el propio binario, con el envoltorio que Windows necesita", () => {
    // Un host que lanza el bin global de Windows sin shell falla con ENOENT: es la
    // misma decisión que el lanzador de dbhub ya había tomado.
    expect(worklineMcpEntry("codex", "darwin")).toMatchObject({
      command: "agent-workflow",
      args: ["mcp", "serve", "--host", "codex"],
    });
    expect(worklineMcpEntry("codex", "win32")).toMatchObject({
      command: "cmd",
      args: ["/c", "agent-workflow", "mcp", "serve", "--host", "codex"],
    });
  });

  it("un fallo de escritura se REPORTA y no revienta la instalación", () => {
    // Abortar la instalación entera por una entrada MCP dejaría a la persona sin
    // las superficies que sí pidió, por una mejora sobre algo que degrada a markdown.
    rmSync(join(home, ".codex"), { recursive: true, force: true });
    writeFileSync(join(home, ".codex"), "esto es un archivo, no un directorio");

    const outcomes = offerWorklineServer({ targets: ["codex"], scopeDir: home });

    expect(outcomes[0]?.state).toBe("failed");
    expect(outcomes[0]?.error).toBeDefined();
  });
});
