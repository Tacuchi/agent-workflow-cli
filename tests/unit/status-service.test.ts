import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const fakeEnv = new FakeEnv("/home", "/cwd");

function paths(): PathsService {
  return new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
}

const NOW = new Date(2026, 5, 21, 15, 0, 0); // Sun 2026-06-21 15:00 local

// ── fixture ──────────────────────────────────────────────────────────────────

function fullWorkspace(): FakeFs {
  const fs = new FakeFs();
  fs.file(
    "/cwd/CLAUDE.md",
    "<!-- WORKFLOW-PROJECT-START -->\n## Proyecto\nmi-workspace\n<!-- WORKFLOW-PROJECT-END -->\n",
  );
  // specs
  fs.file(
    "/cwd/docs/specs/003-spec-foo.md",
    "# Spec foo\n\n## Refinement decisions\n- d1\n\n## Q&A traceability\n- q→a\n\n## Open questions\nNone\n",
    new Date(2026, 5, 13, 15, 0, 0), // 8 days → "la semana pasada"
  );
  fs.file(
    "/cwd/docs/specs/004-spec-bar.md",
    "# Spec bar\n\n## Open questions\n- ¿qué pasa con XP?\n- ¿soporte ARM?\n",
    new Date(2026, 5, 21, 9, 0, 0), // today, morning
  );
  // plan
  fs.file(
    "/cwd/docs/plans/007-plan-foo.md",
    "# Plan foo\n\n## Tasks\n- [x] T1\n- [x] T2\n- [ ] T3\n- [ ] T4\n- [ ] T5\n",
    new Date(2026, 5, 19, 15, 0, 0), // 2 days ago
  );
  // active session: refine + BACKLOG Deferred
  fs.file(
    "/cwd/.workflow/sessions/001-spec-refine/SESSION.md",
    "# SESSION — 001-spec-refine\n\n## Objective\nRefinar spec\n\n## Origin\n- spec-refine-loop\n\n## Type\nrefine\n",
    new Date(2026, 5, 21, 10, 0, 0), // today, morning
  );
  fs.file(
    "/cwd/.workflow/sessions/001-spec-refine/BACKLOG.md",
    "# BACKLOG\n\n## Deferred\n- soporte XP: baja prioridad\n",
    new Date(2026, 5, 21, 10, 0, 0),
  );
  // closed session: exec + CHECKPOINT Excluded (legacy `(list):` heading → loose match)
  fs.file(
    "/cwd/.workflow/sessions/002-plan-exec/SESSION.md",
    "# SESSION — 002-plan-exec\n\n## Objective\nEjecutar plan\n\n## Type\nexec\n",
    new Date(2026, 5, 20, 14, 0, 0), // yesterday afternoon
  );
  fs.file(
    "/cwd/.workflow/sessions/002-plan-exec/CHECKPOINT.md",
    "# CHECKPOINT\n\n## Excluded (list):\n- fase 9: fuera de alcance\n",
    new Date(2026, 5, 20, 14, 0, 0),
  );
  fs.file("/cwd/.workflow/sessions/002-plan-exec/.closed", "");
  return fs;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("runStatusCommand — full dashboard", () => {
  it("aggregates workspace, specs, plans, sessions, discarded", async () => {
    const out = await runStatusCommand(fullWorkspace(), fakeEnv, paths(), { now: NOW });

    expect(out.workspace).toEqual({ name: "mi-workspace", path: "/cwd", initialized: true });

    // specs
    expect(out.specs).toHaveLength(2);
    const foo = out.specs.find((s) => s.number === "003");
    const bar = out.specs.find((s) => s.number === "004");
    expect(foo).toMatchObject({
      slug: "foo",
      refined: true,
      open_questions: 0,
      file: "docs/specs/003-spec-foo.md",
      relative: "la semana pasada",
    });
    expect(bar).toMatchObject({ slug: "bar", refined: false, open_questions: 2 });
    expect(bar?.relative).toBe("hoy en la mañana");

    // plans
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0]).toMatchObject({
      number: "007",
      slug: "foo",
      tasks_total: 5,
      tasks_done: 2,
      progress_pct: 40,
      relative: "hace 2 días",
    });

    // sessions
    expect(out.sessions.active).toHaveLength(1);
    expect(out.sessions.closed).toHaveLength(1);
    expect(out.sessions.active[0]).toMatchObject({
      folder: "001-spec-refine",
      type: "refine",
      relative: "hoy en la mañana",
    });
    expect(out.sessions.closed[0]).toMatchObject({
      folder: "002-plan-exec",
      type: "exec",
      relative: "ayer en la tarde",
    });

    // discarded — 1 deferred (BACKLOG) + 1 excluded (CHECKPOINT, loose `(list):` heading)
    expect(out.discarded).toHaveLength(2);
    const deferred = out.discarded.find((d) => d.kind === "deferred");
    const excluded = out.discarded.find((d) => d.kind === "excluded");
    expect(deferred).toMatchObject({
      text: "soporte XP: baja prioridad",
      source: "001-spec-refine",
    });
    expect(excluded).toMatchObject({ text: "fase 9: fuera de alcance", source: "002-plan-exec" });

    // counts
    expect(out.counts).toEqual({
      specs: 2,
      specs_refined: 1,
      plans: 1,
      sessions_active: 1,
      sessions_closed: 1,
      discarded: 2,
    });
  });

  it("refined mark = ## Refinement decisions alone; legacy specs with both sections stay refined", async () => {
    const fs = new FakeFs();
    fs.file("/cwd/.workflow/sessions/.keep", "");
    // New-model refined spec: single trace section, no Q&A traceability.
    fs.file(
      "/cwd/docs/specs/005-spec-slim.md",
      "# Spec slim\n\n## Refinement decisions\n- d1\n- Q: ¿alcance? → mínimo — menos riesgo\n",
      NOW,
    );
    // Legacy refined spec: both sections — must keep counting as refined.
    fs.file(
      "/cwd/docs/specs/006-spec-legacy.md",
      "# Spec legacy\n\n## Refinement decisions\n- d1\n\n## Q&A traceability\n- q→a\n",
      NOW,
    );
    const out = await runStatusCommand(fs, fakeEnv, paths(), { now: NOW });
    expect(out.specs.find((s) => s.number === "005")?.refined).toBe(true);
    expect(out.specs.find((s) => s.number === "006")?.refined).toBe(true);
    expect(out.counts.specs_refined).toBe(2);
    // Omitted ## Open questions counts as zero (slim schema drops it when empty).
    expect(out.specs.find((s) => s.number === "005")?.open_questions).toBe(0);
  });

  it("session type falls back to the folder suffix when SESSION.md has no ## Type", async () => {
    const fs = new FakeFs();
    fs.file(
      "/cwd/.workflow/sessions/003-otp-plan-exec/SESSION.md",
      "# SESSION — 003-otp-plan-exec\n\n## Objective\nEjecutar plan\n\n## Success criteria\n- [ ]\n",
      NOW,
    );
    const out = await runStatusCommand(fs, fakeEnv, paths(), { now: NOW });
    expect(out.sessions.active[0]).toMatchObject({
      folder: "003-otp-plan-exec",
      type: "exec",
    });
  });

  it("drops legacy NNN-spec-refined.md when the base spec exists", async () => {
    const fs = fullWorkspace();
    fs.file(
      "/cwd/docs/specs/003-spec-refined.md",
      "# old refined\n",
      new Date(2026, 5, 1, 9, 0, 0),
    );
    const out = await runStatusCommand(fs, fakeEnv, paths(), { now: NOW });
    expect(out.specs.filter((s) => s.number === "003")).toHaveLength(1);
    expect(out.specs.find((s) => s.number === "003")?.slug).toBe("foo");
  });
});

describe("runStatusCommand — edge cases", () => {
  it("uninitialized workspace: initialized=false, everything empty, name from basename", async () => {
    const out = await runStatusCommand(new FakeFs(), fakeEnv, paths(), { now: NOW });
    expect(out.workspace).toEqual({ name: "cwd", path: "/cwd", initialized: false });
    expect(out.specs).toEqual([]);
    expect(out.plans).toEqual([]);
    expect(out.sessions).toEqual({ active: [], closed: [] });
    expect(out.discarded).toEqual([]);
    expect(out.counts.specs).toBe(0);
  });

  it("missing docs/specs and a plan with 0 tasks", async () => {
    const fs = new FakeFs();
    fs.file("/cwd/.workflow/sessions/.keep", ""); // initialized, no sessions
    fs.file("/cwd/docs/plans/001-plan-empty.md", "# Plan\n\n## Tasks\n(none yet)\n", NOW);
    const out = await runStatusCommand(fs, fakeEnv, paths(), { now: NOW });
    expect(out.workspace.initialized).toBe(true);
    expect(out.specs).toEqual([]);
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0]).toMatchObject({ tasks_total: 0, tasks_done: 0, progress_pct: 0 });
  });
});
