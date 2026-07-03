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
        "loops/quick-loop/SKILL.md",
        "loops/CHASSIS.md",
        "loops/CODE-POLICIES.md",
      ],
      budget: 40_500,
    },
    {
      flow: "spec-refine",
      files: ["commands/spec-refine.md", "loops/spec-refine-loop/SKILL.md", "loops/CHASSIS.md"],
      budget: 35_500,
    },
    {
      flow: "plan-new",
      files: ["commands/plan-new.md", "loops/plan-new-loop/SKILL.md", "loops/CHASSIS.md"],
      budget: 33_000,
    },
    {
      flow: "plan-refine",
      files: [
        "commands/plan-refine.md",
        "loops/plan-refine-loop/SKILL.md",
        "loops/plan-new-loop/SKILL.md",
        "loops/CHASSIS.md",
      ],
      budget: 43_000,
    },
    {
      flow: "plan-exec",
      files: [
        "commands/plan-exec.md",
        "loops/plan-exec-loop/SKILL.md",
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
    return 650; // root SKILL.md · harness/SKILL.md
  }

  it("every description stays within its area budget", async () => {
    const rels: string[] = ["SKILL.md", join("harness", "SKILL.md")];
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
    "Leé **[`../CHASSIS.md`](../CHASSIS.md)** — el **motor completo** del loop — **siempre antes** de estos deltas. *(Si `../` no resuelve: `CHASSIS.md` junto a este archivo — regla global de layout, chasis § Resolución de referencias.)*";
  const CODE_LOOP_INHERITS =
    "Leé **[`../CHASSIS.md`](../CHASSIS.md)** — el **motor completo** del loop — **y** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — las *Políticas de loops que editan código* — **siempre antes** de estos deltas. *(Si `../` no resuelve: mismos nombres junto a este archivo — regla global de layout, chasis § Resolución de referencias.)*";
  const DOC_LOOPS = ["spec-refine-loop", "plan-new-loop", "plan-refine-loop"];
  const CODE_LOOPS = ["plan-exec-loop", "quick-loop"];

  it("document loops carry the exact canonical Inherits (chassis only)", async () => {
    for (const loop of DOC_LOOPS) {
      const text = await readRel(join("loops", loop, "SKILL.md"));
      expect(text, loop).toContain(DOC_LOOP_INHERITS);
      expect(text, loop).not.toContain("CODE-POLICIES.md");
    }
  });

  it("code loops carry the exact canonical Inherits (chassis + code policies)", async () => {
    for (const loop of CODE_LOOPS) {
      const text = await readRel(join("loops", loop, "SKILL.md"));
      expect(text, loop).toContain(CODE_LOOP_INHERITS);
    }
  });

  it("the global layout-resolution rule lives in the chassis (single source)", async () => {
    const chassis = await readRel(join("loops", "CHASSIS.md"));
    expect(chassis).toContain("Resolución de referencias");
    expect(chassis).toContain("w-<loop>");
  });
});
