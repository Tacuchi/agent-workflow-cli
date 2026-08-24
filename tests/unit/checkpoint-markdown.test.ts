import { describe, expect, it } from "vitest";
import type { FilesTouched, TouchedFile } from "../../src/application/checkpoint/files-touched.js";
import {
  formatCheckpointMd,
  isPristineCheckpoint,
} from "../../src/application/checkpoint/markdown.js";
import type { SessionState } from "../../src/application/checkpoint/state-reader.js";

/** An inventory that was read and found nothing — the old `[]`. */
function inventory(overrides: Partial<FilesTouched> = {}): FilesTouched {
  return {
    observed: [{ alias: "workspace", boundary: "/ws", reference: "abc1234def" }],
    unobserved: [],
    linked: [],
    contextual: [],
    omitted: [],
    ...overrides,
  };
}

function touched(path: string, overrides: Partial<TouchedFile> = {}): TouchedFile {
  return {
    unit: "workspace",
    path,
    added: "1",
    removed: "0",
    untracked: false,
    linked: false,
    ...overrides,
  };
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    folder: "session042-dev-foo",
    tasks: { open: 0, closed: 0, total: 0 },
    progress_pct: null,
    last_decision: null,
    artefacts: {},
    files_touched: inventory(),
    origen: null,
    timestamp: "2026-05-08 12:00",
    ...overrides,
  };
}

describe("formatCheckpointMd — EN headings", () => {
  it("emits EN headings (Progress, Last action, Next step, Recent decisions)", () => {
    const md = formatCheckpointMd(baseState());
    expect(md).toContain("# Checkpoint — session042-dev-foo");
    expect(md).toContain("- Updated: 2026-05-08 12:00");
    // Sessions no longer carry a lifecycle phase; the CHECKPOINT has no
    // "Current phase" line (plan-doc phases live as prose, not session state).
    expect(md).not.toContain("Current phase");
    expect(md).toContain("## Last action");
    expect(md).toContain("## Next step");
    expect(md).toContain("## Recent decisions");
    // The heading no longer promises a window the inventory never delivered.
    expect(md).toContain("## Files touched");
    expect(md).not.toContain("post-last-commit");
    expect(md).toContain("## Critical context to resume");
    expect(md).toContain("## Refs");
  });

  it("emits EN default messages when no decisions and no files touched", () => {
    const md = formatCheckpointMd(baseState());
    expect(md).toContain("_No decisions recorded._");
    expect(md).toContain("_No uncommitted changes inside the scope above._");
    expect(md).toContain("_progress unknown (TASKS.md missing or empty)_");
  });

  it("renders progress with EN counter when tasks have totals", () => {
    const md = formatCheckpointMd(
      baseState({
        progress_pct: 60,
        tasks: { open: 2, closed: 3, total: 5 },
      }),
    );
    expect(md).toContain("- Progress: 60% (3 of 5 tasks complete)");
  });

  it("includes last decision in Recent decisions when present", () => {
    const md = formatCheckpointMd(
      baseState({
        last_decision: { id: "DEC-001", excerpt: "use atomic-write at port" },
      }),
    );
    expect(md).toContain("- DEC-001: use atomic-write at port");
    expect(md).not.toContain("_No decisions recorded._");
  });

  it("lists touched files with EN AI directive", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          contextual: [
            touched("src/foo.ts", { added: "10", removed: "2" }),
            touched("src/bar.ts", { added: "0", removed: "5" }),
          ],
        }),
      }),
    );
    expect(md).toContain("- src/foo.ts (+10 -2) — _[AI: purpose in 1 line]_");
    expect(md).toContain("- src/bar.ts (+0 -5) — _[AI: purpose in 1 line]_");
  });

  it("drops the counts rather than the path when they could not be read", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          contextual: [touched("src/foo.ts", { added: null, removed: null })],
        }),
      }),
    );
    expect(md).toContain("- src/foo.ts — _[AI: purpose in 1 line]_");
  });

  it("spells a path from another unit with its alias, so two units cannot collide", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          contextual: [touched("src/foo.ts", { unit: "agent-workflow-cli" })],
        }),
      }),
    );
    expect(md).toContain("- agent-workflow-cli:src/foo.ts (+1 -0)");
  });

  it("declares the truncation of the contextual half with its own count", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          contextual: Array.from({ length: 20 }, (_, i) => touched(`src/file${i}.ts`)),
          omitted: [{ unit: "workspace", count: 5 }],
        }),
      }),
    );
    expect(md).toContain("- _… and 5 more contextual changes not listed (cap 20): workspace 5_");
  });

  it("renders Refs with EN labels (Origin/Artifacts present/Skills used)", () => {
    const md = formatCheckpointMd(
      baseState({
        origen: "analyze:016",
        artefacts: { tasks: true, conclusions: true, scripts_count: 2 },
      }),
    );
    expect(md).toContain("- Origin: analyze:016");
    expect(md).toContain("- Artifacts present: tasks, conclusions, scripts(2)");
    expect(md).toContain("- Skills used: _[AI: list the skills invoked during the session]_");
  });

  it("trailing comment uses EN and carries the generation timestamp", () => {
    const md = formatCheckpointMd(baseState());
    expect(md).toContain(
      "<!-- written by agent-workflow.checkpoint at 2026-05-08 12:00 · template",
    );
  });
});

// ── the seal: what tells an untouched template from written work ─────────────

describe("isPristineCheckpoint", () => {
  it("recognises the bytes it just emitted", () => {
    expect(isPristineCheckpoint(formatCheckpointMd(baseState()))).toBe(true);
  });

  it("seals every rendering, whatever the state produced", () => {
    const md = formatCheckpointMd(
      baseState({
        progress_pct: 60,
        tasks: { open: 2, closed: 3, total: 5 },
        last_decision: { id: "DEC-001", excerpt: "use atomic-write at port" },
        files_touched: inventory({
          contextual: [touched("src/foo.ts", { added: "10", removed: "2" })],
        }),
        origen: "analyze:016",
        artefacts: { tasks: true, scripts_count: 2 },
      }),
    );
    expect(isPristineCheckpoint(md)).toBe(true);
  });

  // The whole defect in one assertion: the template ALWAYS emits `_[AI:`, so a
  // sentinel made of that string can never tell these two files apart.
  it("rejects a template whose placeholders were partially filled in", () => {
    const filled = formatCheckpointMd(baseState()).replace(
      "_[AI: 1-3 sentences on the last concrete progress. Review recent diffs and the latest entry in DECISIONS.md.]_",
      "Cerré el guard de sobrescritura y lo probé con relleno parcial.",
    );
    expect(filled).toContain("_[AI:");
    expect(isPristineCheckpoint(filled)).toBe(false);
  });

  it("rejects a file that only gained a line at the end, before the seal", () => {
    const md = formatCheckpointMd(baseState());
    expect(isPristineCheckpoint(md.replace("## Refs\n", "## Refs\n\n- Nota mía\n"))).toBe(false);
  });

  it("rejects a checkpoint written by a version that predates the seal", () => {
    const legacy = [
      "# Checkpoint — session042-dev-foo",
      "",
      "- Updated: 2026-05-08 12:00",
      "",
      "## Last action",
      "",
      "Lo que hice ayer.",
      "",
      "<!-- written by agent-workflow.checkpoint at 2026-05-08 12:00 -->",
      "",
    ].join("\n");
    expect(isPristineCheckpoint(legacy)).toBe(false);
  });

  // Forging the sentinel used to be as cheap as leaving the template's own
  // string in place; forging this one means computing the digest of the file.
  it("rejects a seal copied onto content it does not measure", () => {
    const md = formatCheckpointMd(baseState());
    const seal = md.slice(md.lastIndexOf("<!-- written by"));
    expect(isPristineCheckpoint(`# Checkpoint — otra cosa\n\n${seal}`)).toBe(false);
  });
});

// ── the section explains itself: spec 038 · F3 ───────────────────────────────

describe("la sección de archivos tocados se explica sola (spec 038)", () => {
  it("AC-03: declara el límite de cada unidad y la referencia contra la que lo lee", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          observed: [
            { alias: "workspace", boundary: "/hub/projects/ws", reference: "1e669a0a1066f0b" },
            { alias: "agent-workflow-cli", boundary: "/units/cli", reference: null },
          ],
          contextual: [touched("docs/x.md")],
        }),
      }),
    );
    expect(md).toContain("workspace at `/hub/projects/ws` (vs 1e669a0)");
    // A repository with no commit yet is said so, never shown as a fake ref.
    expect(md).toContain("agent-workflow-cli at `/units/cli` (no commit yet)");
    // AC-04 read out loud: this is the tree now, not a window over the session.
    expect(md).toContain("not a window over the session");
  });

  it("AC-05: las rutas vinculadas van primero y el tope no las puede desplazar", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          linked: [touched("docs/plans/037-plan.md", { linked: true })],
          contextual: Array.from({ length: 20 }, (_, i) => touched(`src/file${i}.ts`)),
          omitted: [{ unit: "workspace", count: 700 }],
        }),
      }),
    );
    // The per-file directive only — `## Refs` carries an `_[AI: …]_` of its own.
    const lines = md
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.endsWith("— _[AI: purpose in 1 line]_"));
    expect(lines[0]).toContain("docs/plans/037-plan.md");
    // 1 linked + 20 contextual: the cap bounds the contextual half alone.
    expect(lines).toHaveLength(21);
    expect(md).toContain(
      "- _… and 700 more contextual changes not listed (cap 20): workspace 700_",
    );
  });

  it("AC-06: una unidad inobservable se nombra y el parcial se publica igual", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          observed: [{ alias: "workspace", boundary: "/ws", reference: "abc1234" }],
          unobserved: [
            { alias: "agent-workflow-cli", boundary: "/units/cli", reason: "not a git repository" },
          ],
          contextual: [touched("docs/x.md")],
        }),
      }),
    );
    expect(md).toContain(
      "- **Not observed — agent-workflow-cli** at `/units/cli`: not a git repository",
    );
    expect(md).toContain("- docs/x.md (+1 -0)");
  });

  it("AC-06: cero entradas con una unidad caída NO se presenta como árbol limpio", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          observed: [],
          unobserved: [{ alias: "workspace", boundary: "/ws", reason: "git status failed" }],
        }),
      }),
    );
    // The exact sentence the old code printed for a failed collection.
    expect(md).not.toContain("No uncommitted changes");
    expect(md).toContain("- **Not observed — workspace** at `/ws`: git status failed");
    expect(md).toContain("_No unit in scope could be read — see the declaration above._");
  });

  // Calling a pure function twice on one object cannot fail and proves nothing.
  // What is worth pinning is that the renderer does NOT reorder: the total order
  // is the collection's job, and a renderer that re-sorted would hide a
  // collection that had stopped ordering at all.
  it("AC-07: el render respeta el orden que le entrega la recolección, sin reordenar", () => {
    const md = formatCheckpointMd(
      baseState({
        files_touched: inventory({
          linked: [touched("zz-vinculada.md", { linked: true })],
          contextual: [touched("src/b.ts"), touched("src/a.ts")],
          omitted: [{ unit: "workspace", count: 3 }],
        }),
      }),
    );
    const listed = md
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.endsWith("— _[AI: purpose in 1 line]_"))
      .map((l) => l.slice(2).split(" ")[0]);
    // Linked first even though it sorts last alphabetically, and the contextual
    // pair kept in the order received rather than alphabetised by the renderer.
    expect(listed).toEqual(["zz-vinculada.md", "src/b.ts", "src/a.ts"]);
  });
});
