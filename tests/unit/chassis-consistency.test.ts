import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("Self-regulation (proactive compaction) — chasis ↔ harness (spec 004)", () => {
  const HARNESS_PATH = resolve(__dirname, "..", "..", "skills", "w", "harness", "HARNESS.md");

  /**
   * The proactive-compaction doctrine, wherever the chassis keeps it.
   *
   * Since plan 010 it is `modules/COMPACTION.md`, loaded under the `compaction`
   * signal: only a long run pays for it. The pins below are unchanged — what
   * moved is the file, not the rule — and the chassis must still point at it,
   * which is what the last assertion here checks.
   */
  const COMPACTION_MODULE = resolve(
    __dirname,
    "..",
    "..",
    "skills",
    "w",
    "modules",
    "COMPACTION.md",
  );

  async function selfRegulationSubsection(): Promise<string> {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    expect(chassis).toContain("modules/COMPACTION.md");
    const module = await readFile(COMPACTION_MODULE, "utf8");
    const start = module.indexOf("`Compactar` is not only reactive");
    expect(start).toBeGreaterThan(-1);
    return module.slice(start);
  }

  it("el chasis fija los dos modos, la config [compaction] y la degradación a confirm", async () => {
    const sub = await selfRegulationSubsection();
    expect(sub).toContain("`[compaction]`");
    expect(sub).toContain("`confirm` | `auto`");
    expect(sub).toMatch(/degrades to `confirm`/);
    expect(sub).toContain("`Compactar`");
  });

  it("CHECKPOINT-antes-de-compactar es invariante explícita en todos los modos", async () => {
    const sub = await selfRegulationSubsection();
    expect(sub).toContain("CHECKPOINT before compacting");
    expect(sub).toContain("**before** any compaction fires");
  });

  it("sin umbrales numéricos: la detección es señal del host + fallback cualitativo (D4)", async () => {
    const sub = await selfRegulationSubsection();
    expect(sub).toContain("no numeric thresholds");
    expect(sub).toMatch(/qualitative/i);
    expect(sub).not.toMatch(/\d+\s*%/);
    expect(sub).not.toMatch(/\d+k?\s*tokens/i);
  });

  it("presupuesto de tokens del chasis: la subsección se mantiene acotada (≤15 líneas no vacías)", async () => {
    const sub = await selfRegulationSubsection();
    const nonEmpty = sub.split(/\r?\n/).filter((line) => line.trim().length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(15);
  });

  it("§ Structured-choice levanta el flow control proactivamente bajo presión de contexto", async () => {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    const start = chassis.indexOf("## Structured-choice");
    const end = chassis.indexOf("## Compact / resume");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = chassis.slice(start, end);
    expect(section).toMatch(/raises the choice itself|Proactive raise/);
    expect(section).toContain("`Compactar`");
  });

  it("HARNESS carga los hechos por-host (señal, viabilidad de auto, degradación) y delega la semántica de modos al chasis", async () => {
    const harness = await readFile(HARNESS_PATH, "utf8");
    expect(harness).toContain("compaction (signal & self-regulation)");
    expect(harness).toContain("context-pressure");
    expect(harness).toMatch(/degrades to `confirm`/);
    // Single source: the config/mode semantics live ONLY in the chassis subsection.
    expect(harness).toContain("the chassis' subsection — single source");
    expect(harness).not.toMatch(/\[compaction\] mode = /);
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
    expect(bindings.Codex).toContain("`request_user_input` when exposed");
    expect(bindings["Kimi Code"]).toContain("`AskUserQuestion`");
    expect(bindings["Gemini / Antigravity"]).toMatch(/`ask_user`.*`AskQuestion`/);
    expect(bindings.OpenCode).toContain("`question`");
    expect(bindings.Crush).toContain("`question`");
    expect(bindings["Warp / Oz"]).toContain("no documented structured-choice surface");
    expect(bindings.Generic).toContain("labeled markdown");

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
    const commands = ["generate-launch.md", "persist.md", "resume.md", "spec-new.md"];
    for (const command of commands) {
      const body = await readFile(join(LOOPS_ROOT, "..", "commands", command), "utf8");
      expect(body, command).toContain("../loops/CHASSIS.md#structured-choice-design--batching");
      expect(body, command).toContain("../harness/HARNESS.md#harness-binding-matrix");
    }
  });
});
