import { describe, expect, it } from "vitest";
import { formatCheckpointMd } from "../../src/application/checkpoint/markdown.js";
import type { SessionState } from "../../src/application/checkpoint/state-reader.js";

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    code: "042",
    name: "dev-foo",
    folder: "session042-dev-foo",
    branches: [],
    tasks: { open: 0, closed: 0, total: 0 },
    progress_pct: null,
    decisions_count: 0,
    last_decision: null,
    artefacts: {},
    files_touched: [],
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
    expect(md).toContain("## Files touched (post-last-commit)");
    expect(md).toContain("## Critical context to resume");
    expect(md).toContain("## Refs");
  });

  it("emits EN default messages when no decisions and no files touched", () => {
    const md = formatCheckpointMd(baseState());
    expect(md).toContain("_No decisions recorded._");
    expect(md).toContain("_No uncommitted changes detected in cwd._");
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
        files_touched: [
          { path: "src/foo.ts", added: 10, removed: 2 },
          { path: "src/bar.ts", added: 0, removed: 5 },
        ],
      }),
    );
    expect(md).toContain("- src/foo.ts (+10 -2) — _[AI: purpose in 1 line]_");
    expect(md).toContain("- src/bar.ts (+0 -5) — _[AI: purpose in 1 line]_");
  });

  it("truncates files_touched to 20 with EN ellipsis line", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file${i}.ts`,
      added: 1,
      removed: 0,
    }));
    const md = formatCheckpointMd(baseState({ files_touched: files }));
    expect(md).toContain("- _… and 5 more_");
  });

  it("renders Refs with EN labels (Origin/Branches/Artifacts present/Skills used)", () => {
    const md = formatCheckpointMd(
      baseState({
        origen: "analyze:016",
        branches: ["agent-workflow:feature/r3"],
        artefacts: { tasks: true, conclusions: true, scripts_count: 2 },
      }),
    );
    expect(md).toContain("- Origin: analyze:016");
    expect(md).toContain("- Branches: agent-workflow:feature/r3");
    expect(md).toContain("- Artifacts present: tasks, conclusions, scripts(2)");
    expect(md).toContain("- Skills used: _[AI: list the skills invoked during the session]_");
  });

  it("trailing comment uses EN", () => {
    const md = formatCheckpointMd(baseState());
    expect(md).toContain("<!-- written by agent-workflow.checkpoint at 2026-05-08 12:00 -->");
  });
});
