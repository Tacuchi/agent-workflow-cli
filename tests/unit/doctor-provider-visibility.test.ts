import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { visibilityProvider } from "../../src/application/doctor/provider-visibility.js";
import type { DoctorProviderInput, DoctorTargetHost } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { HARNESSES, type HarnessId } from "../../src/domain/harnesses.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * El proveedor de visibilidad del workspace.
 *
 * Su tensión propia: el motor `runVisibilityDoctor` inspecciona SIEMPRE su
 * propio conjunto fijo de hosts (claude, codex, warp) y habla ids de `McpHost`,
 * mientras que la corrida ya decidió a quién mira —`selectDoctorHosts` separó
 * los participantes de los ausentes y aplicó `--only`— y habla ids de catálogo.
 * Traducir sin filtrar produce un informe que se contradice a sí mismo: enumera
 * un host como «sin rastro en esta máquina» y dos secciones más abajo lo declara
 * «comprobada ✔» con un hallazgo sano.
 *
 * El resto de los casos fija que una deriva no se colapse: un host al que le
 * faltan rutas Y le sobran otras tiene DOS problemas distintos, con dos
 * remediaciones opuestas (`attach-multiroot` y `detach-multiroot`), y un solo
 * hallazgo por host escondería uno de los dos.
 */

const NS = normalizeNamespace("workflow");

let root: string;
let home: string;
let workspace: string;
let ctx: CliContext;
/** Directorios que el bloque de proyecto declara como fuentes. */
let fuenteA: string;
let fuenteB: string;
/** Un directorio real que NADIE declara: lo que convierte una ruta en «sobrante». */
let intrusa: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-visibility-"));
  home = join(root, "home");
  workspace = join(root, "ws");
  fuenteA = join(root, "src-a");
  fuenteB = join(root, "src-b");
  intrusa = join(root, "intrusa");
  for (const dir of [home, workspace, fuenteA, fuenteB, intrusa])
    mkdirSync(dir, { recursive: true });
  ctx = {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, workspace),
    paths: new PathsService(NS, home, workspace),
  } as unknown as CliContext;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** El bloque de proyecto es la ÚNICA fuente de lo declarado que el motor lee. */
function declararFuentes(...paths: string[]): void {
  const lines = [
    "<!-- WORKFLOW-PROJECT-START -->",
    "",
    "## Proyecto",
    "",
    "Workspace de prueba.",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    ...paths.map((path, index) => `| fuente-${index} | ${path} | main |`),
    "",
    "## Stack",
    "",
    "_Stack sin detectar._",
    "",
    "## Status",
    "",
    "- Ramas de trabajo actuales: _ninguna_",
    "",
    "<!-- WORKFLOW-PROJECT-END -->",
  ];
  writeFileSync(join(workspace, "CLAUDE.md"), `${lines.join("\n")}\n`);
}

function registrarEnClaude(...dirs: string[]): void {
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  writeFileSync(
    join(workspace, ".claude", "settings.json"),
    `${JSON.stringify({ permissions: { additionalDirectories: dirs } })}\n`,
  );
}

function registrarEnCodex(...dirs: string[]): void {
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  writeFileSync(
    join(workspace, ".codex", "config.toml"),
    `additional_writable_roots = [${dirs.map((dir) => `"${dir}"`).join(", ")}]\n`,
  );
}

/** La vista que el agregador pasa, armada desde el catálogo y no inventada. */
function hostView(id: HarnessId): DoctorTargetHost {
  const spec = HARNESSES.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`host fuera del catálogo: ${id}`);
  return {
    host: spec.id,
    target: spec.installTarget,
    label: spec.label,
    status: "ready",
    current: false,
    runtime: { state: "installed", version: null },
    workline_installed: true,
    mcp_host: spec.mcpHostId,
  };
}

function inputFor(hosts: HarnessId[]): DoctorProviderInput {
  return {
    ctx,
    hosts: hosts.map(hostView),
    hostStates: [],
    currentHost: null,
    workspaceDir: workspace,
    skipNative: false,
  };
}

/** Sólo el ámbito workspace: el ámbito global aporta sus propias filas. */
function delWorkspace<T extends { id: string }>(items: readonly T[]): T[] {
  return items.filter((item) => item.id.includes("/workspace:visibilidad"));
}

describe("proveedor de visibilidad del workspace", () => {
  it("no diagnostica un host que la selección dejó afuera (AC-01)", async () => {
    // El motor devuelve claude, codex y warp pase lo que pase. Acá sólo codex
    // participa: warp y claude-code fueron declarados ausentes por el agregador,
    // y un host ausente se enumera «sin hallazgo ni advertencia». Sin el filtro
    // el informe traía cobertura `workspace-visibility/warp/checked` y el
    // hallazgo sano de warp junto a la línea «warp: sin rastro en esta máquina».
    declararFuentes(fuenteA);
    registrarEnClaude(fuenteA);
    registrarEnCodex(fuenteA);

    const output = await visibilityProvider.run(inputFor(["codex"]));

    expect([...new Set(output.coverage.map((entry) => entry.host))]).toEqual(["codex"]);
    expect([...new Set(output.findings.map((finding) => finding.host))]).toEqual(["codex"]);
    // Y el host que sí participa se sigue comprobando: el filtro no vacía todo.
    expect(delWorkspace(output.findings).map((finding) => finding.state)).toEqual(["healthy"]);
  });

  it("con la selección vacía —`--only` sobre un host ausente— no emite nada", async () => {
    // `--only kimi` con kimi ausente deja `hosts = []`. El motor sigue
    // devolviendo sus tres informes; ninguno puede llegar al informe final,
    // porque `findings[].host` y `coverage[].host` nombrarían hosts que no
    // están en `hosts[]` y el esquema D2 dejaría de cerrar.
    declararFuentes(fuenteA);
    registrarEnClaude(fuenteA);

    const output = await visibilityProvider.run(inputFor([]));

    expect(output.coverage).toEqual([]);
    expect(output.findings).toEqual([]);
  });

  it("faltantes y sobrantes son DOS hallazgos separados, con remediaciones opuestas", async () => {
    // El estado agregado del informe es `missing-paths` y taparía las
    // sobrantes: un solo hallazgo por host perdería la mitad del problema.
    declararFuentes(fuenteA, fuenteB);
    registrarEnClaude(fuenteA, intrusa);

    const output = await visibilityProvider.run(inputFor(["claude-code"]));
    const findings = delWorkspace(output.findings);

    expect(findings.map((finding) => finding.id)).toEqual([
      "claude-code/workspace-visibility/workspace:visibilidad:faltantes",
      "claude-code/workspace-visibility/workspace:visibilidad:sobrantes",
    ]);
    expect(findings.map((finding) => finding.state)).toEqual(["warning", "warning"]);
    expect(findings[0]?.evidence).toEqual([`falta: ${fuenteB}`]);
    expect(findings[1]?.evidence).toEqual([`sobra: ${intrusa}`]);
    expect(findings[0]?.remediation.guidance).toEqual(["aw attach-multiroot"]);
    expect(findings[1]?.remediation.guidance).toEqual(["aw detach-multiroot"]);
    // El host se traduce al id de catálogo: `claude` (McpHost) no existe como host.
    expect([...new Set(output.coverage.map((entry) => entry.host))]).toEqual(["claude-code"]);
  });

  it("sin el archivo de configuración el hallazgo es `sin-config`, no una deriva de rutas", async () => {
    // Nada que comparar contra nada: el host no ve NINGUNA fuente declarada, y
    // eso es un problema distinto de tener rutas de menos en un archivo que sí
    // existe —la remediación crea el archivo, no lo edita.
    declararFuentes(fuenteA, fuenteB);

    const output = await visibilityProvider.run(inputFor(["codex"]));
    const findings = delWorkspace(output.findings);

    const ids = findings.map((finding) => finding.id);
    expect(ids).toContain("codex/workspace-visibility/workspace:visibilidad:sin-config");
    expect(findings.every((finding) => finding.state === "warning")).toBe(true);
    expect(
      findings.find((finding) => finding.id.endsWith(":sin-config"))?.evidence.join(" | "),
    ).toContain(join(workspace, ".codex", "config.toml"));
  });

  it("el host que registra exactamente lo declarado sale sano y comprobado (AC-15)", async () => {
    declararFuentes(fuenteA, fuenteB);
    registrarEnClaude(fuenteA, fuenteB);

    const output = await visibilityProvider.run(inputFor(["claude-code"]));
    const [finding] = delWorkspace(output.findings);

    expect(finding?.state).toBe("healthy");
    expect(finding?.id).toBe("claude-code/workspace-visibility/workspace:visibilidad");
    expect(finding?.remediation.kind).toBe("none");
    // Lo sano se declara sólo dentro de lo comprobado.
    expect(output.coverage.find((entry) => entry.host === "claude-code")?.state).toBe("checked");
  });

  it("sin bloque de proyecto el ámbito workspace no aporta hallazgo: es `not-applicable`", async () => {
    // Correr el doctor desde un directorio que no es un workspace no es una
    // desconfiguración de nadie. No hay nada declarado contra qué comparar, así
    // que el ámbito workspace no emite NI hallazgo NI advertencia; sólo el
    // ámbito global —que sí tiene algo que mirar— aporta su fila.
    const output = await visibilityProvider.run(inputFor(["claude-code", "codex"]));

    expect(delWorkspace(output.findings)).toEqual([]);
    expect(output.findings.filter((finding) => finding.state === "warning")).toEqual([]);
    expect(output.findings.map((finding) => finding.id)).toEqual([
      "claude-code/workspace-visibility/global:visibilidad",
      "codex/workspace-visibility/global:visibilidad",
    ]);
  });
});
