import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { GitFlowResult } from "../../src/application/git-flow-service.js";
import { FlowResultView } from "../../src/cli/tui/components/git-flow-actions.js";

describe("FlowResultView", () => {
  it("renders an ok run as completed with its step names", () => {
    const result: GitFlowResult = {
      action: "sync",
      dry_run: false,
      status: "ok",
      results: [
        {
          source: "alpha",
          status: "ok",
          steps: [
            { step: "merge prod→work", status: "ok" },
            { step: "push work", status: "ok" },
          ],
        },
      ],
    };
    const { lastFrame } = render(<FlowResultView action="sync" result={result} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("completed");
    expect(f).toContain("merge prod→work");
    expect(f).toContain("push work");
  });

  it("rotula cada acción, to-dev incluida", () => {
    const result: GitFlowResult = {
      action: "to-dev",
      dry_run: false,
      status: "ok",
      results: [{ source: "alpha", status: "ok", steps: [{ step: "push develop", status: "ok" }] }],
    };
    const { lastFrame } = render(<FlowResultView action="to-dev" result={result} />);
    expect(lastFrame() ?? "").toContain("GIT FLOW · → DEV"); // SectionHead uppercases
  });

  it("renders a conflict as paused with the conflicted files and the re-run hint", () => {
    const result: GitFlowResult = {
      action: "sync",
      dry_run: false,
      status: "conflict",
      results: [
        {
          source: "alpha",
          status: "conflict",
          steps: [{ step: "merge prod→work", status: "conflict", detail: "paused on prod" }],
          paused_at: "certificacion",
          conflicted_files: ["src/Foo.java"],
        },
      ],
    };
    const { lastFrame } = render(<FlowResultView action="sync" result={result} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("paused on conflict");
    expect(f).toContain("src/Foo.java");
    expect(f.toLowerCase()).toContain("re-run");
  });
});
