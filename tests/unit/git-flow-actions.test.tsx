import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { GitFlowActions } from "../../src/cli/tui/components/git-flow-actions.js";
import type { CliContext } from "../../src/cli/types.js";

const ENTER = "\r";
const tick = () => new Promise((r) => setTimeout(r, 60));
const noop = () => {};

const MARKERS = { start: "<!-- WORKFLOW-PROJECT-START -->", end: "<!-- WORKFLOW-PROJECT-END -->" };

function workspaceMd(): string {
  return [
    MARKERS.start,
    "## Proyecto",
    "",
    "WS",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    "| alpha | /src/alpha | certificacion |",
    "",
    "## Status",
    "",
    "- Ramas de trabajo actuales:",
    "  - alpha: feature/x",
    MARKERS.end,
  ].join("\n");
}

interface FakeGitOptions {
  /** Branch name whose merge should conflict. */
  conflictOn?: string;
}

function buildCtx({ conflictOn }: FakeGitOptions = {}): CliContext {
  return {
    fs: {
      exists: async (p: string) => p === "/ws/CLAUDE.md",
      readText: async () => workspaceMd(),
    },
    git: {
      isMerging: async () => false,
      isDirty: async () => false,
      currentBranch: async () => "feature/x",
      checkout: async () => {},
      pull: async () => {},
      push: async () => {},
      merge: async (_repo: string, from: string) =>
        from === conflictOn
          ? { ok: false, conflicted: ["src/Foo.java"] }
          : { ok: true, conflicted: [] },
      conflictedFiles: async () => ["src/Foo.java"],
    },
    paths: {
      workspaceDir: () => "/ws",
      blockMarkers: () => MARKERS,
    },
  } as unknown as CliContext;
}

describe("GitFlowActions", () => {
  it("renders the target picker with sources, an all-sources row and the action keys", () => {
    const { lastFrame } = render(
      <GitFlowActions ctx={buildCtx()} aliases={["alpha"]} isActive onClose={noop} />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("alpha");
    expect(f).toContain("all sources");
    expect(f).toContain("Actualizar");
    expect(f).toContain("→ QA");
    expect(f).toContain("→ Prod");
  });

  it("runs sync and renders the step sequence as ok", async () => {
    const { stdin, lastFrame } = render(
      <GitFlowActions ctx={buildCtx()} aliases={["alpha"]} isActive onClose={noop} />,
    );
    await tick();
    stdin.write("a"); // "Actualizar" = sync
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("completed");
    expect(f).toContain("merge prod→work");
  });

  it("pauses on a merge conflict and shows the conflicted files + re-run hint", async () => {
    const { stdin, lastFrame } = render(
      <GitFlowActions
        ctx={buildCtx({ conflictOn: "certificacion" })}
        aliases={["alpha"]}
        isActive
        onClose={noop}
      />,
    );
    await tick();
    stdin.write("a"); // sync → merge certificacion→feature/x conflicts
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("paused on conflict");
    expect(f).toContain("src/Foo.java");
    expect(f.toLowerCase()).toContain("re-run");
  });

  it("esc on the picker closes the affordance", async () => {
    let closed = false;
    const { stdin } = render(
      <GitFlowActions
        ctx={buildCtx()}
        aliases={["alpha"]}
        isActive
        onClose={() => {
          closed = true;
        }}
      />,
    );
    await tick();
    stdin.write("\x1b"); // esc
    await tick();
    expect(closed).toBe(true);
  });

  it("re-running after a conflict view dispatches the same action again", async () => {
    let mergeCalls = 0;
    const ctx = buildCtx({ conflictOn: "certificacion" });
    // Wrap merge to count invocations across runs.
    const origMerge = ctx.git.merge.bind(ctx.git);
    ctx.git.merge = async (repo: string, from: string) => {
      mergeCalls++;
      return origMerge(repo, from);
    };
    const { stdin } = render(
      <GitFlowActions ctx={ctx} aliases={["alpha"]} isActive onClose={noop} />,
    );
    await tick();
    stdin.write("a");
    await tick();
    const after1 = mergeCalls;
    stdin.write(ENTER); // re-run from the done view
    await tick();
    expect(mergeCalls).toBeGreaterThan(after1);
  });
});
