import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Consistency guards for the `w` skill bundle. These catch CROSS-SKILL drift —
// where two skills that compose each other disagree on a shared contract — which
// the legacy-ref grep audit (skill-audit-grep.test.ts) does not cover. The
// motivating case: `roles/diagrams` and `exports/export-diagrams` had drifted
// apart on the engine flag (`--diagrams` vs `--engine`), the default engine
// (structurizr vs mermaid) and the output filenames. A composing pair must agree.
const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");
const SCANNED_SUBFOLDERS = ["commands", "loops", "exports", "roles", "artifacts", "hooks"];

async function listMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMdFiles(full)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

async function bundleMdFiles(): Promise<string[]> {
  const all: string[] = [];
  for (const sub of SCANNED_SUBFOLDERS) {
    all.push(...(await listMdFiles(join(SKILL_ROOT, sub))));
  }
  return all.map((f) => f.slice(SKILL_ROOT.length + 1));
}

describe("SKILL consistency — cross-skill contracts", () => {
  it("the diagrams engine flag is `--engine` bundle-wide (never the legacy `--diagrams`)", async () => {
    // `export-diagrams` exposes `--engine mermaid|c4`; the `diagrams` role it
    // composes must speak the same flag. `--diagrams` is the stale form.
    const files = await bundleMdFiles();
    const offenders: string[] = [];
    for (const relpath of files) {
      const text = await readFile(join(SKILL_ROOT, relpath), "utf8");
      if (text.includes("--diagrams")) offenders.push(relpath);
    }
    expect(offenders).toEqual([]);
  });

  it("export-diagrams and the diagrams role agree on the engine contract (--engine, default mermaid)", async () => {
    const role = await readFile(join(SKILL_ROOT, "roles/diagrams/SKILL.md"), "utf8");
    const exp = await readFile(join(SKILL_ROOT, "exports/export-diagrams/SKILL.md"), "utf8");
    // Both must name the shared flag.
    expect(role).toContain("--engine");
    expect(exp).toContain("--engine");
    // Modernized away from a structurizr default; neither may re-assert it.
    expect(role).not.toMatch(/structurizr.{0,20}(default|por defecto)/i);
    expect(exp).not.toMatch(/structurizr.{0,20}(default|por defecto)/i);
  });
});
