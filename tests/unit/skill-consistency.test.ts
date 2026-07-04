import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESCRIPTION_MAX } from "../../src/application/plugin-doctor/skills.js";
import { parseSkillFrontmatter } from "../../src/domain/skill-frontmatter.js";

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

  it("every bundle SKILL.md respects the Agent Skills description cap the doctor enforces on third parties", async () => {
    // On flatten hosts (warp/oz) every sub-skill description enters the per-session
    // skill listing, so overflow is both a standard violation and a token tax.
    const files = (await bundleMdFiles()).filter((f) => f.endsWith("SKILL.md"));
    files.push("SKILL.md", join("harness", "SKILL.md"));
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
  const QUICK_LOOP = "loops/quick-loop/SKILL.md";

  it("quick-loop names both escalation targets, in both layouts (normal tree + flattened w- prefix)", async () => {
    const quick = await readFile(join(SKILL_ROOT, QUICK_LOOP), "utf8");
    // The refs are load-bearing (the transition loads these docs), and the
    // flattened spelling must survive for warp/oz installs where loops live
    // as sibling `w-<loop>/` skills.
    expect(quick).toContain("spec-refine-loop/SKILL.md");
    expect(quick).toContain("spec-new.md");
    expect(quick).toContain("w-spec-refine-loop");
  });

  it("the escalation targets exist on disk (anti-rename guard)", async () => {
    await expect(
      readFile(join(SKILL_ROOT, "loops/spec-refine-loop/SKILL.md"), "utf8"),
    ).resolves.toBeTruthy();
    await expect(readFile(join(SKILL_ROOT, "commands/spec-new.md"), "utf8")).resolves.toBeTruthy();
  });

  it("the size gate runs BEFORE the quick session is created (Sequence order)", async () => {
    const quick = await readFile(join(SKILL_ROOT, QUICK_LOOP), "utf8");
    const seq = quick.slice(quick.indexOf("## Sequence"));
    const gate = seq.indexOf("exceeds a quick");
    const create = seq.indexOf('create_or_resume("<slug>-quick")');
    expect(gate).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(create);
  });

  it("spec-refine-loop declares the quick escalation as a second Started-by path", async () => {
    const refine = await readFile(join(SKILL_ROOT, "loops/spec-refine-loop/SKILL.md"), "utf8");
    const startedBy = refine.match(/## Started by[\s\S]*?(?=\n## )/)?.[0] ?? "";
    expect(startedBy).toMatch(/quick/);
    expect(startedBy).toMatch(/escalation/i);
  });

  it("spec-new keeps its hard single-pass rule and gains the escalation-reuse note", async () => {
    const specNew = await readFile(join(SKILL_ROOT, "commands/spec-new.md"), "utf8");
    expect(specNew).toContain("NO RESEARCH");
    expect(specNew).toMatch(/quick/);
  });

  it("command and loop agree: SPEC live, PLAN deferred (asymmetry pinned)", async () => {
    const quickCmd = await readFile(join(SKILL_ROOT, "commands/quick.md"), "utf8");
    const quickLoop = await readFile(join(SKILL_ROOT, QUICK_LOOP), "utf8");
    expect(quickCmd).toMatch(/live/i);
    expect(quickLoop).toMatch(/live/i);
    expect(quickLoop).toMatch(/PLAN[^\n]*deferred/i);
  });

  it("the root orientation records the consented exception to the continuity rule", async () => {
    const root = await readFile(join(SKILL_ROOT, "SKILL.md"), "utf8");
    expect(root).toMatch(/accepted escalation|explicit consent/i);
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
    const doc = await readFile(join(SKILL_ROOT, "commands/workspace-init.md"), "utf8");
    for (const entry of [...runtimeGitignoreEntries("workflow"), ...VISIBILITY_GITIGNORE]) {
      expect(doc, `workspace-init.md must document gitignore entry ${entry}`).toContain(entry);
    }
  });

  it("workspace-init.md prescribes the minimal scaffold, on-demand docs/ and the reconcile prune", async () => {
    const doc = await readFile(join(SKILL_ROOT, "commands/workspace-init.md"), "utf8");
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
    const readme = await readFile(join(SKILL_ROOT, "exports/README.md"), "utf8");
    expect(readme).toContain("--dry-run");
    expect(readme).toContain("--standalone-sql");
    expect(readme).toMatch(/creates the category folder/i);
  });

  it("every export SKILL routes plan-mode numbering through `aw next-number --dry-run`", async () => {
    for (const name of ["export-scripts", "export-manuals", "export-diagrams", "export-reports"]) {
      const skill = await readFile(join(SKILL_ROOT, `exports/${name}/SKILL.md`), "utf8");
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
    const chassis = await readFile(join(SKILL_ROOT, "loops/CHASSIS.md"), "utf8");
    const closeLine = chassis
      .split("\n")
      .find((l) => l.includes("`aw session-close`") && l.includes("HISTORY.md"));
    expect(closeLine).toBeDefined();
  });
});
