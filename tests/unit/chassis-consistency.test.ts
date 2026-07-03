import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter } from "../../src/domain/skill-frontmatter.js";

// Guards del chasis de loops (skills/w/loops/CHASSIS.md). El motor común de los
// 5 loops vive en UN documento referenciado; cada heir agrega solo sus deltas.
// Estos checks atrapan drift estructural: heirs fuera de la lista canónica,
// heirs sin la referencia al chasis (el motor no entraría al contexto),
// re-declaración de secciones del motor (duplicación que vuelve a divergir) y
// un frontmatter accidental que haría al chasis parecer una skill.
const LOOPS_ROOT = resolve(__dirname, "..", "..", "skills", "w", "loops");
const CHASSIS_PATH = join(LOOPS_ROOT, "CHASSIS.md");

// Secciones que el propio chasis delega a cada heir ("cada heir declara su
// descriptor y su Type en su propio ## Internal sessions"; "los heirs son
// instancias del mismo gate"; "cada heir define su marca de trabajo previo"):
// los heirs las instancian legítimamente, no cuentan como re-declaración.
const HEIR_INSTANCED_SECTIONS: ReadonlySet<string> = new Set([
  "Internal sessions (managed) — una session por run",
  "Compact / resume",
  "Convergence / exit",
]);

/** Encabezados `## ` fuera de bloques de código cercados. */
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

/** Bullets de la sección "## Heirs …" del chasis: `- [`<name>`](…)`. */
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

  it("cada loops/*/SKILL.md referencia CHASSIS.md (sin la ref, el motor no entra al contexto)", async () => {
    const offenders: string[] = [];
    for (const dir of await heirDirs()) {
      const text = await readFile(join(LOOPS_ROOT, dir, "SKILL.md"), "utf8");
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
      const text = await readFile(join(LOOPS_ROOT, dir, "SKILL.md"), "utf8");
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
