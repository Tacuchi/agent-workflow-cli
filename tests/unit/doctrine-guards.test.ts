import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Doctrine budget & form guards (informe 003 — weak-model clarity round).
// G1 pins the guaranteed per-flow load: adding doctrine to a hot-path file must
// either cut elsewhere or consciously raise the budget in this table. G2 stops
// the worst readability regressions (norm buried in giant prose). G4 caps the
// frontmatter descriptions (a permanent system-prompt tax on flatten hosts).
// G5 pins the canonical short `## Inherits` form — paraphrased engine summaries
// were the informe-002 drift factory reborn in miniature.
const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");

async function readRel(rel: string): Promise<string> {
  return readFile(join(SKILL_ROOT, rel), "utf8");
}

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

// Plain and folded (`>-` / `|`) YAML scalars, enough for our own frontmatter.
function descriptionLength(text: string): number {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm?.[1]) return 0;
  const buf: string[] = [];
  let capturing = false;
  for (const line of fm[1].split(/\r?\n/)) {
    if (/^description:/.test(line)) {
      capturing = true;
      const rest = line.replace(/^description:\s*/, "");
      if (rest !== "" && !/^[>|][-+]?$/.test(rest)) buf.push(rest);
      continue;
    }
    if (capturing) {
      if (/^[A-Za-z_-]+:/.test(line)) break;
      buf.push(line.trim());
    }
  }
  return buf.join(" ").trim().length;
}

describe("Doctrine guards — G1 · guaranteed load budget per flow", () => {
  // command + loop + chassis (+ CODE-POLICIES for code loops) (+ declared
  // reuse: plan-refine loads plan-new-loop for its taxonomy and skeleton).
  const FLOW_LOADS: ReadonlyArray<{ flow: string; files: string[]; budget: number }> = [
    {
      flow: "quick",
      files: [
        "commands/quick.md",
        "loops/quick-loop/LOOP.md",
        "loops/CHASSIS.md",
        "loops/CODE-POLICIES.md",
      ],
      budget: 40_500,
    },
    {
      flow: "spec-refine",
      files: ["commands/spec-refine.md", "loops/spec-refine-loop/LOOP.md", "loops/CHASSIS.md"],
      budget: 35_500,
    },
    {
      flow: "plan-new",
      files: ["commands/plan-new.md", "loops/plan-new-loop/LOOP.md", "loops/CHASSIS.md"],
      budget: 33_000,
    },
    {
      flow: "plan-refine",
      files: [
        "commands/plan-refine.md",
        "loops/plan-refine-loop/LOOP.md",
        "loops/plan-new-loop/LOOP.md",
        "loops/CHASSIS.md",
      ],
      budget: 43_000,
    },
    {
      flow: "plan-exec",
      files: [
        "commands/plan-exec.md",
        "loops/plan-exec-loop/LOOP.md",
        "loops/CHASSIS.md",
        "loops/CODE-POLICIES.md",
      ],
      budget: 39_500,
    },
  ];

  it("every flow's guaranteed load stays within its byte budget", async () => {
    const offenders: string[] = [];
    for (const { flow, files, budget } of FLOW_LOADS) {
      let total = 0;
      for (const rel of files) total += Buffer.byteLength(await readRel(rel), "utf8");
      if (total > budget) offenders.push(`${flow}: ${total} B > budget ${budget} B`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Doctrine guards — G2 · readability caps in the hot path", () => {
  // Generous ceilings: they catch only the worst 5% (norm+rationale+exception
  // chained into one giant sentence), not style preferences.
  const MAX_LINE_CHARS = 900;
  const MAX_SENTENCE_WORDS = 60;

  it("no line > 900 chars and no sentence > 60 words in loops/ and commands/", async () => {
    const targets: string[] = [];
    for (const sub of ["loops", "commands"]) {
      targets.push(...(await listMdFiles(join(SKILL_ROOT, sub))));
    }
    const offenders: string[] = [];
    for (const file of targets) {
      const rel = file.slice(SKILL_ROOT.length + 1);
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      let fence = false;
      lines.forEach((line, i) => {
        if (/^\s*```/.test(line)) {
          fence = !fence;
          return;
        }
        if (fence || /^\s*\|/.test(line)) return;
        if (line.length > MAX_LINE_CHARS)
          offenders.push(`${rel}:${i + 1} line ${line.length} chars`);
        const stripped = line.replace(/^\s*([-*+]\s+|\d+[.)]\s+|>\s?)+/, "");
        for (const sentence of stripped.split(/(?<=[.!?])\s+/)) {
          const words = sentence.split(/\s+/).filter(Boolean).length;
          if (words > MAX_SENTENCE_WORDS) offenders.push(`${rel}:${i + 1} sentence ${words} words`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("Doctrine guards — G4 · frontmatter description budgets", () => {
  // Descriptions are the always-loaded surface (flatten hosts pay ALL of them);
  // caps per area, tighter than the Agent Skills 1024 standard cap.
  function capFor(rel: string): number {
    if (rel.startsWith("commands/")) return 500;
    if (rel.startsWith("loops/")) return 600;
    if (rel.startsWith("roles/")) return 800;
    if (rel.startsWith("exports/")) return 1000;
    return 650; // root SKILL.md · harness/HARNESS.md
  }

  it("every description stays within its area budget", async () => {
    const rels: string[] = ["SKILL.md", join("harness", "HARNESS.md")];
    for (const sub of ["commands", "loops", "exports", "roles"]) {
      const files = await listMdFiles(join(SKILL_ROOT, sub));
      rels.push(...files.map((f) => f.slice(SKILL_ROOT.length + 1)));
    }
    const offenders: string[] = [];
    for (const rel of rels) {
      const len = descriptionLength(await readRel(rel));
      const cap = capFor(rel);
      if (len > cap) offenders.push(`${rel}: ${len} chars > cap ${cap}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Doctrine guards — G5 · canonical ## Inherits form", () => {
  // One exact short form per loop kind. The old per-loop paraphrases of the
  // engine index drifted silently; the canonical string cannot.
  const DOC_LOOP_INHERITS =
    "Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **always before** these deltas. *(If `../` does not resolve: `CHASSIS.md` next to this file — global layout rule, chassis § Reference resolution.)*";
  const CODE_LOOP_INHERITS =
    "Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **and** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — the *code-editing loop policies* — **always before** these deltas. *(If `../` does not resolve: same names next to this file — global layout rule, chassis § Reference resolution.)*";
  const DOC_LOOPS = ["spec-refine-loop", "plan-new-loop", "plan-refine-loop"];
  const CODE_LOOPS = ["plan-exec-loop", "quick-loop"];

  it("document loops carry the exact canonical Inherits (chassis only)", async () => {
    for (const loop of DOC_LOOPS) {
      const text = await readRel(join("loops", loop, "LOOP.md"));
      expect(text, loop).toContain(DOC_LOOP_INHERITS);
      expect(text, loop).not.toContain("CODE-POLICIES.md");
    }
  });

  it("code loops carry the exact canonical Inherits (chassis + code policies)", async () => {
    for (const loop of CODE_LOOPS) {
      const text = await readRel(join("loops", loop, "LOOP.md"));
      expect(text, loop).toContain(CODE_LOOP_INHERITS);
    }
  });

  it("the global layout-resolution rule lives in the chassis (single source)", async () => {
    const chassis = await readRel(join("loops", "CHASSIS.md"));
    expect(chassis).toContain("Reference resolution");
    expect(chassis).toContain("w-<command>");
  });
});

describe("Doctrine guards — G6 · artifact contract (informe 003, wave 3)", () => {
  // The CHECKPOINT contract adopts the form real runs proved out; the chassis
  // pins who flips the Success criteria and forbids duplicated sections (the
  // 011-session append bug). The CLI session template and the schema doc must
  // agree — they are two renderings of the same artifact.
  it("the CHECKPOINT template carries the canonical headings and the no-duplicate rule", async () => {
    const tpl = await readRel(join("artifacts", "artifacts-core", "CHECKPOINT.md"));
    expect(tpl).toContain("## Completed");
    expect(tpl).toContain("## Pending / Next");
    expect(tpl).toContain("## Open questions");
    expect(tpl).toContain("NEVER duplicate");
  });

  it("the chassis pins the fixed-form rule and the criteria flip at the convergence gate", async () => {
    const chassis = await readRel(join("loops", "CHASSIS.md"));
    expect(chassis).toMatch(/duplicate heading/i);
    expect(chassis).toMatch(/flips the green criteria/i);
  });

  it("the CLI session template and the SESSION schema doc agree on headings", async () => {
    const { renderSessionMarkdown } = await import("../../src/application/templates/session.js");
    const rendered = renderSessionMarkdown({
      name: "x",
      type: "exec",
      objetivo: "y",
    });
    const schema = await readRel(join("artifacts", "artifacts-core", "SESSION.md"));
    const renderedHeadings = rendered
      .split(/\r?\n/)
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim());
    expect(renderedHeadings.length).toBeGreaterThan(0);
    for (const heading of renderedHeadings) {
      expect(schema, `schema doc missing ## ${heading}`).toContain(`## ${heading}`);
    }
    expect(rendered).toContain("flips each to [x]");
  });
});

describe("Doctrine guards — G7 · hard floor inline in the flow commands (informe 003, wave 6)", () => {
  // The empirical smoke (informe 003 § wave 5) proved the reference chain can
  // break at hop 2 on the weakest models: the loop gets read but the chassis
  // does not → no session, no CHECKPOINT, no canonical gate options, English
  // replies to Spanish users. The fix: every loop-trampoline command carries a
  // minimal, self-contained "hard floor" block (same pattern as the inline
  // git/DB summaries in the code-editing loops).
  const LOOP_COMMANDS = [
    "commands/quick.md",
    "commands/spec-refine.md",
    "commands/plan-new.md",
    "commands/plan-refine.md",
    "commands/plan-exec.md",
  ];

  it("every loop command carries the hard-floor block (session + language)", async () => {
    for (const rel of LOOP_COMMANDS) {
      const text = await readRel(rel);
      expect(text, rel).toContain("Hard floor — applies even if you read nothing beyond this file");
      expect(text, rel).toContain("aw session-create --type");
      expect(text, rel).toContain("user's language");
    }
  });

  it("quick's hard floor carries the gate's canonical options verbatim", async () => {
    const quick = await readRel("commands/quick.md");
    expect(quick).toContain("Cambiar a SPEC");
    expect(quick).toContain("Seguir en quick");
    expect(quick).toContain("Recortar alcance");
  });

  it("spec-new pins the user's-language rule for the draft content", async () => {
    const specNew = await readRel("commands/spec-new.md");
    expect(specNew).toContain("user's language");
  });
});

describe("Doctrine guards — G3 · language policy (English doctrine)", () => {
  // Post language-migration (informe 003, wave 2) the doctrine is English.
  // User-facing Spanish is allowed ONLY inside code fences (output templates,
  // examples, canonical labels) and inline code spans (`Compactar`, `Cerrar`,
  // `Guardar plan`, `▸ DESCARTÓ`, …). Any Spanish diacritic in bare prose is
  // a patchwork regression — the informe-003 problem #1 reborn.
  const SPANISH_MARKS = /[áéíóúñÁÉÍÓÚÑ¿¡]/;

  it("no Spanish diacritics outside code fences and inline code in skills/w/**.md", async () => {
    const targets: string[] = [join(SKILL_ROOT, "SKILL.md"), join(SKILL_ROOT, "README.md")];
    for (const sub of ["commands", "loops", "exports", "roles", "artifacts", "harness", "hooks"]) {
      targets.push(...(await listMdFiles(join(SKILL_ROOT, sub))));
    }
    const offenders: string[] = [];
    for (const file of targets) {
      const rel = file.slice(SKILL_ROOT.length + 1);
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      let fence = false;
      lines.forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) {
          fence = !fence;
          return;
        }
        if (fence) return;
        const bareProse = line.replace(/`[^`]*`/g, "");
        if (SPANISH_MARKS.test(bareProse)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
