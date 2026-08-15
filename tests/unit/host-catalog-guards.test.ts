// Anti-drift guards: the domain catalog is the ONLY host set, and every
// surface projects it.
//
// The bug these exist to prevent already happened: four registries drifted apart
// — the domain (7, with oz, without agents), the install targets (8, with both),
// the TUI (7, with agents, without oz) and the doctor (6, filtering on
// mcpHostId). An install on oz was invisible across the entire TUI, and the
// shared `agents` dir inflated the host count. Every assertion below fails the
// moment a surface stops deriving.

import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeMcpEntry } from "../../src/application/mcp-host-writer.js";
import { hooksArmedProbeCoverage } from "../../src/application/self/host-states.js";
import { hookInstallerCoverage } from "../../src/application/self/install-hooks.js";
import {
  HOOKS_MANAGED_TARGETS,
  INSTALL_TARGETS,
  TARGET_ROOTS,
} from "../../src/application/self/install-targets.js";
import { REPLICA_HOST_KEYS } from "../../src/application/self/skills-manager.js";
import { hookRemoverCoverage } from "../../src/application/self/uninstall.js";
import { HOSTS, SHARED_DESTINATIONS, supportPill } from "../../src/cli/tui/hosts.js";
import {
  HARNESSES,
  HOST_INSTALL_TARGETS,
  MCP_FILE_HOSTS,
  SHARED_INSTALL_TARGETS,
  harnessForMcpHost,
} from "../../src/domain/harnesses.js";
import { buildMcpEntry } from "../../src/domain/mcp-entry.js";

describe("catálogo único de hosts", () => {
  it("la TUI proyecta exactamente los hosts del dominio, en su orden", () => {
    expect(HOSTS.map((h) => h.id)).toEqual([...HOST_INSTALL_TARGETS]);
    // Y `agents` NO está entre ellos: es destino compartido.
    expect(HOSTS.map((h) => h.id)).not.toContain("agents");
    expect(SHARED_DESTINATIONS.map((d) => d.id)).toEqual([...SHARED_INSTALL_TARGETS]);
  });

  it("los destinos de instalación son exactamente hosts + destinos compartidos", () => {
    expect([...INSTALL_TARGETS].sort()).toEqual(
      [...HOST_INSTALL_TARGETS, ...SHARED_INSTALL_TARGETS].sort(),
    );
    // TypeScript ya obliga a que TARGET_ROOTS tenga toda clave; esto pin-ea que
    // no tenga NINGUNA de más.
    expect(Object.keys(TARGET_ROOTS).sort()).toEqual([...INSTALL_TARGETS].sort());
  });

  it("la TUI toma etiqueta, glifo y nivel del dominio (nada escrito a mano)", () => {
    for (const spec of HARNESSES) {
      const projected = HOSTS.find((h) => h.id === spec.installTarget);
      expect(projected?.name, spec.id).toBe(spec.label);
      expect(projected?.glyph, spec.id).toBe(spec.glyph);
      expect(projected?.tier, spec.id).toBe(spec.support.tier);
    }
  });

  it("un host sin verificación de una corrida se muestra como 'unverified', nunca como verificado", () => {
    for (const host of HOSTS) {
      const pill = supportPill(host);
      if (host.verified === null) {
        expect(pill, host.id).toContain("unverified");
      } else {
        expect(pill, host.id).toContain(host.verified.at);
      }
    }
  });

  it("todo destino compartido declara qué hosts lo leen", () => {
    for (const dest of SHARED_DESTINATIONS) {
      expect(dest.readBy.length, dest.id).toBeGreaterThan(0);
    }
  });
});

describe("cobertura de hooks: declarar 'gestionado' obliga a implementarlo", () => {
  // La membresía va LITERAL a propósito. Derivarla del dominio hacía el bloque
  // vacuo: poner `managed: false` en kimi vaciaba el conjunto, las tres
  // coberturas seguían devolviendo [] y la comparación derivada comparaba dos
  // listas a las que les faltaba lo mismo — cuatro tests en verde mientras la
  // instalación de hooks en kimi desaparecía en silencio.
  it("los hosts con hooks gestionados son exactamente claude y kimi", () => {
    expect([...HOOKS_MANAGED_TARGETS].sort()).toEqual(["claude", "kimi"]);
  });

  it("todo host con hooks gestionados tiene instalador", () => {
    expect(HOOKS_MANAGED_TARGETS.size).toBeGreaterThan(0);
    expect(hookInstallerCoverage()).toEqual([]);
  });

  it("todo host con hooks gestionados tiene removedor (si no, quedarían huérfanos)", () => {
    expect(hookRemoverCoverage()).toEqual([]);
  });

  it("todo host con hooks gestionados tiene sonda de 'armados' (si no, la TUI mentiría)", () => {
    expect(hooksArmedProbeCoverage()).toEqual([]);
  });

  it("el conjunto gestionado deriva del dominio, no de una copia", () => {
    const fromDomain = HARNESSES.filter((h) => h.hooks?.managed === true).map(
      (h) => h.installTarget,
    );
    expect(fromDomain.length).toBeGreaterThan(0);
    expect([...HOOKS_MANAGED_TARGETS].sort()).toEqual([...fromDomain].sort());
  });
});

describe("escritor MCP: un archivo distinto por host", () => {
  let scopeDir: string;
  beforeAll(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-guard-"));
  });
  afterAll(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  // REGRESIÓN: la cadena de ifs terminaba en un `return …crush…`, así que un
  // host nuevo sin rama escribía en crush.json sin error alguno. Con dos hosts
  // apuntando al mismo archivo este test falla.
  it("ningún host escribe en el archivo de otro (global)", () => {
    const entry = buildMcpEntry("guard", "GUARD_DATABASE_URL", "darwin");
    const targets = MCP_FILE_HOSTS.map(
      (host) => writeMcpEntry(host, entry, { scopeDir, kind: "global" }, { dryRun: true }).target,
    );
    expect(new Set(targets).size, `targets: ${targets.join(", ")}`).toBe(MCP_FILE_HOSTS.length);
  });

  it("ningún host escribe en el archivo de otro (workspace)", () => {
    const entry = buildMcpEntry("guard", "GUARD_DATABASE_URL", "darwin");
    const targets = MCP_FILE_HOSTS.map(
      (host) =>
        writeMcpEntry(host, entry, { scopeDir, kind: "workspace" }, { dryRun: true }).target,
    );
    expect(new Set(targets).size, `targets: ${targets.join(", ")}`).toBe(MCP_FILE_HOSTS.length);
  });

  it("todo McpHost tiene su spec en el catálogo", () => {
    for (const host of MCP_FILE_HOSTS) {
      expect(harnessForMcpHost(host), host).not.toBeNull();
    }
  });
});

describe("cadenas retiradas: no vuelven por la ventana", () => {
  const RETIRED = [
    // Los hooks no son universales ni exclusivos de claude: se sondean por host.
    "claude only",
    // Las réplicas se derivan de REPLICA_HOST_KEYS, no se deletrean.
    "Claude, Gemini",
  ];

  async function sourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await sourceFiles(full, acc);
      else if ([".ts", ".tsx"].includes(extname(entry.name))) acc.push(full);
    }
    return acc;
  }

  it("ninguna cadena retirada reaparece en src/ (fuera de los comentarios que las explican)", async () => {
    const files = await sourceFiles(join(process.cwd(), "src"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*")) continue;
        for (const needle of RETIRED) {
          if (code.includes(needle)) offenders.push(`${file}:${i + 1} → ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("las réplicas se enumeran desde el motor", () => {
    expect(REPLICA_HOST_KEYS.length).toBeGreaterThan(0);
    for (const key of REPLICA_HOST_KEYS) {
      expect(HOST_INSTALL_TARGETS, `${key} debe ser un host real`).toContain(key);
    }
  });
});
