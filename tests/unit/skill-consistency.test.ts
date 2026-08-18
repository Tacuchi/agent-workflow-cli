import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESCRIPTION_MAX } from "../../src/application/plugin-doctor/skills.js";
import { SKILL_DIR_NAME, splitCommandDoc } from "../../src/application/self/install-skill.js";
import { DOCS_FOLDERS } from "../../src/application/workspace-init-service.js";
import { decisionsOfScope } from "../../src/domain/flow/authority.js";
import { parseSkillFrontmatter } from "../../src/domain/skill-frontmatter.js";

// Consistency guards for the `w` skill bundle. These catch CROSS-SKILL drift —
// where two skills that compose each other disagree on a shared contract — which
// the legacy-ref grep audit (skill-audit-grep.test.ts) does not cover. The
// motivating case: `roles/diagrams` and `exports/export-diagrams` had drifted
// apart on the engine flag (`--diagrams` vs `--engine`), the default engine
// (structurizr vs mermaid) and the output filenames. A composing pair must agree.
const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");

// Since plan 009 the transversal surfaces (`status`, `resume`) no longer
// interpret the JSON — the CLI renders. The vocabulary guards below therefore
// point at the SOURCE that now holds the reader's half of each contract: the
// skill is checked for delegating, the CLI for speaking the writer's language.
const SRC_ROOT = resolve(__dirname, "..", "..", "src");
const INDEX_SERVICE = join(SRC_ROOT, "application", "workline-index-service.ts");
const RESUME_SERVICE = join(SRC_ROOT, "application", "resume-service.ts");
const SCANNED_SUBFOLDERS = [
  "commands",
  "loops",
  "modules",
  "exports",
  "roles",
  "artifacts",
  "hooks",
];

/**
 * A document plus every module it points at — its whole doctrinal SURFACE.
 *
 * Since plan 010 a conditional branch lives in `modules/<NAME>.md` and its host
 * document carries a one-line pointer. A cross-document contract has to follow
 * that pointer, or splitting a file would read as breaking the contract.
 *
 * Stronger than the single-file read it replaces: deleting the content fails,
 * and so does deleting the pointer that reaches it.
 */
async function readSurface(rel: string): Promise<string> {
  const own = await readFile(join(SKILL_ROOT, rel), "utf8");
  const parts = [own];
  for (const match of own.matchAll(/(?:\.\.\/)+modules\/([A-Z0-9-]+\.md)/g)) {
    const name = match[1];
    if (name === undefined) continue;
    try {
      parts.push(await readFile(join(SKILL_ROOT, "modules", name), "utf8"));
    } catch {
      // A dangling pointer is the manifest guard's business, not this one's.
    }
  }
  return parts.join("\n");
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

async function bundleMdFiles(): Promise<string[]> {
  const all: string[] = [];
  for (const sub of SCANNED_SUBFOLDERS) {
    all.push(...(await listMdFiles(join(SKILL_ROOT, sub))));
  }
  return all.map((f) => f.slice(SKILL_ROOT.length + 1));
}

describe("bundle shape — internals are manuals, not skills (multi-host ronda 2026-07)", () => {
  // Codex/OpenCode/Crush scan skill roots RECURSIVELY (and OpenCode/Crush also
  // cross-read ~/.claude/skills + ~/.agents/skills), so any nested SKILL.md in
  // the bundle surfaces as a user-invocable skill on those hosts. The internal
  // manuals are LOOP/ROLE/EXPORT/HARNESS.md precisely so that never happens.
  it("the ONLY SKILL.md in the bundle is the root one", async () => {
    const nested = (await bundleMdFiles()).filter((f) => f.endsWith("SKILL.md"));
    expect(nested).toEqual([]);
  });

  it("root SKILL.md frontmatter name equals the install dir name (Crush rejects mismatches)", async () => {
    const root = await readSurface("SKILL.md");
    const fm = parseSkillFrontmatter(root);
    expect(fm?.fields.name).toBe(SKILL_DIR_NAME);
  });

  it("every command yields a clean description through the installer's parser (all host wrappers depend on it)", async () => {
    const commandsDir = join(SKILL_ROOT, "commands");
    const offenders: string[] = [];
    for (const entry of await readdir(commandsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
      const { description } = splitCommandDoc(
        await readFile(join(commandsDir, entry.name), "utf8"),
      );
      if (description === null || description.length === 0 || /^[>|'"]/.test(description)) {
        offenders.push(`${entry.name}: ${JSON.stringify(description)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

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
    const role = await readSurface("roles/diagrams/ROLE.md");
    const exp = await readSurface("exports/export-diagrams/EXPORT.md");
    // Both must name the shared flag.
    expect(role).toContain("--engine");
    expect(exp).toContain("--engine");
    // Modernized away from a structurizr default; neither may re-assert it.
    expect(role).not.toMatch(/structurizr.{0,20}(default|por defecto)/i);
    expect(exp).not.toMatch(/structurizr.{0,20}(default|por defecto)/i);
  });

  it("every bundle skill/manual description respects the Agent Skills cap the doctor enforces on third parties", async () => {
    // The root SKILL.md description enters every host's skill listing; the
    // internal manuals (LOOP/ROLE/EXPORT/HARNESS.md) keep skill-shaped
    // frontmatter as metadata, so they honor the same standard cap.
    const files = (await bundleMdFiles()).filter((f) =>
      /(?:SKILL|LOOP|ROLE|EXPORT|HARNESS)\.md$/.test(f),
    );
    files.push("SKILL.md", join("harness", "HARNESS.md"));
    const offenders: string[] = [];
    for (const relpath of files) {
      const text = await readFile(join(SKILL_ROOT, relpath), "utf8");
      const fm = parseSkillFrontmatter(text);
      const description = fm?.fields.description ?? "";
      if (description.length > DESCRIPTION_MAX) {
        offenders.push(`${relpath} (${description.length} chars)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("QUICK escalation contract — quick-loop ↔ spec-refine-loop ↔ spec-new", () => {
  // Live QUICK→SPEC escalation spans three docs: quick-loop (the gate + live
  // transition), spec-new (the draft procedure it reuses) and spec-refine-loop
  // (the loop it hands off to). These pins keep the composing trio in agreement.
  const QUICK_LOOP = "loops/quick-loop/LOOP.md";

  it("quick-loop names both escalation targets (the loop tree is installed intact on every host)", async () => {
    const quick = await readSurface(QUICK_LOOP);
    // The refs are load-bearing (the transition loads these docs). Since the
    // flatten model died (loops ship inside `w/` everywhere; commands are the
    // synthesized skills), no flattened `w-<loop>` alias spelling may remain.
    expect(quick).toContain("spec-refine-loop/LOOP.md");
    expect(quick).toContain("spec-new.md");
    expect(quick).not.toContain("w-spec-refine-loop");
  });

  it("the escalation targets exist on disk (anti-rename guard)", async () => {
    await expect(readSurface("loops/spec-refine-loop/LOOP.md")).resolves.toBeTruthy();
    await expect(readSurface("commands/spec-new.md")).resolves.toBeTruthy();
  });

  it("the size gate runs BEFORE the quick session is created (journey order)", async () => {
    // The order used to be pinned as two strings in the Sequence block. The QUICK
    // cutover moved the rule into the registry, so the invariant is asserted where
    // it now decides: an escalated quick must never have created a session, and
    // that is only true while these rows come first in the journey.
    const ids = decisionsOfScope("quick").map((decision) => decision.id);
    const gate = ids.indexOf("quick.entry-size-gate");
    const choice = ids.indexOf("quick.gate-choice");
    const create = ids.indexOf("quick.session-create");
    expect(gate).toBeGreaterThan(-1);
    expect(choice).toBeGreaterThan(gate);
    expect(create).toBeGreaterThan(choice);
    // And the document no longer re-states the threshold it handed over.
    const quick = await readSurface(QUICK_LOOP);
    expect(quick).not.toContain("≥2 of:");
  });

  it("spec-refine-loop declares the quick escalation as a second Started-by path", async () => {
    const refine = await readSurface("loops/spec-refine-loop/LOOP.md");
    const startedBy = refine.match(/## Started by[\s\S]*?(?=\n## )/)?.[0] ?? "";
    expect(startedBy).toMatch(/quick/);
    expect(startedBy).toMatch(/escalation/i);
  });

  it("spec-new keeps its hard single-pass rule and gains the escalation-reuse note", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("NO RESEARCH");
    expect(specNew).toMatch(/quick/);
  });

  it("command and loop agree: SPEC live, PLAN deferred (asymmetry pinned)", async () => {
    const quickCmd = await readSurface("commands/quick.md");
    const quickLoop = await readSurface(QUICK_LOOP);
    expect(quickCmd).toMatch(/live/i);
    expect(quickLoop).toMatch(/live/i);
    expect(quickLoop).toMatch(/PLAN[^\n]*deferred/i);
  });

  it("the root orientation records the consented exception to the continuity rule", async () => {
    const root = await readSurface("SKILL.md");
    expect(root).toMatch(/accepted escalation|explicit consent/i);
  });
});

describe("Split contract — spec-new ↔ plan-new-loop ↔ plan-refine-loop", () => {
  // The split gates span three docs: spec-new (multi-spec, pre-write),
  // plan-new-loop (the canonical multi-plan gate) and plan-refine-loop (the
  // in-place refine semantics). These pins keep the composing trio in
  // agreement (same shape as the QUICK escalation contract above).
  it("spec-new offers the split as its ONLY interaction, before any write", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toMatch(/ONE structured-choice/);
    expect(specNew).toContain("before writing anything");
  });

  it("the multi-plan gate is defined once — plan-refine references, never redefines", async () => {
    const planRefine = await readSurface("loops/plan-refine-loop/LOOP.md");
    expect(planRefine).toContain("Split gate (multi-plan)");
    // The gap row and the offer labels live ONLY in plan-new-loop.
    expect(planRefine).not.toMatch(/^\| Plan splittable/m);
    expect(planRefine).not.toContain("`Dividir en varios planes`");
  });

  it("both producers speak the sibling contract (cross-reference by path)", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    const planNew = await readSurface("loops/plan-new-loop/LOOP.md");
    expect(specNew).toContain("siblings by path");
    expect(planNew).toContain("siblings by path");
  });

  it("the multi-plan coherence gate checks a complete, disjoint partition", async () => {
    const planNew = await readSurface("loops/plan-new-loop/LOOP.md");
    expect(planNew).toMatch(/traces to \*\*exactly one\*\*/);
    expect(planNew).toContain("partition");
  });

  it("refine-split anchors execution history (completed tasks never move)", async () => {
    const planRefine = await readSurface("loops/plan-refine-loop/LOOP.md");
    expect(planRefine).toContain("Completed tasks (`- [x]`) never move to a sibling");
    expect(planRefine).toContain("keeps its number/path");
  });

  // El cierre de la rama split dejó de ser una pregunta propia: los hermanos
  // viajan en la MISMA propuesta sellada que el plan, así que una sola vista
  // previa los enumera y una sola aprobación los cubre. Lo que cada Sequence
  // tiene que seguir diciendo es que la rama split escribe hermanos.
  it("both plan Sequences close the split inside the one sealed proposal", async () => {
    for (const rel of ["loops/plan-new-loop/LOOP.md", "loops/plan-refine-loop/LOOP.md"]) {
      const text = await readSurface(rel);
      const seq = text.slice(text.indexOf("## Sequence"));
      expect(seq, rel).toContain("Aprobar y guardar");
      expect(seq, rel).toMatch(/sibling/i);
    }
  });

  it("the root orientation records the split capability", async () => {
    const root = await readSurface("SKILL.md");
    expect(root).toMatch(/split/i);
  });
});

describe("Reconnaissance contract — spec-new ↔ quick-loop ↔ persist ↔ spec-refine-loop", () => {
  // The bounded reconnaissance is scoped to a RAW prompt. The reuse entries keep
  // the strict NO RESEARCH contract (their context arrives adopted, so looking
  // again would re-derive settled work), and the deep investigation keeps living
  // in spec-refine. Same shape as the QUICK escalation / Split contracts above.
  it("spec-new scopes the pass to a raw prompt and keeps its single interaction", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toMatch(/ONE structured-choice/);
    expect(specNew).toContain("only on a raw user prompt");
  });

  it("the reuse entries skip the pass and keep NO RESEARCH", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    const quick = await readSurface("loops/quick-loop/LOOP.md");
    const persist = await readSurface("commands/persist.md");
    for (const doc of [specNew, quick, persist]) expect(doc).toContain("NO RESEARCH");
    // quick-loop's live transition states the skip where it materializes the draft.
    expect(quick).toContain("does **not** re-fire");
    expect(specNew).toContain("no reconnaissance");
  });

  it("spec-refine-loop declares the boundary and owns the deep investigation", async () => {
    const refine = await readSurface("loops/spec-refine-loop/LOOP.md");
    expect(refine).toContain("Boundary with `spec-new`");
    expect(refine).toContain("Deep investigation is this loop's");
  });

  it("the root orientation records the pass before the scope decision", async () => {
    const root = await readSurface("SKILL.md");
    expect(root).toMatch(/bounded reconnaissance/i);
  });
});

describe("SPEC readiness contract — spec-new ↔ spec-refine ↔ plan-new ↔ the transversal surfaces", () => {
  // The maturity mark spans five docs: spec-new emits it, spec-refine promotes
  // it, plan-new reads it, status/resume render it. A producer and a consumer
  // that disagree on the mark break the SPEC→PLAN handoff silently — same shape
  // as the QUICK escalation / Split / Reconnaissance contracts above.
  it("spec-new emits the draft status and never promotes it", async () => {
    const specNew = await readSurface("commands/spec-new.md");
    expect(specNew).toContain("status: draft");
    expect(specNew).toContain("only the `spec-refine` gate promotes a spec to `ready-for-plan`");
  });

  it("spec-refine is the only promoter, and it stamps on save", async () => {
    const cmd = await readSurface("commands/spec-refine.md");
    const loop = await readSurface("loops/spec-refine-loop/LOOP.md");
    expect(cmd).toContain("status: ready-for-plan");
    expect(loop).toContain("stamps the frontmatter `status: ready-for-plan`");
  });

  it("plan-new reads the mark, tolerates the legacy one and never blocks", async () => {
    const cmd = await readSurface("commands/plan-new.md");
    const loop = await readSurface("loops/plan-new-loop/LOOP.md");
    for (const doc of [cmd, loop]) {
      expect(doc).toContain("status: ready-for-plan");
      expect(doc).toContain("## Refinement decisions"); // legacy tolerance
      expect(doc).toMatch(/never a block/i);
    }
    // A question the spec handed to PLAN is input, not a reason to bounce it.
    expect(loop).toContain("input to this loop");
  });

  it("the escalated draft is born a draft too — quick never skips the SPEC gate", async () => {
    const quick = await readSurface("loops/quick-loop/LOOP.md");
    expect(quick).toContain("born `status: draft`");
  });

  it("the transversal surfaces speak the same vocabulary", async () => {
    // The vocabulary moved into the CLI with the interpretation; the skills now
    // have to DELEGATE, and saying so is what keeps them from drifting back.
    const status = await readSurface("commands/status.md");
    const resume = await readSurface("commands/resume.md");
    const index = await readFile(INDEX_SERVICE, "utf8");
    expect(status).toContain("aw status --format human");
    expect(resume).toContain("aw resume --format human");
    expect(resume).toContain("**Never re-decide**");
    expect(index).toContain("ready-for-plan");
    expect(index).toContain('`status === "ready-for-plan"`');
    expect(resume).not.toContain("spec unrefined");
  });

  it("the legacy tolerance is exactly two marks \u2014 code and doctrine list the same pair", async () => {
    // The drift that shipped: the runtime also accepted `## Decisions`, a
    // section of the CURRENT schema, so a spec nobody refined read as ready and
    // `/w:resume` routed it to PLAN. The list is a contract, not an implementation
    // detail — the docs that describe it and the code that applies it must match.
    const { LEGACY_READY_MARKS } = await import("../../src/application/workline-index-service.js");
    expect(LEGACY_READY_MARKS).toEqual(["Refinement decisions", "Q&A traceability"]);
    for (const rel of [
      "loops/spec-refine-loop/LOOP.md",
      "loops/plan-new-loop/LOOP.md",
      "commands/plan-new.md",
      "commands/spec-refine.md",
    ]) {
      const doc = await readSurface(rel);
      for (const mark of LEGACY_READY_MARKS) {
        expect(doc, `${rel} must name the legacy mark ## ${mark}`).toContain(`## ${mark}`);
      }
    }
    // `commands/status.md` dropped off that list when the CLI took over spec
    // maturity: the rule it used to describe is now applied there, and that is
    // the copy the guard has to pin.
    const index = await readFile(INDEX_SERVICE, "utf8");
    expect(index).toContain("A declared frontmatter governs alone");
    expect(index).toContain("runs only on a spec that carries no frontmatter at all");
  });

  it("the naming asymmetry with plan-refine is deliberate and declared", async () => {
    const specLoop = await readSurface("loops/spec-refine-loop/LOOP.md");
    const planLoop = await readSurface("loops/plan-refine-loop/LOOP.md");
    expect(specLoop).toContain("stays the name of plan-refine's audit trace");
    // plan-refine keeps `## Refinement decisions`: it has no status to take over.
    expect(planLoop).toContain("## Refinement decisions");
    expect(planLoop).not.toContain("ready-for-plan");
  });
});

describe("Phase contract — plan loops ↔ the transversal surfaces ↔ the runtime", () => {
  // The phase mark spans a producer (plan-exec writes `> Estado:`), a parser
  // (`parsePhases`) and two readers (status, resume). A producer and a reader
  // that disagree on the mark break the signal silently — the plan would look
  // finished at 100% of checkboxes with nothing validated. Same shape as the
  // SPEC readiness contract above. The round's own pins live in G17; this group
  // only checks that the composing docs agree.
  it("the writer and the readers speak the same mark", async () => {
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    const status = await readSurface("commands/status.md");
    const resume = await readSurface("commands/resume.md");
    expect(exec).toContain("> Estado: validada");
    // The reader half is the CLI now — the skills only relay what it prints, and
    // the reading itself is single: the shared projection derives the mark and
    // `resume` consumes that, so the two cannot end up speaking different ones.
    const indexDoc = await readFile(INDEX_SERVICE, "utf8");
    expect(indexDoc).toContain("phases_validated");
    expect(indexDoc).toContain("phases_total");
    expect(indexDoc).toContain("validada");
    expect(await readFile(RESUME_SERVICE, "utf8")).toContain("planDetail");
    expect(resume).toContain("not `validada`");
    expect(status).toContain("plans not `done`");
  });

  it("the two progress signals stay separate on every surface", async () => {
    // Additive, not a replacement: checkboxes measure work, phases measure state.
    const index = await readFile(INDEX_SERVICE, "utf8");
    const resume = await readSurface("commands/resume.md");
    expect(index).toContain("checkbox-derived work progress; the phase counts below never feed it");
    expect(index).toContain("never inferred from the checkboxes");
    expect(resume).toContain("A plan is not finished because its boxes are ticked");
    expect(resume).toContain("`/w:plan-exec`");
  });

  it("a legacy plan with no phase marks degrades the same way everywhere", async () => {
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    const index = await readFile(INDEX_SERVICE, "utf8");
    expect(exec).toContain("a missing line reads `pendiente`");
    expect(index).toContain("`phases_total: 0`");
    expect(index).toContain("it never acquires fictitious phases");
  });

  it("plan-refine's exit gate and plan-exec's entry gate are the same gate", async () => {
    const refine = await readSurface("loops/plan-refine-loop/LOOP.md");
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    expect(refine).toContain("re-checks this same gate on entry");
    expect(exec).toContain("\u00a7 *Entry gate \u2014 executability*");
    // plan-refine stays auxiliary: exec runs any plan that is already executable.
    expect(exec).toContain("plan-refine is auxiliary, not mandatory");
  });

  it("a blocked phase reads the same to the writer and to both readers", async () => {
    // `bloqueada` is the state the correction round put to work: it is where a
    // phase whose proof could not run now waits. A reader that ignores it would
    // report the plan as merely half-done and lose WHY it stopped.
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    const checkpoint = await readFile(
      join(SKILL_ROOT, "artifacts/artifacts-core/CHECKPOINT.md"),
      "utf8",
    );
    expect(exec).toContain("> Bloqueo:");
    expect(checkpoint).toContain("`bloqueada`");
    // The runtime keys off the exact mark the writer emits, not a paraphrase.
    const index = await readFile(INDEX_SERVICE, "utf8");
    expect(index).toContain("> Estado: bloqueada");
    expect(index).toContain('phase.state === "bloqueada"');
    // And the reader surfaces the declared reason instead of a bare state — where
    // the one derivation lives, not in each command that shows it.
    expect(index).toContain("sin motivo declarado");
    expect(await readSurface("commands/resume.md")).toContain(
      "`bloqueada` phase with its declared reason",
    );
    expect(checkpoint).toContain("**what is missing to validate it**");
  });

  it("`## Tasks` is the single source of phases, in the doctrine and in the parser", async () => {
    const planNew = await readSurface("loops/plan-new-loop/LOOP.md");
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    expect(planNew).toContain("ONLY source of phases");
    expect(exec).toContain("`### Fn` blocks under `## Tasks`");
    const { parsePhases } = await import("../../src/application/parsers/phases.js");
    const quoted = [
      "## Solution",
      "### F9 \u2014 ejemplo citado en la soluci\u00f3n",
      "> Estado: validada",
      "",
      "## Tasks",
      "### F1 \u2014 El carrito acepta un cup\u00f3n",
      "> Estado: validada",
    ].join("\n");
    expect(parsePhases(quoted)).toMatchObject({ total: 1, validated: 1 });
  });
});

describe("Simulation is conditional \u2014 one rule across every producer and consumer", () => {
  // Eight docs used to state the simulation requirement in their own words, and
  // several of them stated it unconditionally, so a config change or a direct
  // migration could be pushed into inventing a stub to satisfy the template.
  // ONE test for ONE rule, instead of eight `toContain` scattered per round.
  const CARRIERS = [
    "SKILL.md",
    "loops/CODE-POLICIES.md",
    "loops/plan-new-loop/LOOP.md",
    "loops/plan-refine-loop/LOOP.md",
    "loops/plan-exec-loop/LOOP.md",
    "commands/plan-exec.md",
    "commands/plan-refine.md",
    "artifacts/artifacts-core/CHECKPOINT.md",
  ];

  /** The canonical qualifiers. `CODE-POLICIES.md` owns the reference wording. */
  const CONDITIONAL =
    /only when the change carries|if temporary behavior exists|only when the journey introduces temporary behavior/;

  it("every doc that demands a simulation boundary qualifies the demand", async () => {
    const offenders: string[] = [];
    for (const rel of CARRIERS) {
      const doc = await readFile(join(SKILL_ROOT, rel), "utf8");
      if (!CONDITIONAL.test(doc)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the unconditional forms cannot come back", async () => {
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    const planNew = await readSurface("loops/plan-new-loop/LOOP.md");
    expect(exec).not.toContain("the simulation boundary in force is identifiable");
    expect(planNew).not.toContain("the simulation boundary is located");
  });

  it("conditional never means optional: an active simulation still blocks", async () => {
    // The relaxation is about ABSENCE. Where temporary behavior exists, the
    // retirement and the anti-production rule stay exactly as strict.
    const refine = await readSurface("loops/plan-refine-loop/LOOP.md");
    const policies = await readSurface("loops/CODE-POLICIES.md");
    expect(refine).toContain("one phase owns the retirement");
    expect(refine).toContain("**Removal gate**");
    expect(policies).toContain("no configuration can select them in a production runtime");
  });
});

describe("directed resume contract — resume.md optional argument (spec 004)", () => {
  const RESUME = "commands/resume.md";

  it("declares the optional artifact argument (no longer '(no arguments)')", async () => {
    const text = await readSurface(RESUME);
    expect(text).not.toContain("(no arguments)");
    expect(text).toMatch(/argument-hint:\s*"?\[docs\/specs/);
  });

  it("keeps the read-only hard floor, argument or not", async () => {
    const text = await readSurface(RESUME);
    expect(text).toContain("writes nothing in `docs/` or `.workflow/`");
    expect(text).toContain("with or without an argument");
    // The floor is enforced, not just declared: the resolver reads with
    // `bind: false`, so even the session path records nothing.
    expect(await readFile(RESUME_SERVICE, "utf8")).toContain("bind: false");
  });

  it("the directed target is resolved by the CLI, and the skill only forwards it", async () => {
    const text = await readSurface(RESUME);
    // The skill no longer owns the survey: no slug matching, no `## Origin`
    // reading, no routing table to keep in sync with the runtime.
    expect(text).not.toContain("## Directed resume");
    expect(text).not.toContain("## Routing");
    expect(text).toContain("pass it as the positional");
    expect(text).toContain("aw resume --code");

    const service = await readFile(RESUME_SERVICE, "utf8");
    expect(service).toContain("An explicit target wins");
    expect(service).toContain("never by slug");
  });
});

describe("lazy workspace-init contract — code ↔ doctrine (spec 008)", () => {
  // Init went minimal (docs/ born on demand at `aw next-number`); the gitignore
  // set became CLI-owned; session-close now feeds HISTORY.md. These pins keep
  // the doctrine describing what the code actually does — the drift class that
  // left `aw history-update` orphaned for 18 sessions.
  it("every CLI-owned gitignore entry is documented in workspace-init.md", async () => {
    const { VISIBILITY_GITIGNORE, runtimeGitignoreEntries } = await import(
      "../../src/application/workspace-init-service.js"
    );
    const doc = await readSurface("commands/workspace-init.md");
    for (const entry of [...runtimeGitignoreEntries("workflow"), ...VISIBILITY_GITIGNORE]) {
      expect(doc, `workspace-init.md must document gitignore entry ${entry}`).toContain(entry);
    }
  });

  it("workspace-init.md prescribes the minimal scaffold, on-demand docs/ and the reconcile prune", async () => {
    const doc = await readSurface("commands/workspace-init.md");
    expect(doc).toMatch(/minimal/i);
    expect(doc).toContain("aw next-number");
    expect(doc).toMatch(/on demand/i);
    expect(doc).toMatch(/prune/i);
    expect(doc).toContain("HISTORY.md");
  });

  it("no orientation surface still teaches the OLD upfront docs/ scaffold", async () => {
    // Root SKILL.md is the built-in overview role — the first doc an agent loads;
    // the two READMEs echo the same claim. All three must say on-demand.
    for (const rel of ["SKILL.md", "README.md", "commands/README.md"]) {
      const text = await readFile(join(SKILL_ROOT, rel), "utf8");
      expect(text, `${rel} must not claim init scaffolds docs/ upfront`).not.toMatch(
        /`\.workflow\/` \+ `docs\/`/,
      );
      expect(text, `${rel} must describe the on-demand model`).toMatch(/born on demand/i);
    }
  });

  it("exports/README documents next-number's on-demand creation, --dry-run and --standalone-sql", async () => {
    const readme = await readSurface("exports/README.md");
    expect(readme).toContain("--dry-run");
    expect(readme).toContain("--standalone-sql");
    expect(readme).toMatch(/creates the category folder/i);
  });

  it("every export SKILL routes plan-mode numbering through `aw next-number --dry-run`", async () => {
    for (const name of ["export-scripts", "export-manuals", "export-diagrams", "export-reports"]) {
      const skill = await readFile(join(SKILL_ROOT, `exports/${name}/EXPORT.md`), "utf8");
      expect(skill, `${name} must use --dry-run in plan mode`).toContain(
        "aw next-number --dry-run",
      );
      // Drift fix pinned: in Claude the bundle exposes these as w:<name>, so the
      // command wrapper must not claim they are unreachable by name.
      const command = await readFile(join(SKILL_ROOT, `commands/${name}.md`), "utf8");
      expect(command, `${name}.md must not claim it is unregistered by name`).not.toContain(
        "it is not registered by name",
      );
    }
  });

  it("CHASSIS documents that session-close upserts the HISTORY row (no extra AI step)", async () => {
    const chassis = await readSurface("loops/CHASSIS.md");
    const closeLine = chassis
      .split("\n")
      .find((l) => l.includes("`aw session-close`") && l.includes("HISTORY.md"));
    expect(closeLine).toBeDefined();
  });
});

describe("section cross-references — a § points at the file that actually holds it", () => {
  // The failure class plan 010 introduced: splitting a document into modules
  // leaves every "see `<file>` § *Section*" in the corpus pointing at a file
  // that no longer carries that section. Six of them survived the split and
  // were only found by scanning; this is that scan, made permanent.
  //
  // Matches `<path>` followed by `§ *Section*` on the same line, which is the
  // corpus' one convention for attributing a section to a document.
  const REFERENCE = /`([^`]+\.md)`[^`]*?§\s*\*([^*]+)\*/g;

  /** `## `/`### ` headings, ignoring fenced code. */
  function headings(markdown: string): string[] {
    const out: string[] = [];
    let inFence = false;
    for (const line of markdown.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const match = line.match(/^#{2,3} (.+?)\s*$/);
      if (match?.[1] !== undefined) out.push(match[1]);
    }
    return out;
  }

  /** One reference: the offender string, or null when it resolves. */
  async function checkReference(
    from: string,
    target: string,
    section: string,
  ): Promise<string | null> {
    let body: string;
    try {
      body = await readFile(resolve(join(SKILL_ROOT, from), "..", target), "utf8");
    } catch {
      // A path that does not resolve at all is a different defect; the chassis'
      // relative-reference rule covers the layout cases.
      return null;
    }
    const needle = section.trim();
    const found = headings(body).some((h) => h.includes(needle) || needle.includes(h));
    return found ? null : `${from}: '${target}' has no section '${needle}'`;
  }

  it("every '<file> § *Section*' reference resolves to a section that file still has", async () => {
    const offenders: string[] = [];
    for (const rel of await bundleMdFiles()) {
      const text = await readFile(join(SKILL_ROOT, rel), "utf8");
      for (const [, target, section] of text.matchAll(REFERENCE)) {
        if (target === undefined || section === undefined) continue;
        const offender = await checkReference(rel, target, section);
        if (offender !== null) offenders.push(offender);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// The docs/ taxonomy the CLI owns and the zone the doctrine advertises are two
// declarations of one fact. `designs` entered the taxonomy in plan 012 and had
// to be added to SKILL.md by hand — this guard is what makes the next one fail
// loudly instead of leaving the doctrine describing a zone that no longer exists.
describe("docs/ taxonomy — code and doctrine name the same categories", () => {
  it("every CLI-owned docs/ category appears in the doctrine's docs/ zone", async () => {
    const skill = await readFile(join(SKILL_ROOT, "SKILL.md"), "utf8");
    const lines = skill.split("\n");
    const header = lines.findIndex((line) => line.includes("docs/ ZONE"));
    expect(header, "SKILL.md ya no describe la zona docs/").toBeGreaterThanOrEqual(0);
    const zone = lines.slice(header, header + 3).join("\n");
    const missing = DOCS_FOLDERS.filter((folder) => !zone.includes(folder));
    expect(missing, "categorías que la CLI crea y la doctrina no menciona").toEqual([]);
  });
});

describe("PLAN execution batches — producers, consumer and context graph", () => {
  const MODULE = "modules/PLAN-EXECUTION-BATCHES.md";

  it("all three PLAN commands load the same canonical contract as core", async () => {
    const manifest = JSON.parse(
      await readFile(join(SKILL_ROOT, "context/MANIFEST.json"), "utf8"),
    ) as { commands: Record<string, { core: string[] }> };
    for (const command of ["plan-new", "plan-refine", "plan-exec"]) {
      expect(manifest.commands[command]?.core, command).toContain(MODULE);
    }

    for (const rel of [
      "commands/plan-new.md",
      "commands/plan-refine.md",
      "commands/plan-exec.md",
      "loops/plan-new-loop/LOOP.md",
      "loops/plan-refine-loop/LOOP.md",
      "loops/plan-exec-loop/LOOP.md",
    ]) {
      const surface = await readSurface(rel);
      expect(surface, rel).toContain("# PLAN execution batches");
      expect(surface, rel).toContain("`continuous`");
      expect(surface, rel).toContain("`isolated`");
    }
  });

  it("the representative PLAN journeys measure the new guaranteed document", async () => {
    const corpus = JSON.parse(
      await readFile(resolve(SKILL_ROOT, "..", "..", "tests/fixtures/context-corpus.json"), "utf8"),
    ) as { journeys: Array<{ id: string; read_set: string[] }> };
    for (const id of ["plan-doc", "code-exec"]) {
      const journey = corpus.journeys.find((candidate) => candidate.id === id);
      expect(journey?.read_set, id).toContain(MODULE);
    }
  });

  it("planning declaration and runtime inference remain distinct authorities", async () => {
    const planNew = await readSurface("loops/plan-new-loop/LOOP.md");
    const refine = await readSurface("loops/plan-refine-loop/LOOP.md");
    const exec = await readSurface("loops/plan-exec-loop/LOOP.md");
    expect(planNew).toContain("complete phase partition");
    expect(refine).toContain("re-infers and");
    expect(refine).toContain("writes its complete phase partition");
    expect(exec).toContain("infer the effective batches over pending phases");
    expect(exec).toContain("The declared section remains planning structure");
    expect(exec).toContain("effective batches and any difference are recorded in `CHECKPOINT`");
  });
});
