import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { HARNESSES, type HarnessId } from "../../src/domain/harnesses.js";
import { parseSkillFrontmatter } from "../../src/domain/skill-frontmatter.js";

// Guards for the loop chassis (skills/w/loops/CHASSIS.md). The engine shared by
// the 5 loops lives in ONE referenced document; each heir adds only its deltas.
// These checks catch structural drift: heirs outside the canonical list, heirs
// missing the chassis reference (the engine would never enter the context),
// re-declared engine sections (duplication that diverges again), and an
// accidental frontmatter that would make the chassis look like a skill.
const LOOPS_ROOT = resolve(__dirname, "..", "..", "skills", "w", "loops");
const CHASSIS_PATH = join(LOOPS_ROOT, "CHASSIS.md");

// Sections the chassis itself delegates to each heir ("each heir declares its
// descriptor and Type in its own ## Internal sessions"; "heirs are instances of
// the same gate"; "each heir defines its prior-work marker"): heirs instantiate
// them legitimately, so they do not count as re-declaration.
const HEIR_INSTANCED_SECTIONS: ReadonlySet<string> = new Set([
  "Internal sessions (managed) — one session per run",
  "Compact / resume",
  "Convergence / exit",
  // Since plan 010 every document that has conditional branches lists them
  // under this heading with its own signals and its own modules. It is a
  // per-document pointer list, not engine doctrine restated — the same reason
  // the three above are here.
  "Conditional modules",
]);

/** `## ` headings outside fenced code blocks. */
function h2Headings(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^## (.+?)\s*$/);
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** Bullets of the chassis' "## Heirs …" section: `- [`<name>`](…)`. */
function heirsDeclaredInChassis(chassis: string): string[] {
  const lines = chassis.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Heirs\b/.test(line));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^## /.test(line)) break;
    const match = line.match(/^-\s+\[?`([^`]+)`/);
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

async function heirDirs(): Promise<string[]> {
  const entries = await readdir(LOOPS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("CHASSIS consistency — motor de loops vs heirs reales", () => {
  it("la lista canónica de heirs del chasis ≡ los directorios reales bajo skills/w/loops/", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    const declared = heirsDeclaredInChassis(chassis).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual(await heirDirs());
  });

  it("cada loops/*/LOOP.md referencia CHASSIS.md (sin la ref, el motor no entra al contexto)", async () => {
    const offenders: string[] = [];
    for (const dir of await heirDirs()) {
      const text = await readFile(join(LOOPS_ROOT, dir, "LOOP.md"), "utf8");
      if (!text.includes("CHASSIS.md")) offenders.push(dir);
    }
    expect(offenders).toEqual([]);
  });

  it("ningún heir re-declara encabezados del motor (los deltas no duplican el chasis)", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    const forbidden = new Set(
      h2Headings(chassis).filter((heading) => !HEIR_INSTANCED_SECTIONS.has(heading)),
    );
    expect(forbidden.size).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const dir of await heirDirs()) {
      const text = await readFile(join(LOOPS_ROOT, dir, "LOOP.md"), "utf8");
      for (const heading of h2Headings(text)) {
        if (forbidden.has(heading)) offenders.push(`${dir}: ## ${heading}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("CHASSIS.md no tiene frontmatter YAML (es doc referenciado, no una skill)", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    expect(chassis.startsWith("---")).toBe(false);
    expect(parseSkillFrontmatter(chassis)).toBeNull();
  });
});

describe("Structured-choice — opciones funcionales y bindings multi-host", () => {
  const HARNESS_PATH = resolve(__dirname, "..", "..", "skills", "w", "harness", "HARNESS.md");

  it("el chasis exige etiqueta semántica y explicación funcional o ejemplo", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    const section = chassis.slice(
      chassis.indexOf("## Structured-choice"),
      chassis.indexOf("## Compact / resume"),
    );
    expect(section).toContain("short semantic label + one functional sentence");
    expect(section).toMatch(/outcome\/trade-off|simple example/);
  });

  it("la matriz declara el binding comprobado de cada host o una limitación explícita", async () => {
    const harness = await readFile(HARNESS_PATH, "utf8");
    const lines = harness.split(/\r?\n/);
    const parseRow = (line: string): string[] =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
    const header = parseRow(
      lines.find((line) => line.startsWith("| Capability | Claude Code | Codex |")) ?? "",
    );
    const row = parseRow(lines.find((line) => line.startsWith("| structured-choice |")) ?? "");
    expect(row).toHaveLength(header.length);

    const bindings = Object.fromEntries(header.map((column, index) => [column, row[index]]));
    expect(bindings["Claude Code"]).toContain("`AskUserQuestion`");
    expect(bindings["Kimi Code"]).toContain("`AskUserQuestion`");
    expect(bindings.OpenCode).toContain("`question`");
    expect(bindings.Crush).toContain("`question`");
    expect(bindings["Warp / Oz"]).toContain("labeled markdown");
    expect(bindings.Generic).toContain("labeled markdown");

    // La celda de codex la corrigió la sonda de 2026-08-04 ("not reachable") y la
    // re-sonda de 2026-08-22 sobre 0.149.0 la volvió a corregir: el gate real es la
    // lista de tools DEL TURNO (Default mode no la lista; exec nunca), así que la
    // fila exige la semántica por turno con su fallback, no una negativa categórica.
    expect(bindings.Codex).toContain("`request_user_input`");
    expect(bindings.Codex).toMatch(/per turn/);
    expect(bindings.Codex).toContain("Default mode");
    expect(bindings.Codex).toContain("labeled markdown");
    // La re-sonda del 2026-08-22 probó que el opt-in por config no alcanza: la
    // fila tiene que nombrar el cambio de modo, que es la vía que sí existe.
    expect(bindings.Codex).toMatch(/\/plan/);
    // La herramienta viva de gemini es `AskQuestion` (Antigravity); `ask_user` es
    // del Gemini CLI retirado y NO está en el binario instalado. La fila tiene que
    // nombrar la primera y desmentir la segunda, no listarlas como equivalentes.
    expect(bindings["Gemini / Antigravity"]).toContain("`AskQuestion`");
    expect(bindings["Gemini / Antigravity"]).toMatch(/`ask_user` is the retired/);

    // Todo host nativo declara CUÁNDO cae a markdown: un binding sin condición se
    // lee como "siempre nativo", y en tres de los cuatro no lo es.
    for (const column of ["Kimi Code", "OpenCode"]) {
      expect(bindings[column], column).toMatch(/labeled markdown/);
    }

    const matrixColumnByHarness = {
      "claude-code": "Claude Code",
      codex: "Codex",
      kimi: "Kimi Code",
      gemini: "Gemini / Antigravity",
      opencode: "OpenCode",
      crush: "Crush",
      warp: "Warp / Oz",
      oz: "Warp / Oz",
    } satisfies Record<HarnessId, string>;
    expect(Object.keys(matrixColumnByHarness).sort()).toEqual(
      HARNESSES.map((spec) => spec.id).sort(),
    );
    for (const spec of HARNESSES) {
      expect(bindings[matrixColumnByHarness[spec.id]], spec.id).toBeTruthy();
    }
    expect(harness).not.toContain("this table is prose and no test reads it");

    // El catálogo es la fuente que el instalador estampa y la matriz es la que un
    // humano lee: si divergen, la superficie instalada le promete al agente un
    // mecanismo que la doctrina no reconoce. Nadie más comparaba las dos.
    for (const spec of HARNESSES) {
      const cell = bindings[matrixColumnByHarness[spec.id]] ?? "";
      const binding = spec.structuredChoice;
      if (binding.tool === null) {
        expect(binding.state, spec.id).toBe("unsupported");
        expect(cell, spec.id).toMatch(/labeled markdown|no documented structured-choice surface/);
      } else {
        expect(cell, spec.id).toContain(`\`${binding.tool}\``);
      }
    }
  });

  it("todo host declara de qué depende su binding y cuándo cae a markdown", () => {
    for (const spec of HARNESSES) {
      const binding = spec.structuredChoice;
      // Sin razón de fallback la degradación es invisible: el agente no sabe
      // cuándo NO está usando el mecanismo nativo.
      expect(binding.fallbackReason.trim().length, spec.id).toBeGreaterThan(0);
      // Una afirmación sin fuente fechada es la que nadie puede volver a comprobar.
      expect(binding.evidence, spec.id).toMatch(/20\d\d-\d\d-\d\d|20\d\d/);
      // Techos inventados sería lo peor: o los declara el host, o no hay ninguno.
      if (binding.ceilings !== null) {
        expect(binding.ceilings.questions, spec.id).toBeGreaterThan(0);
        expect(binding.ceilings.options, spec.id).toBeGreaterThan(1);
      }
      if (binding.state === "unsupported") expect(binding.tool, spec.id).toBeNull();
    }
  });

  it("el binding preserva label y explicación incluso en superficies de un solo texto", async () => {
    const harness = await readFile(HARNESS_PATH, "utf8");
    expect(harness).toContain("render `Label — functional sentence`");
    expect(harness).toContain("do not add a duplicate `Other` option");
  });

  it("el chasis común no codifica límites o herramientas de un host concreto", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    const section = chassis.slice(
      chassis.indexOf("## Structured-choice"),
      chassis.indexOf("## Compact / resume"),
    );
    expect(section).not.toMatch(
      /Claude|Codex|Kimi|Gemini|Antigravity|OpenCode|Crush|Warp|AskUserQuestion|request_user_input/,
    );
    expect(section).toContain("reserving one question slot for `flow`");
  });

  it("el fallback acepta recomendaciones por etiqueta y no exige coordenadas 1A", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    expect(chassis).toContain("`Aceptar recomendaciones`");
    expect(chassis).toContain("Never require composite coordinates such as `1A, 2A, 3A`");
  });

  it("una pregunta que excede la UI cae a texto sin perder candidatos", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    expect(chassis).toContain("never truncate or merge candidates");
  });

  it("los comandos directos que preguntan enlazan forma canónica y binding por host", async () => {
    const commands = ["persist.md", "recall.md", "resume.md", "spec-new.md"];
    for (const command of commands) {
      const body = await readFile(join(LOOPS_ROOT, "..", "commands", command), "utf8");
      expect(body, command).toContain("../loops/CHASSIS.md#structured-choice-design--batching");
      expect(body, command).toContain("../harness/HARNESS.md#harness-binding-matrix");
    }
  });
});

describe("Tabla de estado por superficie — HARNESS.md ↔ catálogo", () => {
  const HARNESS_PATH = resolve(__dirname, "..", "..", "skills", "w", "harness", "HARNESS.md");
  const SURFACES = [
    "commands",
    "structured-choice",
    "hooks",
    "mcp",
    "host-memory",
    "compaction",
  ] as const;
  const COLUMN_BY_HOST = {
    "claude-code": "Claude Code",
    codex: "Codex",
    kimi: "Kimi Code",
    gemini: "Gemini / Antigravity",
    opencode: "OpenCode",
    crush: "Crush",
    warp: "Warp",
    oz: "Oz",
  } satisfies Record<HarnessId, string>;

  async function statusTable(): Promise<Map<string, Map<string, string>>> {
    const lines = (await readFile(HARNESS_PATH, "utf8")).split(/\r?\n/);
    const cells = (line: string): string[] =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
    const start = lines.findIndex((line) => line.startsWith("| Surface |"));
    expect(start, "falta la tabla de estado por superficie").toBeGreaterThan(-1);
    const header = cells(lines[start] ?? "");
    const table = new Map<string, Map<string, string>>();
    for (const line of lines.slice(start + 2)) {
      if (!line.startsWith("|")) break;
      const row = cells(line);
      expect(row, line).toHaveLength(header.length);
      table.set(
        row[0] ?? "",
        new Map(header.slice(1).map((column, i) => [column, row[i + 1] ?? ""])),
      );
    }
    return table;
  }

  it("tiene una fila por superficie y una columna por host, warp y oz separados", async () => {
    const table = await statusTable();
    expect([...table.keys()]).toEqual([...SURFACES]);
    expect(Object.keys(COLUMN_BY_HOST).sort()).toEqual(HARNESSES.map((spec) => spec.id).sort());
    for (const row of table.values()) {
      expect([...row.keys()].sort()).toEqual(Object.values(COLUMN_BY_HOST).sort());
    }
  });

  it("cada celda abre con el estado que el catálogo le da a ese host", async () => {
    const table = await statusTable();
    let compared = 0;
    for (const spec of HARNESSES) {
      const capabilities = capabilitiesFor(spec);
      for (const surface of SURFACES) {
        const cell = table.get(surface)?.get(COLUMN_BY_HOST[spec.id]) ?? "";
        const declared = /^(native|degraded|unsupported)\b/.exec(cell)?.[1];
        const catalog = capabilities.find((capability) => capability.id === surface)?.status;
        expect(declared, `${spec.id}/${surface}: «${cell}»`).toBe(catalog);
        compared += 1;
      }
    }
    expect(compared).toBe(48);
  });

  it("la prosa ya no contradice al catálogo en compactación ni en el plugin retirado", async () => {
    const harness = await readFile(HARNESS_PATH, "utf8");
    expect(harness).not.toContain("`session.compacted`");
    expect(harness).not.toMatch(/`PostCompact` \*\*partial\*\*/);
    expect(harness).not.toContain("That module is now **generated**");
  });
});
