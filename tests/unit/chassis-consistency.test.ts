import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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

  /** The `### Self-regulation …` subsection of § Compact / resume, up to the next `## `. */
  async function selfRegulationSubsection(): Promise<string> {
    const chassis = await readFile(CHASSIS_PATH, "utf8");
    const start = chassis.indexOf("### Self-regulation (proactive compaction)");
    expect(start).toBeGreaterThan(-1);
    const rest = chassis.slice(start);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
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
    expect(section).toContain("Proactive raise");
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
