import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowTab } from "../../src/cli/tui/tabs/workflow-tab.js";
import type { CliContext } from "../../src/cli/types.js";

// WorkflowTab only reads `isActive` + the hardcoded WORKFLOW_CONTENT; `ctx` is
// unused, so a bare cast is enough to render.
const ctx = {} as unknown as CliContext;

// Collapse wrapping + the 2-column layout's whitespace so phrase assertions are
// robust against where ink breaks lines.
function flatFrame(): string {
  const { lastFrame } = render(<WorkflowTab ctx={ctx} isActive />);
  return (lastFrame() ?? "").replace(/\s+/g, " ");
}

describe("WorkflowTab", () => {
  it("surfaces the chassis framing in the overview (persistent goal + verification-first)", () => {
    const frame = flatFrame();
    expect(frame).toContain("persistent goal");
    expect(frame).toContain("verification-first");
    expect(frame).toContain("Success criteria");
  });

  it("renders the bootstrap + 3 flows + export as phase cards", () => {
    const frame = flatFrame();
    for (const title of ["Workspace init", "SPEC", "PLAN", "QUICK", "Export"]) {
      expect(frame).toContain(title);
    }
  });

  it("QUICK card reflects non-code deliverables (analysis/design)", () => {
    expect(flatFrame()).toContain("analysis/design");
  });
});
