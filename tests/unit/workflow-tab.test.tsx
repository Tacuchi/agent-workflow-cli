import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { WORKFLOW_CONTENT } from "../../src/cli/tui/data/workflow-content.js";
import { HOSTS } from "../../src/cli/tui/hosts.js";
import { WorkflowTab } from "../../src/cli/tui/tabs/workflow-tab.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
// [Workline] mounts HostAdminSection (fs.exists over ~/.<host>/skills/w), so
// the harness needs a real sandbox home; NoScanFs keeps everything real but
// stubs list()→[] — same pattern as the skills-tab test.
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new RealFs(),
    env: new FakeEnv(home),
    process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("WorkflowTab ([Workline] = admin + informativo mínimo)", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-workflow-tab-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function renderFlat(): Promise<string> {
    const { lastFrame, unmount } = render(<WorkflowTab ctx={buildCtx(home)} isActive />);
    await new Promise((r) => setTimeout(r, 80));
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    unmount();
    return frame;
  }

  it("header: título Workline + counts derivados de los data modules (.length)", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("Workline");
    expect(frame).toContain(`${WORKFLOW_CONTENT.slashCommands.length} slash commands`);
    expect(frame).toContain(`${WORKFLOW_CONTENT.hooks.length} hooks`);
  });

  it("informativo mínimo: overview 1 línea + strip de flows; sin FamilyCards ni PhaseCards", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("Flows:");
    expect(frame).toContain("SPEC · PLAN · QUICK");
    // Sections retired by the redesign (U2) must not render.
    expect(frame).not.toContain("Command families");
    expect(frame).not.toContain("Workspace init");
  });

  it("administración por host montada: sección Hosts con TODOS los targets del registro", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("HOSTS");
    // Derived from HOSTS (not a hardcoded list): if the registry gains or loses
    // a host, this assert follows — lesson from the clean-legacy v14.5.1 bug.
    for (const host of HOSTS) {
      expect(frame).toContain(host.name);
    }
    expect(frame).toContain("skills/w/");
  });

  // The hooks-armed section mounts here now, so its ~/.claude/settings.json
  // detection is pinned here.
  it("muestra 'hooks armed' cuando ~/.claude/settings.json trae hooks", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [] }] } }),
      "utf8",
    );
    const frame = await renderFlat();
    expect(frame).toContain("hooks armed");
  });

  it("no crashea con settings.json inválido y no muestra hooks armed", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{not valid", "utf8");
    const frame = await renderFlat();
    expect(frame).toContain("Claude Code");
    expect(frame).not.toContain("hooks armed");
  });
});
