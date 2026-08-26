import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContextBudgetOutput,
  runContextBudget,
} from "../../src/application/context/budget-service.js";
import { FLOW_DECISIONS, decisionsOfScope } from "../../src/domain/flow/authority.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

// Doctrine budget & form guards (informe 003 — weak-model clarity round).
// G1 pins the guaranteed per-flow load: adding doctrine to a hot-path file must
// either cut elsewhere or consciously raise the budget in this table. G2 stops
// the worst readability regressions (norm buried in giant prose). G4 caps the
// frontmatter descriptions (a permanent system-prompt tax on flatten hosts).
// G5 pins the canonical short `## Inherits` form — paraphrased engine summaries
// were the informe-002 drift factory reborn in miniature.
const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");
// Since plan 009 the CLI holds the reader half of the progress contracts:
// `status`/`resume` relay what it renders instead of re-interpreting JSON.
const SRC_ROOT = resolve(__dirname, "..", "..", "src", "application");
const readSrc = (name: string): Promise<string> => readFile(resolve(SRC_ROOT, name), "utf8");

async function readRel(rel: string): Promise<string> {
  return readFile(join(SKILL_ROOT, rel), "utf8");
}

/**
 * A document plus every module it points at — its whole doctrinal SURFACE.
 *
 * Since plan 010 a conditional branch lives in `modules/<NAME>.md` and its host
 * document carries a one-line pointer. A guard that pins a rule must follow that
 * pointer, or splitting a file would read as deleting the rule.
 *
 * Use this for what a surface must SAY. Keep `readRel` for what a file must NOT
 * say — separation is a property of the file, not of the surface.
 *
 * It is strictly stronger than the single-file read it replaces: deleting the
 * content fails, and so does deleting the pointer that reaches it.
 */
async function readSurface(rel: string): Promise<string> {
  const own = await readRel(rel);
  const parts = [own];
  for (const match of own.matchAll(/(?:\.\.\/)+modules\/([A-Z0-9-]+\.md)/g)) {
    const name = match[1];
    if (name === undefined) continue;
    try {
      parts.push(await readRel(join("modules", name)));
    } catch {
      // A pointer to a module this bundle does not carry is caught by the
      // manifest guard, not here.
    }
  }
  return parts.join("\n");
}

/**
 * The labels a migrated row emits, read from the registry.
 *
 * The PLAN cutover moved every offer's alternatives out of the Markdown and into
 * the row that emits them, so pinning them here still pins the product wording —
 * it just reads it where it now lives. Pinning the doc after the rule left would
 * have been pinning an echo.
 */
function labelsOf(id: string): string[] {
  const row = FLOW_DECISIONS.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el registro ya no tiene '${id}'`);
  return (row.alternatives ?? []).map((choice) => choice.label);
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

describe("Doctrine guards — G1 · context budget derived from a frozen baseline", () => {
  // G1 used to be a hand-written table of per-flow byte ceilings, and every
  // round that added doctrine re-approved itself by editing the number. That
  // is a ceiling, not a budget: it can only ever go up, it covered 6 flows and
  // not the 16 commands, and it said nothing about discovery.
  //
  // Since plan 010 the figures come from the measurement (`aw context-budget`)
  // over the bundle's own manifest, compared against tests/fixtures/
  // context-baseline.json — frozen, with the digest of the tree it measured.
  // Nothing here is typed by hand: the absolute targets are baseline x the
  // ratios in skills/w/context/MANIFEST.json. The raise history this comment
  // replaces lives in git, where a history belongs.
  //
  // It enforces the WHOLE policy: the round's reduction targets (-30%
  // discovery, -40% median activation, -20% per command, -25% median execution)
  // and the permanent +5% ceiling per journey and per command. One assertion
  // over every metric, because a budget that only checks the easy half is the
  // ceiling all over again.
  const BASELINE_PATH = resolve(__dirname, "..", "fixtures", "context-baseline.json");

  async function measure(): Promise<ContextBudgetOutput> {
    return runContextBudget(new NodeFileSystem(), {
      root: SKILL_ROOT,
      baselinePath: BASELINE_PATH,
    });
  }

  it("every metric is inside its derived budget", async () => {
    const result = await measure();
    expect(result.offenders).toEqual([]);
    expect(result.verdict).toBe("ok");
  });

  it("the three tramos hit the reductions spec 009 decided", async () => {
    const result = await measure();
    const line = (metric: string) => result.budget.find((b) => b.metric === metric);
    // Stated as ratios, not as figures: the absolutes come from the baseline.
    for (const [metric, ratio] of [
      ["discovery", 0.7],
      ["activation.median", 0.6],
      ["execution.median", 0.75],
    ] as const) {
      const entry = line(metric);
      expect(entry?.baseline, metric).toBeGreaterThan(0);
      expect(entry?.actual, metric).toBeLessThanOrEqual(Math.floor((entry?.baseline ?? 0) * ratio));
    }
  });

  it("every one of the 18 commands is at least 20% under its baseline", async () => {
    const result = await measure();
    const perCommand = result.budget.filter((line) => line.metric.startsWith("activation."));
    expect(perCommand.filter((l) => l.metric !== "activation.median")).toHaveLength(18);
    const offenders = perCommand
      .filter((line) => line.ok === false)
      .map((line) => `${line.metric}: ${line.actual} B > ${line.target} B`);
    expect(offenders).toEqual([]);
  });

  it("covers all 18 commands, not the 6 flows the retired table listed", async () => {
    const result = await measure();
    expect(result.guaranteed).toHaveLength(18);
    expect(result.budget.filter((l) => l.metric.startsWith("guaranteed."))).toHaveLength(18);
  });

  it("every journey the manifest declares is actually measured", async () => {
    const result = await measure();
    expect(result.execution.journeys.length).toBeGreaterThanOrEqual(6);
    expect(result.execution.journeys.every((j) => j.files.length > 0)).toBe(true);
  });

  it("no journey silently loses a document it declares", async () => {
    const result = await measure();
    const missing = result.execution.journeys.flatMap((journey) =>
      journey.files.filter((f) => f.missing).map((f) => `${journey.id} → ${f.path}`),
    );
    expect(missing).toEqual([]);
  });

  it("the baseline names the tree it was measured on", async () => {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
    expect(baseline.revision?.content_digest).toMatch(/^[0-9a-f]{16}$/);
    expect(baseline.revision?.file_count).toBeGreaterThan(40);
  });
});

describe("Doctrine guards — G9 · probe (PoC) + spec Scenarios pins", () => {
  // Pin the v20.8.0 concepts so a future compression pass cannot silently
  // drop the fourth resolver or desynchronize the draft/refined spec schemas.
  it("the chassis keeps § Proof of concept and the fourth resolver line", async () => {
    const chassis = await readSurface("loops/CHASSIS.md");
    expect(chassis).toContain("## Proof of concept (probe)");
    expect(chassis).toMatch(/research \*reads\*, a probe \*runs\*/);
    expect(chassis).toContain("RUNNING a small experiment");
  });

  it("the plan loops instantiate the probe (Delta 5 planning / Delta 7 execution)", async () => {
    const planNew = await readSurface("loops/plan-new-loop/LOOP.md");
    const planExec = await readSurface("loops/plan-exec-loop/LOOP.md");
    expect(planNew).toContain("## Delta 5 — Probe (PoC) tasks — de-risk early");
    expect(planExec).toContain("## Delta 7 — Probe (PoC) tasks");
  });

  it("spec draft and refined schemas agree on ## Scenarios (GIVEN/WHEN/THEN/AND)", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    const specRefine = await readSurface("loops/spec-refine-loop/LOOP.md");
    for (const doc of [specNew, specRefine]) {
      expect(doc).toContain("## Scenarios");
      expect(doc).toContain("GIVEN/WHEN/THEN/AND");
    }
    // Shared skeleton: both schemas carry the same criterion↔scenario anchor.
    expect(specNew).toContain("behavioral ones expand in ## Scenarios");
    expect(specRefine).toContain("behavioral ones expand in ## Scenarios");
  });
});

describe("Doctrine guards — G10 · minimality (anti-over-engineering) pins", () => {
  // Pin the minimality-gate round so a future compression pass cannot silently
  // drop the shared gate property or a heir's instantiation of the lens.
  it("the chassis keeps § Minimality as a shared gate property (bold subsection, not an H2)", async () => {
    const chassis = await readRel("loops/CHASSIS.md");
    expect(chassis).toContain("**Minimality (anti-over-engineering).**");
    expect(chassis).toContain("**necessary, not sufficient**");
    // Bold subsection under ## Verification-first, never an H2 (keeps chassis-consistency green).
    expect(chassis).not.toContain("## Minimality");
  });

  it("spec-refine instantiates the lens (over-specified gap + analyze gate)", async () => {
    const specRefine = await readRel("loops/spec-refine-loop/LOOP.md");
    expect(specRefine).toContain("Over-specified requirement");
    expect(specRefine).toContain("no gold-plating");
  });

  it("the plan loops instantiate the lens (over-engineered gap + coherence gate)", async () => {
    const planNew = await readRel("loops/plan-new-loop/LOOP.md");
    const planRefine = await readRel("loops/plan-refine-loop/LOOP.md");
    expect(planNew).toContain("Over-engineered solution");
    expect(planNew).toMatch(/minimality/i);
    expect(planRefine).toMatch(/minimality/i);
  });

  it("the closing review gate carries the minimality floor (holds with no external skill)", async () => {
    const codePolicies = await readRel("loops/CODE-POLICIES.md");
    expect(codePolicies).toContain("Minimality lens");
    for (const tag of ["`delete`", "`stdlib`", "`native`", "`yagni`", "`shrink`"]) {
      expect(codePolicies, tag).toContain(tag);
    }
  });
});

describe("Doctrine guards — G11 · creativity/ideation gate pins", () => {
  // Pin the creativity-gate round so a future compression pass cannot silently
  // drop the divergent gate, leak it into the shared chassis (spec-only tax),
  // or relax spec-new's single-pass web prohibition.
  it("spec-refine keeps the ideation gate (gap row + section + web-research consumer)", async () => {
    const specRefine = await readSurface("loops/spec-refine-loop/LOOP.md");
    expect(specRefine).toContain("## Ideation gate (creativity)");
    expect(specRefine).toContain("Unexplored solution space");
    expect(specRefine).toContain("web-research");
    // The offer's canonical labels were pinned here verbatim until the SPEC
    // cutover made them data of the row that emits them. They are still pinned —
    // against the source that now decides them, so the two cannot drift.
    const consent = decisionsOfScope("spec-refine").find(
      (decision) => decision.id === "spec-refine.ideation-consent",
    );
    expect((consent?.alternatives ?? []).map((choice) => choice.label)).toEqual([
      "Explorar ideas",
      "Seguir sin ideación",
    ]);
  });

  it("the harness declares web-research as an optional capability with a declared degrade", async () => {
    const harness = await readSurface("harness/HARNESS.md");
    expect(harness).toContain("**web-research**");
    expect(harness).toContain("web-research (consumer & consent)");
  });

  it("the chassis stays clean — the gate never migrates to the shared engine", async () => {
    const chassis = await readSurface("loops/CHASSIS.md");
    expect(chassis).not.toMatch(/web-research|ideation/i);
  });

  it("spec-new keeps its single-pass web prohibition", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("FORBIDDEN");
    expect(specNew).toContain("web searches");
  });
});

describe("Doctrine guards — G12 · split gates (multi-spec / multi-plan) pins", () => {
  // Pin the split-gate round so a future compression pass cannot silently drop
  // a gate, dilute its canonical labels, or leak it into the shared chassis.
  it("spec-new keeps the multi-spec split gate (section + labels + write ordering)", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("## Split gate (multi-spec)");
    expect(specNew).toContain("before writing anything");
    expect(specNew).toContain("NO RESEARCH");
    // Canonical product labels of the offer (G7 precedent: pin verbatim strings).
    expect(specNew).toContain("`Dividir en varias specs`");
    expect(specNew).toContain("`Una sola spec`");
  });

  it("the multi-spec gate stays scoped to raw prompts (escalation/adoption never re-ask)", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    const section = specNew.slice(specNew.indexOf("## Split gate (multi-spec)"));
    const gate = section.slice(0, section.indexOf("\n## "));
    expect(gate).toMatch(/escalat/i);
    expect(gate).toMatch(/adopt/i);
    expect(gate).toContain("nothing is written yet");
  });

  it("plan-new-loop defines the canonical multi-plan gate (gap row + partition + labels)", async () => {
    const planNew = await readSurface("loops/plan-new-loop/LOOP.md");
    expect(planNew).toContain("## Split gate (multi-plan)");
    expect(planNew).toContain("Plan splittable");
    expect(planNew).toMatch(/traces to \*\*exactly one\*\*/);
    expect(planNew).toMatch(/partition/i);
    // Amended by the PLAN cutover: the offer's labels are the row's now. The
    // single-plan branch still survives the split round — it is the option that
    // declines, and the registry is where that is now checkable.
    expect(labelsOf("plan-new.split-choice")).toEqual(["Dividir en varios planes", "Un solo plan"]);
    // The save is now ONE decision over a sealed proposal, so both branches —
    // one plan or N siblings — end at the same pair of labels. Two labels for
    // what is one write was the second question this phase removed.
    expect(labelsOf("plan-new.save-confirmation")).toEqual(["Aprobar y guardar", "Refinar"]);
  });

  it("plan-refine-loop adds only the refine semantics (original keeps path; [x] anchored)", async () => {
    const planRefine = await readSurface("loops/plan-refine-loop/LOOP.md");
    expect(planRefine).toContain("## Split gate — refine semantics");
    expect(planRefine).toContain("keeps its number/path");
    expect(planRefine).toContain("Completed tasks (`- [x]`) never move to a sibling");
    // And the split branch is a condition on the CONTENT, not a second question:
    // the extracted siblings travel in the same proposal as the reduced original,
    // so one preview and one approval cover the whole write.
    expect(labelsOf("plan-refine.save-confirmation")).toEqual(["Aprobar y guardar", "Refinar"]);
  });

  it("the chassis stays clean — the split gates never migrate to the shared engine", async () => {
    const chassis = await readSurface("loops/CHASSIS.md");
    expect(chassis).not.toMatch(/split gate|multi-spec|multi-plan|Dividir/i);
  });
});

describe("Doctrine guards — G13 · tooling gate (docs/tools) pins", () => {
  // Pin the tooling-gate round: the closing review gate must keep steering
  // reusable auxiliary tooling to docs/tools (the family-rag silent-miss
  // lesson — spec 007), and the orientation must keep the human-findable
  // pointer. The ambient framing is part of the pin: no binding verb or plugin
  // coupling in the gate; the degraded path defers (declared gap), it never has
  // the loop write docs/tools itself (invariant 2).
  it("CODE-POLICIES' closing review gate carries the Tooling check (ambient framing + declared-gap degradation)", async () => {
    const policies = await readRel("loops/CODE-POLICIES.md");
    const section = policies.slice(policies.indexOf("## Closing review gate"));
    const gate = section.slice(0, section.indexOf("\n## "));
    expect(gate).toContain("**Tooling check**");
    expect(gate).toContain("`creating-tools`");
    expect(gate).toContain("auto-discovered");
    expect(gate).toContain("docs/tools/<slug>/");
    expect(gate).toContain("never writes `docs/tools` itself");
    expect(gate).toContain("declare the gap");
    // The gate stays unbound — orientation does not name a required plugin.
    expect(gate).not.toContain("tool-builder@");
  });

  it("the w orientation keeps the user-findable Tools pointer (skill + gate reference)", async () => {
    const skill = await readRel("SKILL.md");
    const pointer = skill.split("\n").find((l) => l.includes("**Tools pointer:**")) ?? "";
    expect(pointer).toContain("`creating-tools`");
    expect(pointer).toContain("may be installed independently");
    expect(pointer).toContain("Closing review gate");
    expect(pointer).toContain("does **not** depend");
  });
});

describe("Doctrine guards — G14 · artifact-slim (single trace, consolidated plan, bounded exec residue) pins", () => {
  // Pin the artifact-slim round so a future compression pass cannot silently
  // resurrect the removed duplication (two-notation traces, 4x delta
  // narration, Phases table, exec residue) or drop the new hard rules.
  /**
   * The `## Delta 1 …` section of plan-new-loop, up to `## Delta 2` (the
   * schema's fenced block carries `## <section>` lines of its own, so a
   * generic next-`## ` cut would stop inside the fence).
   */
  async function planNewDelta1(): Promise<string> {
    const planNew = await readRel("loops/plan-new-loop/LOOP.md");
    const start = planNew.indexOf("## Delta 1");
    const end = planNew.indexOf("## Delta 2");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return planNew.slice(start, end);
  }

  it("each refine loop keeps ONE trace section — spec `## Decisions`, plan `## Refinement decisions`", async () => {
    const specRefine = await readRel("loops/spec-refine-loop/LOOP.md");
    const planRefine = await readRel("loops/plan-refine-loop/LOOP.md");
    // Ready-for-plan round: the spec's trace became contract, not transcript.
    expect(specRefine).toContain("**`## Decisions` is contract, not expedient.**");
    expect(specRefine).toContain("Not** a `Q:` transcript");
    // The Q&A notation survives where it IS still audit trace: plan-refine.
    expect(planRefine).toContain("Q: <question> → <chosen answer> — <rationale>");
    // The naming asymmetry is declared, never accidental.
    expect(specRefine).toMatch(/plan-refine's audit trace/);
    // Legacy specs must keep counting as ready.
    expect(specRefine).toMatch(/`## Q&A traceability`.*still count as ready/i);
  });

  it("Scenarios never restate a criterion 1:1 (draft and refined schemas agree)", async () => {
    const specNew = await readRel("commands/spec-new.md");
    const specRefine = await readRel("loops/spec-refine-loop/LOOP.md");
    expect(specNew).toContain("**never restate a criterion 1:1**");
    expect(specRefine).toContain("NEVER a 1:1 restatement");
  });

  it("plan-new's Delta 1 schema is consolidated — no Summary/AS-IS/TO-BE/Final behavior/Phases/Estimated time sections", async () => {
    const delta1 = await planNewDelta1();
    for (const gone of [
      "## Summary",
      "## Current state",
      "## Target state",
      "## Final behavior",
      "## Phases",
      "## Estimated time",
      "## Q&A traceability",
    ]) {
      expect(delta1, `${gone} must not survive in the Delta 1 schema`).not.toContain(gone);
    }
    // The absorbed blocks live inside Solution/Tasks.
    expect(delta1).toContain("AS-IS → TO-BE");
    expect(delta1).toContain('"Final behavior" block');
    expect(delta1).toContain("### Fn");
    expect(delta1).toContain("ONLY source of phases");
    expect(delta1).toContain("OMIT the section when empty");
  });

  it("plan-exec keeps the plan-doc residue rule and the single done-status line", async () => {
    // Renamed from "Checkbox-only residue" by the functional-phases round: the
    // rule now admits a fourth write (the phase's own `> Estado:` line), so the
    // old name was no longer true. The bound itself is what G14 protects.
    // The normalization round splits the closure mark in two lines (bare value
    // + `> Cierre:`), so the pin follows the value, not the old single-line form.
    const planExec = await readRel("loops/plan-exec-loop/LOOP.md");
    expect(planExec).toContain("**Plan-doc residue (hard rule):**");
    expect(planExec).not.toContain("**Checkbox-only residue (hard rule):**");
    expect(planExec).toContain("NEVER append a duplicate `### Fn` block");
    expect(planExec).toContain("**Marking done = ONE status line in the plan-doc**");
    expect(planExec).toContain("> Estado: done");
    expect(planExec).toContain("> Cierre: YYYY-MM-DD · sesión NNN");
  });

  it("the residue rule carves out the Open-questions deferrals, the phase state and its blocker line", async () => {
    // The hard rule must not contradict the loop's own degrade/defer path
    // (Delta 4 unapplied migration · Delta 5 deferred finding · Delta 7 failed
    // probe all write the plan's `## Open questions`) nor the phase state the
    // functional-phases round made machine-readable. The correction round adds
    // the fifth write: the `> Bloqueo:` line that keeps the reason OFF the
    // machine state line.
    const planExec = await readRel("loops/plan-exec-loop/LOOP.md");
    const rule = planExec.slice(planExec.indexOf("**Plan-doc residue (hard rule):**"));
    const sentence = rule.slice(0, rule.indexOf("\n"));
    expect(sentence).toContain("## Open questions");
    expect(sentence).toMatch(/deferral/i);
    expect(sentence).toContain("> Estado:");
    expect(sentence).toContain("> Bloqueo:");
    expect(sentence).toMatch(/five things/);
  });

  it("the schemas that dropped ## Q&A traceability cannot resurrect it", async () => {
    // Negative pins where the section actually lived (the plan-new Delta 1 pin
    // above covers neither). Scoped to the fenced SCHEMA block: the surrounding
    // prose names `## Q&A traceability` on purpose (legacy tolerance note).
    const fencedSchema = (doc: string, from: string, to: string): string => {
      const section = doc.slice(doc.indexOf(from), doc.indexOf(to));
      const open = section.indexOf("```markdown");
      const close = section.indexOf("```", open + 3);
      expect(open, `${from}: fenced schema block`).toBeGreaterThan(-1);
      return section.slice(open, close);
    };

    const specRefine = await readRel("loops/spec-refine-loop/LOOP.md");
    const refinedSchema = fencedSchema(specRefine, "## Deliverable schema", "## Gap taxonomy");
    expect(refinedSchema).not.toContain("## Q&A traceability");
    // Ready-for-plan round: the spec's trace is `## Decisions`. The old heading
    // survives ONLY in the surrounding legacy-compat prose, never in the schema.
    expect(refinedSchema).not.toContain("## Refinement decisions");
    expect(refinedSchema).toContain("## Decisions");

    const planRefine = await readRel("loops/plan-refine-loop/LOOP.md");
    const planRefineDelta1 = fencedSchema(planRefine, "## Delta 1", "## Delta 2");
    expect(planRefineDelta1).not.toContain("## Q&A traceability");
    expect(planRefineDelta1).toContain("## Refinement decisions");
  });

  it("BACKLOG keeps ## Deferred (aw status parses it) and never regrows ## Followups", async () => {
    const backlog = await readRel(join("artifacts", "artifacts-core", "BACKLOG.md"));
    expect(backlog).toContain("## Deferred");
    expect(backlog).not.toContain("## Followups");
  });
});

describe("Doctrine guards — G15 · bounded reconnaissance pins", () => {
  // Pin the reconnaissance round so a future compression pass cannot silently
  // drop the pass, un-order it against the split gate, or turn the ceiling back
  // into the old blanket prohibition. The ORDER is the whole point: looking
  // after deciding the cut would be theater.
  it("spec-new carries the reconnaissance section and its bounded contract", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("## Bounded reconnaissance");
    expect(specNew).toContain("BOUNDED RECONNAISSANCE, NO DEEP RESEARCH");
    expect(specNew).toContain("**Budget: ≤5 reads + ≤3 searches.**");
    expect(specNew).toContain("**cap, never a target**");
    expect(specNew).toContain("**Stop at the first of these:**");
    // The web prohibition survives the reframing (G11 guards it too).
    expect(specNew).toContain("web searches");
  });

  it("the reconnaissance runs BEFORE the split gate", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    const recon = specNew.indexOf("## Bounded reconnaissance");
    const gate = specNew.indexOf("## Split gate (multi-spec)");
    expect(recon).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(recon);
    expect(specNew).toContain("Right after the reconnaissance");
  });

  it("the cut follows functional independence — technical boundaries are secondary evidence", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("refined, accepted and planned on its own");
    expect(specNew).toContain("**secondary evidence**");
  });

  it("thin evidence degrades to a single spec, never to a speculative split", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("justify a speculative cut");
    expect(specNew).toContain("**one spec, no question**");
  });

  it("the scope hypothesis stays internal (no artifact, no new spec section)", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("**reasoning, not an artifact**");
    expect(specNew).not.toContain("## Scope hypothesis");
  });

  it("the findings have declared landing sites (Context anchored, Scope untouched)", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("**at most one path per component**");
    expect(specNew).toContain("**The code found never widens `Scope`**");
    expect(specNew).toContain("**acceptance criteria derive from the user's intent**");
  });

  it("the pass never migrates to the shared engine", async () => {
    const chassis = await readSurface("loops/CHASSIS.md");
    expect(chassis).not.toMatch(/bounded reconnaissance/i);
  });
});

describe("Doctrine guards — G16 · ready-for-plan (SPEC contract) pins", () => {
  // Pin the OpenSpec-inspired round. The regression this guards against is a
  // silent return to "close every gap": the convergence target watered down,
  // the destination axis dropped so PLAN-owned questions block again, ideation
  // back to a universal gap, or the maturity mark sliding back from machine
  // state into a narrative section. The correction round adds the third shape
  // of the change-shape gate: `replace`, with an offer of its own.
  const LOOP = "loops/spec-refine-loop/LOOP.md";

  /** A bolded lead-in and the prose that follows it, up to the next `## ` heading. */
  function section(doc: string, lead: string): string {
    const start = doc.indexOf(lead);
    expect(start, lead).toBeGreaterThan(-1);
    const rest = doc.slice(start);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("spec-refine declares the convergence target verbatim", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain("## Convergence target");
    expect(loop).toContain("READY FOR PLAN, NOT PERFECTLY CLOSED");
    expect(loop).toContain("without inventing functional decisions");
  });

  it("the taxonomy classifies by destination, and PLAN-owned questions never fail the gate", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain("## Gap taxonomy — signal, resolver, destination");
    expect(loop).toContain("classified by destination before its resolver is chosen");
    expect(loop).toContain("declare, never close here");
    expect(loop).toContain("**never** fails the gate");
  });

  it("the phases stay ordered: baseline → change-shape → taxonomy", async () => {
    // The order is the point: judging the shape after closing the details would
    // mean re-litigating a contract already hardened around the wrong cut.
    //
    // Anchored on the loop's `## Sequence` rather than on where the sections sit
    // in the file. Since plan 010 the change-shape gate is a module, so section
    // position stopped meaning execution order — the sequence never did.
    const loop = await readSurface(LOOP);
    const sequence = loop.slice(loop.indexOf("## Sequence"));
    const baseline = sequence.indexOf("baseline = resolve_current_behavior");
    expect(baseline).toBeGreaterThan(-1);
    // The order used to be read off two lines of the pseudo-code. Since the SPEC
    // cutover the journey decides it, so that is where it is asserted: judging the
    // shape after closing details would re-litigate a contract already hardened
    // around the wrong cut.
    const ids = decisionsOfScope("spec-refine").map((decision) => decision.id);
    expect(ids.indexOf("spec-refine.baseline-scope")).toBeGreaterThan(-1);
    expect(ids.indexOf("spec-refine.change-shape-gate")).toBeGreaterThan(
      ids.indexOf("spec-refine.baseline-scope"),
    );
    expect(ids.indexOf("spec-refine.gap-recognition")).toBeGreaterThan(
      ids.indexOf("spec-refine.change-shape-gate"),
    );
    // The three sections still exist somewhere on the surface…
    expect(loop).toContain("## Current-behavior baseline");
    expect(loop).toContain("## Change-shape gate");
    expect(loop).toContain("## Gap taxonomy");
    // …and the loop still says WHY the order is what it is, which is the half the
    // document keeps: the shape is judged before the details harden.
  });

  it("the baseline is bounded (brownfield only, stops at the functional change)", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain(
      "**Stop when the baseline is enough to state and accept the functional change**",
    );
    expect(loop).toContain("not when the system is documented");
    expect(loop).toContain("Greenfield has no baseline");
  });

  it("ideation is conditional — triggers AND non-triggers are both declared", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain("**Unexplored solution space is not a universal gap**");
    expect(loop).toContain("**Triggers.**");
    expect(loop).toContain("**Not triggers.**");
    expect(loop).toContain("Purely technical alternatives belong to `PLAN`");
  });

  it("the change-shape gate reuses spec-new's split criterion and splits in place", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain("never a different one");
    expect(loop).toContain("keeps its number/path");
    expect(loop).toContain("`Guardar specs`");
    // Siblings are born drafts: the run keeps refining the reduced original.
    expect(loop).toContain("born **`status: draft`**");
  });

  it("the gate has three shapes, and `replace` never borrows the split question", async () => {
    // Correction round: `split` and `replace` used to share one offer, so the
    // question asked about cardinality when what changed was the purpose.
    const loop = await readSurface(LOOP);
    expect(loop).toContain("`same` | `split` | `replace`");
    expect(loop).toContain("**Replace semantics.**");
    const replace = section(loop, "**Replace semantics.**");
    expect(replace).toContain("`Crear una nueva spec`");
    expect(replace).toContain("`Reformular esta spec`");
    expect(replace).toContain("**never** the split labels");
    expect(replace).not.toContain("Dividir en varias specs");
  });

  it("a replacement mints a draft with its origin, and reformulating re-runs the gate", async () => {
    const replace = section(await readSurface(LOOP), "**Replace semantics.**");
    expect(replace).toContain("born **`status: draft`**");
    expect(replace).toContain("`## Origin` recording the origin spec");
    // Reformulating keeps the identity but never inherits the old approval.
    expect(replace).toContain("the *ready-for-plan gate* run again");
    expect(replace).toContain("stamped only on the save that follows the passing gate");
  });

  it("the round adds no archival state — `superseded` stays out of the vocabulary", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain("Neither branch adds a `superseded` status");
    expect(loop).not.toContain("status: superseded");
  });

  it("the maturity mark is machine state, tolerant of legacy and never a gate bypass", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain("It is machine state, never prose");
    expect(loop).toContain("A legacy mark does NOT skip the gate on a re-refine");
    // The rename never leaves a spec with no mark at all.
    expect(loop).toContain("in the same write that stamps `status`");
  });

  it("`refining` is read but never written — no partial spec writes", async () => {
    const loop = await readSurface(LOOP);
    expect(loop).toContain("this loop never writes a partial spec");
    expect(loop).toMatch(/`refining` is understood \*\*on read\*\*/);
  });

  it("the SPEC gate never migrates to the shared engine", async () => {
    const chassis = await readSurface("loops/CHASSIS.md");
    expect(chassis).not.toMatch(/ready-for-plan|change-shape/i);
    // The engine names no heir's own sections anymore — each heir declares them.
    expect(chassis).not.toContain("in the refine loops");
  });
});

describe("Doctrine guards — G17 · functional phases (PLAN contract) pins", () => {
  // Pin the functional-phases round. The regression this guards against is a
  // quiet slide back to "a plan is a task list": the phase contract redefined
  // per loop instead of referenced once, the mechanical XS/S criterion back as
  // the gate, `validada` inferred from the checkboxes again, a simulation left
  // with no retirement, or the deviation gate migrating into the shared engine
  // so all five flows pay for a PLAN-only rule.
  // The correction round closes the escape hatch the first one left open: an
  // annotated `validada — SQL pendiente de aplicar` let a phase whose proof
  // nobody ran count as demonstrated, which is the same inference the round
  // exists to forbid, wearing a suffix.
  const PLAN_NEW = "loops/plan-new-loop/LOOP.md";
  const PLAN_REFINE = "loops/plan-refine-loop/LOOP.md";
  const PLAN_EXEC = "loops/plan-exec-loop/LOOP.md";

  /** The `## Phase contract (canonical)` section, up to the next `## ` heading. */
  async function phaseContract(): Promise<string> {
    const planNew = await readSurface(PLAN_NEW);
    const start = planNew.indexOf("## Phase contract (canonical)");
    expect(start).toBeGreaterThan(-1);
    const rest = planNew.slice(start);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("plan-new owns the canonical contract: a phase is a verifiable state, not a list of layers", async () => {
    const contract = await phaseContract();
    expect(contract).toContain("**verifiable state of the system**");
    expect(contract).toContain("never a list of layers, files or classes");
    for (const section of [
      "`Resultado`",
      "`Trabajo`",
      "`Validaci\u00f3n de fase`",
      "`Condici\u00f3n de salida`",
    ]) {
      expect(contract, section).toContain(section);
    }
  });

  it("the phase state is machine state, and `validada` never follows from the checkboxes", async () => {
    const contract = await phaseContract();
    expect(contract).toContain("**Phase state = machine state.**");
    expect(contract).toContain("> Estado: <value>");
    expect(contract).toContain("**Never** because all its checkboxes are ticked.");
    // Additive by design: the round adds a signal, it does not replace progress.
    expect(contract).toContain("**alongside \u2014 not instead of \u2014**");
    expect(contract).toContain("nothing is back-filled");
    // Nor from a validation that was merely declared: it has to have run.
    expect(contract).toContain("its validation **ran and passed**");
  });

  it("the state line carries a bare value \u2014 the reason lives on its own line", async () => {
    // The parser reads the value as an exact match, so an annotation does not
    // qualify a state, it destroys it. Doctrine and runtime say the same thing.
    const contract = await phaseContract();
    expect(contract).toContain("**The state line carries its value alone**");
    expect(contract).toContain("an annotated value reads as `pendiente`");
    expect(contract).toContain("> Bloqueo: <reason>");

    const { parsePhases } = await import("../../src/application/parsers/phases.js");
    const annotated = [
      "## Tasks",
      "### F1 \u2014 El esquema soporta el cup\u00f3n",
      "> Estado: validada \u2014 SQL pendiente de aplicar",
      "> Bloqueo: falta aplicar la migraci\u00f3n.",
      "- [x] T1.1",
    ].join("\n");
    expect(parsePhases(annotated)).toMatchObject({ total: 1, validated: 0 });
  });

  it("a proof nobody could run leaves the phase `bloqueada`, and the plan open", async () => {
    const exec = await readSurface(PLAN_EXEC);
    expect(exec).toContain("**stays `bloqueada`**");
    expect(exec).toContain("A deferred check never counts as a passed one");
    expect(exec).toContain("a blocker is never deferred into `validada`");
    // The offer's condition is the journey's ORDER now: nothing can stamp `done`
    // without having come through the final validation, and that validation is a
    // delegated action, so it cannot be passed with a narration.
    expect(exec).toContain("final validation passed** unlocks completion");
    const plan = FLOW_DECISIONS.filter((row) => row.scope === "plan-exec").map((row) => row.id);
    expect(plan.indexOf("plan-exec.plan-done")).toBeGreaterThan(
      plan.indexOf("plan-exec.final-validation"),
    );
    // The old escape hatch cannot come back anywhere in the bundle.
    for (const file of await listMdFiles(SKILL_ROOT)) {
      const rel = file.slice(SKILL_ROOT.length + 1);
      const text = await readFile(file, "utf8");
      expect(text, rel).not.toContain("SQL pendiente de aplicar");
      expect(text, rel).not.toContain("SQL pending application");
    }
  });

  it("execution owns progress, refinement owns structure \u2014 stated, not implied", async () => {
    // plan-refine used to claim the plan "never mutates by execution" while
    // plan-exec flipped checkboxes and phase states in it. The frontier is the
    // fix: not WHETHER execution writes, but WHAT it is allowed to write.
    const refine = await readSurface(PLAN_REFINE);
    expect(refine).toContain("**Execution updates progress; refinement changes structure.**");
    expect(refine).not.toContain("never mutates by execution");
    for (const owned of ["contracts", "phase shape or order", "simulation boundaries"]) {
      expect(refine, owned).toContain(owned);
    }
    expect(refine).toContain("belongs to `spec-refine`");
  });

  it("runtime and doctrine share one vocabulary (the code\u2194doctrine drift class)", async () => {
    const { PHASE_STATES } = await import("../../src/application/parsers/phases.js");
    expect(PHASE_STATES).toEqual(["pendiente", "en ejecuci\u00f3n", "bloqueada", "validada"]);
    const contract = await phaseContract();
    for (const state of PHASE_STATES) {
      expect(contract, state).toContain(`\`${state}\``);
    }
  });

  it("the other two plan loops reference the contract and never redefine it", async () => {
    const refine = await readSurface(PLAN_REFINE);
    const exec = await readSurface(PLAN_EXEC);
    for (const [name, doc] of [
      ["plan-refine", refine],
      ["plan-exec", exec],
    ] as const) {
      expect(doc, name).toContain("Phase contract (canonical)");
      expect(doc, name).not.toContain("\n## Phase contract");
    }
    expect(refine).toContain("**applies** it and never redefines it");
    expect(exec).toContain("it never redefines it");
  });

  it("granularity is semantic \u2014 the mechanical complexity criterion is gone", async () => {
    const planNew = await readSurface(PLAN_NEW);
    expect(planNew).not.toContain("complexity > S");
    expect(planNew).not.toContain("complexity > XS");
    const contract = await phaseContract();
    expect(contract).toContain("**Granularity is semantic, not mechanical.**");
    expect(contract).toContain("**micro step**");
  });

  it("the reference sequence stays a reference, never a mandatory shape", async () => {
    // The design's whole point: adapt to the real architecture (backend-only,
    // CLI, batch, library, DB-only) instead of inventing layers to fill a template.
    const planNew = await readSurface(PLAN_NEW);
    expect(planNew).toContain("## Incremental strategy (reference, never a template)");
    expect(planNew).toContain("Reference to adapt, never a mandatory shape.");
  });

  it("plan-refine converges on an executable plan and plan-exec re-checks it on entry", async () => {
    const refine = await readSurface(PLAN_REFINE);
    const exec = await readSurface(PLAN_EXEC);
    expect(refine).toContain("## Objective \u2014 an executable sequence of functional states");
    expect(refine).toContain("## Executability gate");
    expect(refine).toContain("without inventing");
    expect(exec).toContain("## Entry gate \u2014 executability");
    expect(exec).toContain("no longer accepts in silence");
    // Near-executable normalizes WITH consent; a structural gap goes back. Both
    // labels moved to the row that emits them, and the doc keeps what each gap IS.
    expect(exec).toContain("**Minor gap**");
    expect(exec).toContain("**Structural gap**");
    expect(labelsOf("plan-exec.normalization-consent")).toEqual([
      "Normalizar y ejecutar",
      "Ir a plan-refine",
    ]);
  });

  it("the deviation gate lives only in plan-exec, with its four destinations", async () => {
    const exec = await readSurface(PLAN_EXEC);
    expect(exec).toContain("## Deviation gate");
    expect(exec).toContain("**Marking order (hard rule):**");
    expect(exec).toContain("**Local decision \u2014 `plan-exec` continues.**");
    expect(exec).toContain(
      "**Composable decision \u2014 a note is registered and execution continues.**",
    );
    expect(exec).toContain("**Structural deviation \u2014 stop and return to `plan-refine`.**");
    expect(exec).toContain("**Functional change \u2014 return to `spec-refine`.**");
    expect(exec).toContain("This gate lives **only** in this loop");
    // Eligibility is CLOSURE, never size: the sentence that keeps a count from
    // ever becoming the threshold.
    expect(exec).toContain("**Eligibility is closure, never size.**");
    // And an escalation never leaves empty-handed.
    expect(exec).toContain("**escalation package**");
    expect(exec).toContain("declares that it consumed it");
    // A structural deviation cannot be absorbed by a DECISION entry.
    const decision = await readSurface(join("artifacts", "artifacts-exec", "DECISION.md"));
    expect(decision).toContain("**Local decisions only.**");
    expect(decision).toContain("Deviation gate");
  });

  it("the temporary simulation has a declared lifecycle and a retirement gate", async () => {
    const refine = await readSurface(PLAN_REFINE);
    expect(refine).toContain("## Simulation lifecycle");
    expect(refine).toContain("**Displacement rule**");
    expect(refine).toContain("**Removal gate**");
    const policies = await readSurface("loops/CODE-POLICIES.md");
    expect(policies).toContain("**Temporary simulation check**");
    expect(policies).toContain("no configuration can select them in a production runtime");
    // …and the lifecycle only exists when there is something to retire.
    expect(refine).toContain(
      "**This section applies only when the journey introduces temporary behavior**",
    );
  });

  it("evidence is chosen by behavior, and over-testing is a finding, not an auto-rejection", async () => {
    const policies = await readSurface("loops/CODE-POLICIES.md");
    expect(policies).toContain("**Test-value lens**");
    expect(policies).toContain("`overtest`");
    expect(policies).toContain("prunes redundancy");
    const refine = await readSurface(PLAN_REFINE);
    const exec = await readSurface(PLAN_EXEC);
    expect(refine).toContain("## Evidence by behavior");
    expect(refine).toContain("**Necessity gate**");
    expect(exec).toContain("never an automatic rejection");
  });

  it("the model never migrates to the shared engine \u2014 only PLAN pays for it", async () => {
    const chassis = await readSurface("loops/CHASSIS.md");
    expect(chassis).not.toMatch(/deviation gate|phase contract|executability/i);
    expect(chassis).not.toContain("> Estado:");
  });
});

describe("Doctrine guards — G18 · normalization round (three axes · shape-first · conditional blocks)", () => {
  // Pin the normalization round. Three regressions it guards against, each one
  // observed in the audited baseline:
  //   1. the plan's closure collapsing back into the phase counters, so a plan
  //      whose phases are all green reads "finished" before anyone validated it;
  //   2. the change-shape decision travelling in `pending_human` — the batch
  //      that gets rebuilt every iteration — so a split nobody could re-derive
  //      was silently dropped between rounds;
  //   3. the conditional blocks presented as required, which is what pushed the
  //      agent to invent a stub so the plan would match the template.
  const PLAN_NEW = "loops/plan-new-loop/LOOP.md";
  const PLAN_EXEC = "loops/plan-exec-loop/LOOP.md";
  const SPEC_REFINE = "loops/spec-refine-loop/LOOP.md";

  /** The `## Phase contract (canonical)` section, up to the next `## ` heading. */
  async function phaseContract(): Promise<string> {
    const planNew = await readSurface(PLAN_NEW);
    const start = planNew.indexOf("## Phase contract (canonical)");
    const rest = planNew.slice(start);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("the plan carries a state of its own, distinct from the phase marks", async () => {
    const contract = await phaseContract();
    expect(contract).toContain("**The plan carries its own state, and it is a different axis.**");
    expect(contract).toContain("`open` | `done`");
    expect(contract).toContain("> Cierre: YYYY-MM-DD · sesión NNN");
    // Position is the discriminator; one rule for both marks would let a
    // validated first phase close the plan.
    expect(contract).toContain("Position disambiguates the two marks");
  });

  it("doctrine and runtime agree on the plan-level vocabulary", async () => {
    const { PLAN_DECLARED_STATES } = await import("../../src/application/parsers/plan-status.js");
    expect(PLAN_DECLARED_STATES).toEqual(["open", "done"]);
    const contract = await phaseContract();
    for (const state of PLAN_DECLARED_STATES) {
      expect(contract, state).toContain(`\`${state}\``);
    }
  });

  it("the three axes are declared on every surface that reports progress", async () => {
    const skill = await readSurface("SKILL.md");
    expect(skill).toContain("Three axes");
    expect(skill).toContain("plan_state");
    // The reporting surface is the CLI now: `status` renders it and the index
    // derives it, so the three axes have to stay separable THERE.
    const index = await readSrc("workline-index-service.ts");
    expect(index).toContain("the plan's third axis");
    expect(index).toContain("final_validation_pending");
    expect(index).toContain("`inconsistent` = the document contradicts itself");
  });

  it("plan-exec keeps the plan open until the final validation, never from the counters", async () => {
    const exec = await readSurface(PLAN_EXEC);
    expect(exec).toContain("Every phase `validada` is **not** the plan closed");
    expect(exec).toContain("never write `done` from the counters");
    // Reading the legacy one-line form is compatibility; writing it is not.
    expect(exec).toContain("**Legacy status line, migrated on write.**");
  });

  it("a blocked phase must state its reason, and the next step is the unblocking action", async () => {
    const exec = await readSurface(PLAN_EXEC);
    expect(exec).toContain("**A blocker without a reason is not a blocker (hard rule).**");
    expect(exec).toContain("`blocker: null`");
    expect(exec).toContain("names **the action that unblocks it**");
    // The reader has to render the reason, not just count the phase — and there is
    // exactly ONE reader deriving it now, which is why the string is pinned in the
    // shared projection rather than in the command that consumes it.
    const index = await readSrc("workline-index-service.ts");
    expect(index).toContain("blocked_phases");
    expect(index).toContain("`null` on a legacy block that declares none");
    expect(index).toContain('blocked.blocker ?? "sin motivo declarado"');
    expect(await readSrc("resume-service.ts")).not.toContain("sin motivo declarado");
  });

  it("the shape decision is resolved before the gap loop and never stored in pending_human", async () => {
    const loop = await readSurface(SPEC_REFINE);
    // Both sections still exist on the surface; their ORDER is asserted on the
    // sequence below, which is where execution order actually lives now that
    // the gate is a module.
    expect(loop).toContain("## Change-shape gate");
    expect(loop).toContain("## Gap taxonomy");
    // WHEN it runs stopped being this document's call at the SPEC cutover; what
    // the document keeps is why it matters, and the engine keeps the order.
    expect(loop).toContain("is not this document's call");
    expect(loop).toContain("erased by the next batch");
    const ids = decisionsOfScope("spec-refine").map((decision) => decision.id);
    expect(ids.indexOf("spec-refine.change-shape-gate")).toBeLessThan(
      ids.indexOf("spec-refine.gap-recognition"),
    );

    // The sequence must still show the shape branch BEFORE the `repeat:` that
    // rebuilds `pending_human`, or the prose is aspirational.
    const sequence = loop.slice(loop.indexOf("## Sequence"));
    const resolve = sequence.indexOf("on the shape branch");
    const repeat = sequence.indexOf("\n  repeat:");
    const reset = sequence.indexOf("pending_human = []");
    expect(resolve).toBeGreaterThan(-1);
    expect(repeat).toBeGreaterThan(resolve);
    expect(reset).toBeGreaterThan(repeat);
  });

  it("split and replace keep separate offers, and a way out that writes nothing", async () => {
    const loop = await readSurface(SPEC_REFINE);
    expect(loop).toContain("**Every branch has a way out that changes nothing.**");
    expect(loop).toContain("`Cerrar` closes the run **without applying the shape change**");
    // The command surface must state the asymmetry the loop implements.
    const command = await readSurface("commands/spec-refine.md");
    expect(command).toContain("## The two shape branches are not the same question");
    // Split's offer is the registry's now — the closing tranche migrated the three
    // rows behind it — so its labels are pinned where they live, exactly as PLAN's
    // are. Replace's are still the document's: no row emits them.
    expect(labelsOf("spec-refine.split-choice")).toEqual([
      "Dividir en varias specs",
      "Una sola spec",
    ]);
    expect(command).toContain("`Crear una nueva spec`");
    expect(command).toContain("`Reformular esta spec`");
    expect(command).toContain("**no new file**");
  });

  it("only the branches that create a file say they create one", async () => {
    const loop = await readSurface(SPEC_REFINE);
    expect(loop).toContain("**Not every shape decision creates a file**");
    // The index must describe the same possible writes.
    const index = await readSurface("loops/README.md");
    expect(index).toContain("**A single run may write several documents.**");
    expect(index).toContain("sibling specs");
    expect(index).toContain("sibling plans");
    expect(index).toContain("`Reformular esta spec`");
  });

  it("the conditional phase blocks are declared conditional wherever they are demanded", async () => {
    const contract = await phaseContract();
    expect(contract).toContain("**Required**");
    expect(contract).toContain("**Conditional**");
    expect(contract).toContain("**A new phase never writes an empty conditional block.**");
    expect(contract).toContain("(**only** when temporary behavior exists)");

    // Each rule that could demand a simulation states its own condition — the
    // failure mode is one conditional sentence somewhere and unconditional
    // demands everywhere else.
    const exec = await readSurface(PLAN_EXEC);
    expect(exec).toContain(
      "**A missing `Límite de simulación` is a gap only when there is something to simulate.**",
    );
    // Each rule that could demand a simulation states its own condition. All
    // three plan commands carry it — no exemption, no skip.
    //
    // An earlier version of this guard skipped a doc that mentioned no
    // simulation at all. That looked like a reasonable "nothing to qualify"
    // carve-out and was in fact the opposite: `plan-new.md` had LOST the rule
    // in a compression pass, and the skip is what hid it. A guard that lets a
    // doc out of an assertion by dropping the subject is not a guard.
    for (const rel of [
      "commands/plan-new.md",
      "commands/plan-exec.md",
      "commands/plan-refine.md",
    ]) {
      const doc = await readSurface(rel);
      expect(doc, rel).toMatch(
        /only when the change carries|only when it does|no `Límite de simulación`/,
      );
    }
  });

  it("`/w:resume` figures in the transversal inventory of every index", async () => {
    const skill = await readSurface("SKILL.md");
    expect(skill).toContain("`/w:resume`");
    const readme = await readFile(resolve(SKILL_ROOT, "..", "..", "README.md"), "utf8");
    const transversal = readme.split("\n").find((l) => l.includes("**Transversal**")) ?? "";
    expect(transversal).toContain("/w:resume");
  });

  it("`resume` routes by plan_state — done is the only state it does not resume", async () => {
    // The routing table moved into the shared projection: `derivePipeline` skips
    // `done` and `planNext` gives every other state its own re-entry point, in one
    // chain. `resume` consumes that chain instead of running a second one — a
    // second one is how the board and the offer described the same plan
    // differently in the first place.
    const index = await readSrc("workline-index-service.ts");
    expect(index).toContain('if (plan.plan_state === "done") continue;');
    expect(index).toContain('plan.plan_state === "inconsistent"');
    expect(index).toContain("plan.final_validation_pending");
    expect(index).toContain("BLOQUEADA F");
    const service = await readSrc("resume-service.ts");
    expect(service).toContain("planPresentation");
    expect(service).not.toContain("final_validation_pending");
    // And the skill states the rule without owning it.
    const doc = await readSurface("commands/resume.md");
    expect(doc).toContain("A plan is not finished because its boxes are ticked");
    expect(doc).toContain("comes back as inconsistent");
  });
});

describe("Doctrine guards — G20 · what a pending item owes, and how the choice is offered", () => {
  // The two surfaces used to relay a list and a route and nothing else, which is
  // how the board could print `plan 031 — 100%, fases 6/6` about a plan whose
  // final validation had never run, and how `/w:resume` could offer one item out
  // of four. The rule now lives in the CLI; these pins keep the doctrine from
  // losing it in silence, which is the drift class that costs a whole surface.

  it("`status` owes each item its next step, and an obligation before the percentage", async () => {
    const doc = await readSurface("commands/status.md");
    expect(doc).toContain("what it still owes");
    expect(doc).toContain("An obligation comes before the percentage");
    // The three that leave an item neither runnable nor closable, by name.
    expect(doc).toMatch(/design reference/i);
    expect(doc).toMatch(/reconciliation/i);
    expect(doc).toMatch(/baseline/i);
    // And the misleading reading the spec exists to fix, said outright.
    expect(doc).toContain("`100%`");
    expect(doc).toContain("`validada`");
  });

  it("`status` reports a loose session as a notice, and recognizes an empty implicit workspace", async () => {
    const doc = await readSurface("commands/status.md");
    expect(doc).toContain("Sessions are not the user's work");
    expect(doc).toMatch(/\*\*notice\*\*/);
    expect(doc).toContain("never a pending row");
    expect(doc).toContain("Nothing pending");
    expect(doc).toContain("implicit workspace");
    expect(doc).toContain('genuinely "nothing pending"');
    expect(doc).toContain("this read creates no marker");
  });

  it("`resume` analyses briefly, offers one option per candidate and chains the chosen command", async () => {
    const doc = await readSurface("commands/resume.md");
    expect(doc).toContain("Analyse briefly first");
    expect(doc).toContain("One option per candidate");
    expect(doc).toContain("re-entry command");
    expect(doc).toContain("`flow` slot");
    expect(doc).toContain("in the same turn");
    // Choosing must not be mistaken for the CLI acting: it runs no route.
    expect(doc).toContain("It runs no route and writes nothing");
    expect(doc).toContain("No candidates");
  });

  it("`resume` degrades the mechanism and never the candidates", async () => {
    const doc = await readSurface("commands/resume.md");
    expect(doc).toMatch(/group by class into ≤3 questions/);
    expect(doc).toContain("labelled markdown");
    expect(doc).toContain("declare the degradation");
    expect(doc).toContain("Nothing trimmed, merged or dropped");
  });

  it("neither surface still calls a loose session a candidate of the pipeline", async () => {
    // The class stays in the model (nothing was removed) but it stopped being
    // work the user is asked to weigh, so the doctrine may not list it as one.
    const resume = await readSurface("commands/resume.md");
    expect(resume).toContain("A loose session is a notice, never a candidate");
    expect(resume).not.toMatch(/→ loose checkpoint/);
  });
});

describe("Doctrine guards — G2 · readability caps in the hot path", () => {
  // Generous ceilings: they catch only the worst 5% (norm+rationale+exception
  // chained into one giant sentence), not style preferences.
  const MAX_LINE_CHARS = 900;
  const MAX_SENTENCE_WORDS = 60;

  it("no line > 900 chars and no sentence > 60 words in loops/ and commands/", async () => {
    const targets: string[] = [];
    for (const sub of ["loops", "commands", "modules"]) {
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
  //
  // The per-item cap is necessary and was never sufficient: it is what let the
  // discovery aggregate drift from 5 861 to 6 684 B during plan 009 without a
  // single description crossing its own limit. Sixteen commands each 20 B under
  // their cap is sixteen times a cost the user pays before invoking anything.
  // The aggregate below is the half that was missing.
  function capFor(rel: string): number {
    if (rel.startsWith("commands/")) return 500;
    if (rel.startsWith("loops/")) return 600;
    if (rel.startsWith("roles/")) return 800;
    if (rel.startsWith("exports/")) return 1000;
    return 650; // root SKILL.md · harness/HARNESS.md
  }

  it("every description stays within its area budget", async () => {
    const rels: string[] = ["SKILL.md", join("harness", "HARNESS.md")];
    for (const sub of ["commands", "loops", "modules", "exports", "roles"]) {
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

  it("the discovery aggregate never grows past the frozen baseline", async () => {
    const result = await runContextBudget(new NodeFileSystem(), {
      root: SKILL_ROOT,
      baselinePath: resolve(__dirname, "..", "fixtures", "context-baseline.json"),
    });
    const discovery = result.budget.find((line) => line.metric === "discovery");
    expect(discovery?.baseline).toBeGreaterThan(0);
    expect(discovery?.actual).toBeLessThanOrEqual(discovery?.baseline ?? 0);
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
    // Open questions is conditional (artifact-slim round): present only while
    // live doubts exist — never a "None" placeholder.
    expect(tpl).toContain("only while live doubts exist");
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
      // The signature must be runnable as written: --objetivo is mandatory
      // (session-create-service rejects a missing objetivo). A hard floor that
      // omits it fails on first run for the weakest models — the exact bug this
      // guards against.
      expect(text, rel).toContain("--objetivo");
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

describe("Doctrine guards — G19 · continuous PLAN execution batches", () => {
  const BATCHES = "modules/PLAN-EXECUTION-BATCHES.md";

  it("defines one compact plan interface with a complete ordered partition", async () => {
    const contract = await readRel(BATCHES);
    expect(contract).toContain("## Plan interface");
    expect(contract).toContain("## Execution batches");
    expect(contract).toContain("- B1 · continuous · F1-F3");
    expect(contract).toContain("- B2 · isolated · F4");
    expect(contract).toContain("complete, disjoint phase partition");
    expect(contract).toContain("contains consecutive phases");
    const planNew = await readRel("loops/plan-new-loop/LOOP.md");
    expect(planNew).toContain("## Execution batches");
    expect(planNew).toContain("(core)");
  });

  it("planning infers maximal groups and never asks for a repository fact", async () => {
    const contract = await readRel(BATCHES);
    expect(contract).toContain("maximal consecutive `continuous` ranges");
    // Amended by the PLAN cutover: the five facts that break eligibility are the
    // signal vocabulary now, and the rows that observe them are what the guard
    // reads. Enumerating them in the module too is what let a plan be grouped one
    // way by the doc and another by the run.
    for (const scope of ["plan-new", "plan-refine", "plan-exec"]) {
      const row = decisionsOfScope(scope).find((decision) =>
        decision.id.endsWith(".batch-eligibility-signal"),
      );
      expect(row?.signals, scope).toEqual([
        "plan.dependency-outside-range",
        "plan.result-shapes-later",
        "plan.blocker-between-phases",
        "plan.recovery-boundary",
        "plan.not-one-reviewable-unit",
      ]);
    }
    expect(contract).toContain("not a preference question");
    for (const loop of ["plan-new-loop", "plan-refine-loop"]) {
      expect(await readSurface(`loops/${loop}/LOOP.md`), loop).toContain(
        "infer maximal phase partition",
      );
    }
  });

  it("execution re-infers from live state and may regroup without consent", async () => {
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    expect(exec).toContain("## Runtime authority");
    expect(exec).toContain("current evidence wins over the declared");
    expect(exec).toContain("record batches + declaration drift in CHECKPOINT");
    expect(exec).toContain("missing `## Execution batches` is legacy compatibility");
  });

  it("continuous units defer every check and validate/review atomically at close", async () => {
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    // The BOUNDARY stays doctrine's — it is what a continuous batch means — while
    // the closing ORDER became the engine's, so the module states it once as a
    // property and the registry's row order is what enforces it.
    expect(exec).toContain("not the phase — is the execution boundary");
    expect(exec).toContain("Continuous means all checks at batch close");
    expect(exec).toContain("No unproven phase becomes");
    expect(exec).toContain("combined changes remain uncommitted");
    const plan = decisionsOfScope("plan-exec").map((row) => row.id);
    for (const [earlier, later] of [
      ["plan-exec.validation-execution", "plan-exec.review-findings"],
      ["plan-exec.review-findings", "plan-exec.commit-enablement"],
      ["plan-exec.commit-enablement", "plan-exec.commit-execution"],
    ]) {
      expect(plan.indexOf(later), `${earlier} → ${later}`).toBeGreaterThan(plan.indexOf(earlier));
    }
  });

  it("Git closes one source commit with final approval or conditional pre-authorization", async () => {
    const policies = await readRel("loops/CODE-POLICIES.md");
    expect(policies).toContain("exactly one commit");
    expect(policies).toContain("intentionally co-mingles");
    expect(policies).toContain("its internal phases in one reviewed commit");
    // The gating moved: approving is a preference, committing is an effect that
    // comes back as the sources' real git state, and neither can be reached
    // without the delegated validation that precedes them.
    const batches = await readRel("modules/PLAN-EXECUTION-BATCHES.md");
    expect(batches).toContain("a check that never ran is not a green batch");
    expect(labelsOf("plan-exec.commit-authorization")[0]).toBe("Aprobar los commits del batch");
    const commit = decisionsOfScope("plan-exec").find(
      (row) => row.id === "plan-exec.commit-execution",
    );
    expect(commit?.action?.evidence).toEqual(["plan.commits-por-fuente"]);
    expect(commit?.effects).toContain("execute");
    expect(policies).not.toContain("two phases never co-mingle in one commit");
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    // El enunciado del guard no cambió —un commit por fuente, con aprobación o
    // preautorización— pero DÓS de sus frases sí, y por una razón material: decían
    // que el sello `done` viajaba en la misma aprobación de Git y aterrizaba "in
    // the same source commit". Con la corrida editando en unidades de aislamiento
    // eso no puede ocurrir: el plan-doc vive en el workspace y el commit del batch
    // aterriza en la rama de la unidad, que son dos repositorios distintos. Lo
    // único que quedaba de aquel orden era sellar `done` sobre trabajo que todavía
    // no estaba en ninguna rama de trabajo, así que la doctrina pasa a decir lo que
    // de verdad protege: commitear, integrar, y recién entonces sellar.
    expect(exec).toContain("commit each unit, integrate it, and only then seal `done`");
    expect(exec).toContain("a session holding a live unit does NOT close");
    expect(batches).toContain("instead of asking a second time");
    expect(exec).toContain("if plan is not done:");
    expect(exec).toContain("then mark plan done");
    expect(exec).toContain("one consolidated approval for all source commits");
  });

  it("CHECKPOINT carries the effective group, drift and reusable authorization", async () => {
    const checkpoint = await readRel("artifacts/artifacts-core/CHECKPOINT.md");
    expect(checkpoint).toContain("effective batch");
    expect(checkpoint).toContain("declared-vs-live regrouping");
    expect(checkpoint).toContain("conditional commit authorization");
    expect(checkpoint).toContain("Continuous-batch phases move together");
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
    for (const sub of [
      "commands",
      "loops",
      "modules",
      "exports",
      "roles",
      "artifacts",
      "harness",
      "hooks",
    ]) {
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

// G8 — multi-host packaging contract: the installer's data tables and the
// HARNESS.md "Command packaging" doc must describe the same reality. A path
// typo here ships silently (hosts just don't list the commands), so the
// tables are pinned literally and cross-checked against the doctrine.
describe("doctrine guards — G8 multi-host packaging contract", () => {
  it("TARGET_ROOTS pins every host's skill root (crush = XDG, its only global root)", async () => {
    const { TARGET_ROOTS } = await import("../../src/application/self/install-targets.js");
    expect(TARGET_ROOTS).toEqual({
      claude: [".claude", "skills"],
      codex: [".codex", "skills"],
      agents: [".agents", "skills"],
      warp: [".warp", "skills"],
      oz: [".agents", "skills"],
      gemini: [".gemini", "skills"],
      opencode: [".opencode", "skills"],
      crush: [".config", "crush", "skills"],
      kimi: [".kimi-code", "skills"],
    });
  });

  it("user-command wrapper relpaths agree between install and uninstall (codex asymmetry is the inert ≤v18 cleanup)", async () => {
    const { USER_COMMANDS_BY_TARGET } = await import("../../src/application/self/install-skill.js");
    const { USER_COMMANDS_RELPATH_BY_TARGET } = await import(
      "../../src/application/self/uninstall.js"
    );
    const installRelpaths = Object.fromEntries(
      Object.entries(USER_COMMANDS_BY_TARGET).map(([t, spec]) => [t, spec?.relpath ?? null]),
    );
    expect(installRelpaths).toEqual({
      claude: ".claude/commands/w",
      codex: null,
      warp: null,
      oz: null,
      agents: null,
      gemini: ".gemini/commands/w",
      opencode: ".opencode/command/w",
      crush: ".crush/commands/w",
      // kimi reads no commands dir: its command surface is the synthesized
      // `w-<cmd>` skills, invoked as `/skill:w-<cmd>`.
      kimi: null,
    });
    expect(USER_COMMANDS_RELPATH_BY_TARGET).toEqual({
      ...installRelpaths,
      // Written by ≤v18 under a false assumption, never read by Codex —
      // uninstall keeps clearing it although install no longer writes it.
      codex: ".codex/commands/w",
    });
  });

  it("HARNESS.md Command packaging table matches the installer tables (paths + invocation syntax)", async () => {
    const harness = await readRel("harness/HARNESS.md");
    const packaging = harness.slice(harness.indexOf("## Command packaging"));
    for (const expected of [
      "`~/.claude/commands/w/<cmd>.md`",
      "`~/.codex/skills/w-<cmd>/SKILL.md`",
      "`$w-<cmd>` mention",
      "`~/.gemini/skills/w-<cmd>/SKILL.md`",
      "`~/.gemini/commands/w/<cmd>.toml`",
      "`~/.opencode/command/w/<cmd>.md`",
      "`/w/<cmd>`",
      "`~/.crush/commands/w/<cmd>.md`",
      "palette `user:w:<cmd>`",
      "`/w-<cmd>`",
    ]) {
      expect(packaging, expected).toContain(expected);
    }
  });
});

// G8b — the roots the CLI writes must be roots the host reads. clean-legacy's
// scan table declares "dirs each host actually READS from"; if it misses the
// install root (or a legacy root we migrate away from), `self clean-legacy`
// silently skips the CLI's own dirs — the v14.5.1 lesson, table edition.
describe("doctrine guards — G8b scan/install root containment", () => {
  it("every target's install root and legacy roots are scanned by clean-legacy", async () => {
    const { TARGET_ROOTS, LEGACY_SKILL_ROOTS_BY_TARGET } = await import(
      "../../src/application/self/install-targets.js"
    );
    const { LEGACY_SCAN_PATHS_BY_TARGET } = await import(
      "../../src/application/self/clean-legacy.js"
    );
    const asKey = (segments: readonly string[]) => segments.join("/");
    for (const target of Object.keys(TARGET_ROOTS) as (keyof typeof TARGET_ROOTS)[]) {
      const scanned = new Set(LEGACY_SCAN_PATHS_BY_TARGET[target].map(asKey));
      expect(scanned, `${target}: install root scanned`).toContain(asKey(TARGET_ROOTS[target]));
      for (const legacy of LEGACY_SKILL_ROOTS_BY_TARGET[target]) {
        expect(scanned, `${target}: legacy root scanned`).toContain(asKey(legacy));
      }
    }
  });

  it("HARNESS.md capability matrix reflects crush's XDG skills root", async () => {
    const harness = await readRel("harness/HARNESS.md");
    expect(harness).toContain("`~/.config/crush`");
  });
});
