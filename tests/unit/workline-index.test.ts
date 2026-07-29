import { describe, expect, it } from "vitest";
import { parseSpecRelation } from "../../src/application/parsers/spec-relation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const fakeEnv = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 6, 29, 12, 0, 0);

function paths(): PathsService {
  return new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
}

function index(fs: MemFs) {
  return buildWorklineIndex(fs, fakeEnv, paths(), { now: NOW });
}

// ── spec→plan evidence ───────────────────────────────────────────────────────

describe("parseSpecRelation — level 1: the Derived from header", () => {
  it("reads the spec number out of the header blockquote", () => {
    const plan =
      "# Plan 009 — x\n\n> Derived from docs/specs/012-spec-x.md\n\n## Origin\n\n- nada\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "012",
      evidence: "derived-from",
    });
  });

  it("tolerates the backticked path older plans wrote", () => {
    const plan =
      "# Plan 001\n\n> Derived from `docs/specs/002-spec-retomar.md`\n\n## Origin\n\n- x\n";
    expect(parseSpecRelation(plan)).toMatchObject({ status: "declared", number: "002" });
  });

  it("ignores a Derived from that appears in the body, not the header", () => {
    const plan =
      "# Plan 004\n\n## Origin\n\n- nada\n\n## Notes\n\nDerived from docs/specs/007-spec-y.md\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });
});

describe("parseSpecRelation — level 2: an explicit path inside ## Origin", () => {
  it("resolves when the header carries no Derived from", () => {
    const plan = "# Plan 002\n\n## Origin\n\n- Spec: docs/specs/003-spec-minimality.md\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "003",
      evidence: "origin-path",
    });
  });

  it("never outranks the header declaration", () => {
    const plan =
      "# Plan 009\n\n> Derived from docs/specs/012-spec-x.md\n\n## Origin\n\n- ver docs/specs/003-spec-otra.md\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "012",
      evidence: "derived-from",
    });
  });
});

describe("parseSpecRelation — level 3: a Spec NNN reference inside ## Origin", () => {
  it("accepts an unambiguous reference as the weakest evidence", () => {
    const plan =
      "# Plan 008\n\n## Origin\n\nSpec 011 (`ready-for-plan`), refinada en la sesión 047.\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "declared",
      number: "011",
      evidence: "spec-reference",
    });
  });

  // The scoping that matters: plans routinely name sibling specs under
  // `## Dependencies` ("la spec 009 consumirá…"). That is not provenance.
  it("ignores a spec named outside ## Origin", () => {
    const plan =
      "# Plan 009\n\n## Origin\n\n- planificado a mano\n\n## Dependencies\n\n- la spec 009 consumirá esto\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });

  it("does not read a bare number as a spec reference", () => {
    const plan = "# Plan 009\n\n## Origin\n\nRefinada en la sesión 047, baseline 044.\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });
});

describe("parseSpecRelation — contradictions and silence", () => {
  it("reports ambiguous when the header names two different specs", () => {
    const plan =
      "# Plan\n\n> Derived from docs/specs/003-spec-a.md and docs/specs/004-spec-b.md\n\n## Origin\n\n- x\n";
    expect(parseSpecRelation(plan)).toEqual({
      status: "ambiguous",
      numbers: ["003", "004"],
      evidence: "derived-from",
    });
  });

  it("reports ambiguous when ## Origin names two different spec paths", () => {
    const plan = "# Plan\n\n## Origin\n\n- docs/specs/003-spec-a.md\n- docs/specs/009-spec-b.md\n";
    expect(parseSpecRelation(plan)).toMatchObject({ status: "ambiguous", evidence: "origin-path" });
  });

  it("collapses the same spec named twice into one declaration", () => {
    const plan =
      "# Plan\n\n## Origin\n\n- docs/specs/003-spec-a.md\n- otra vez docs/specs/003-spec-a.md\n";
    expect(parseSpecRelation(plan)).toMatchObject({ status: "declared", number: "003" });
  });

  // The whole reason this parser exists: the old association matched by slug.
  it("never infers a relation from a matching slug", () => {
    const plan = "# Plan foo\n\n## Origin\n\n- trabajo sobre foo\n";
    expect(parseSpecRelation(plan)).toEqual({ status: "absent" });
  });
});

// ── the index ────────────────────────────────────────────────────────────────

function workspace(): MemFs {
  const fs = new MemFs();
  fs.file("/cwd/.workflow/sessions/.keep", "");
  return fs;
}

const READY = "---\nstatus: ready-for-plan\n---\n\n# Spec\n";
const DRAFT = "---\nstatus: draft\n---\n\n# Spec\n";

describe("buildWorklineIndex — the spec→plan relation drives what is unplanned", () => {
  it("drops a spec from the pipeline once a plan proves it derives from it", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n> Derived from docs/specs/003-spec-a.md\n\n## Tasks\n- [x] T1\n",
    );
    const out = await index(fs);

    expect(out.plans[0]?.spec).toEqual({
      status: "resolved",
      number: "003",
      file: "docs/specs/003-spec-a.md",
      evidence: "derived-from",
    });
    expect(out.pipeline).toEqual([]);
  });

  it("keeps the spec pending when the plan proves nothing", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);
    fs.file("/cwd/docs/plans/001-plan-a.md", "# Plan\n\n> Estado: done\n\n## Tasks\n- [x] T1\n");
    const out = await index(fs);

    expect(out.plans[0]?.spec).toEqual({ status: "unknown", reason: "no-evidence" });
    expect(out.pipeline.map((p) => p.kind)).toEqual(["spec-unplanned"]);
  });

  it("keeps the spec pending when the plan's evidence is ambiguous", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);
    fs.file("/cwd/docs/specs/004-spec-b.md", READY);
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n\n## Origin\n\n- docs/specs/003-spec-a.md\n- docs/specs/004-spec-b.md\n\n## Tasks\n- [x] T1\n",
    );
    const out = await index(fs);

    expect(out.plans[0]?.spec).toMatchObject({ status: "ambiguous" });
    expect(out.pipeline.map((p) => p.number)).toEqual(["003", "004"]);
  });

  it("reports spec-not-found when the declared spec is not in the workspace", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n> Derived from docs/specs/099-spec-ghost.md\n\n## Tasks\n- [x] T1\n",
    );
    const out = await index(fs);
    expect(out.plans[0]?.spec).toEqual({ status: "unknown", reason: "spec-not-found" });
  });
});

describe("buildWorklineIndex — pipeline order", () => {
  it("ranks unrefined spec → unplanned spec → open plan → orphan checkpoint", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-draft.md", DRAFT);
    fs.file("/cwd/docs/specs/002-spec-ready.md", READY);
    fs.file("/cwd/docs/plans/005-plan-open.md", "# Plan\n\n## Tasks\n- [ ] T1\n");
    fs.file(
      "/cwd/.workflow/sessions/010-suelta-quick/SESSION.md",
      "# SESSION\n\n## Objective\nalgo suelto\n\n## Origin\n- prompt directo\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/010-suelta-quick/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- x\n",
    );

    const out = await index(fs);
    expect(out.pipeline.map((p) => p.kind)).toEqual([
      "spec-unrefined",
      "spec-unplanned",
      "plan-open",
      "checkpoint-orphan",
    ]);
  });

  it("puts a started plan ahead of an untouched one", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/plans/002-plan-untouched.md", "# Plan\n\n## Tasks\n- [ ] T1\n- [ ] T2\n");
    fs.file("/cwd/docs/plans/008-plan-started.md", "# Plan\n\n## Tasks\n- [x] T1\n- [ ] T2\n");

    const out = await index(fs);
    // 008 outranks 002 despite the higher number: progress beats numbering.
    expect(out.pipeline.map((p) => p.number)).toEqual(["008", "002"]);
    expect(out.pipeline[0]?.started).toBe(true);
  });

  it("leaves same-priority candidates tied instead of breaking by date", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-vieja.md", DRAFT, new Date(2020, 0, 1));
    fs.file("/cwd/docs/specs/002-spec-nueva.md", DRAFT, new Date(2026, 6, 28));

    const out = await index(fs);
    expect(out.pipeline).toHaveLength(2);
    expect(new Set(out.pipeline.map((p) => p.priority))).toEqual(new Set([1]));
  });

  it("excludes a done plan and keeps an inconsistent one", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/plans/001-plan-done.md", "# Plan\n\n> Estado: done\n\n## Tasks\n- [x] T1\n");
    fs.file(
      "/cwd/docs/plans/002-plan-inconsistent.md",
      "# Plan\n\n> Estado: done\n\n## Tasks\n- [x] T1\n- [ ] T2\n",
    );

    const out = await index(fs);
    expect(out.plans.map((p) => p.plan_state)).toEqual(["done", "inconsistent"]);
    expect(out.pipeline.map((p) => p.number)).toEqual(["002"]);
  });

  it("does not treat a session whose Origin names a doc as an orphan checkpoint", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/.workflow/sessions/011-x-plan-exec/SESSION.md",
      "# SESSION\n\n## Objective\nejecutar\n\n## Origin\n- docs/plans/005-plan-open.md\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/011-x-plan-exec/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- x\n",
    );

    const out = await index(fs);
    expect(out.sessions[0]?.linked_doc).toBe("docs/plans/005-plan-open.md");
    expect(out.pipeline).toEqual([]);
  });

  it("ignores a closed session even when it holds a checkpoint", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/.workflow/sessions/012-cerrada-quick/SESSION.md",
      "# SESSION\n\n## Objective\nx\n",
    );
    fs.file(
      "/cwd/.workflow/sessions/012-cerrada-quick/CHECKPOINT.md",
      "# CHECKPOINT\n\n## Completed\n- x\n",
    );
    fs.file("/cwd/.workflow/sessions/012-cerrada-quick/.closed", "");

    const out = await index(fs);
    expect(out.pipeline).toEqual([]);
  });
});
