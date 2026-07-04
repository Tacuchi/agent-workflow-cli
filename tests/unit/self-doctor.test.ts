import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfDoctor } from "../../src/application/self/doctor-self.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const runtime: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

// Only `fs` varies across cases. namespace.source is echoed into the report but
// no test asserts it, so hardcoding "env" here is assertion-neutral.
const ctx = (fs: MemFs) =>
  ({
    fs,
    env: new FakeEnv("/home/u", "/cwd"),
    paths,
    namespace: { namespace: ns, source: "env" },
    runtime,
  }) as unknown as CliContext;

describe("selfDoctor", () => {
  it("reports skill installed when ~/.claude/skills/agent-workflow exists (codex absent)", async () => {
    const fs = new MemFs({ lenient: true }).dir("/home/u/.claude/skills/w");
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.skill.installed).toBe(true);
      const claude = result.data.skill.targets.find((t) => t.target === "claude");
      const codex = result.data.skill.targets.find((t) => t.target === "codex");
      expect(claude?.path).toBe("/home/u/.claude/skills/w");
      expect(claude?.installed).toBe(true);
      expect(codex?.path).toBe("/home/u/.codex/skills/w");
      expect(codex?.installed).toBe(false);
      expect(result.data.namespace.value).toBe("workflow");
      expect(result.data.paths.user_root).toBe("/home/u/.workflow");
      // Merged from the former "only the new skill is present" case (identical fixture).
      expect(result.data.skill.targets.every((t) => !t.legacy_leftover)).toBe(true);
    }
  });

  it("reports all 6 file-hosting targets when all have it (claude/codex/warp/gemini/opencode/crush)", async () => {
    const fs = new MemFs({ lenient: true })
      .dir("/home/u/.claude/skills/w")
      .dir("/home/u/.codex/skills/w")
      .dir("/home/u/.warp/skills/w")
      .dir("/home/u/.gemini/skills/w")
      .dir("/home/u/.opencode/skills/w")
      .dir("/home/u/.config/crush/skills/w");
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.skill.installed).toBe(true);
      expect(result.data.skill.targets.every((t) => t.installed)).toBe(true);
      expect(result.data.skill.targets.map((t) => t.target)).toEqual([
        "claude",
        "codex",
        "warp",
        "gemini",
        "opencode",
        "crush",
      ]);
    }
  });

  it("reports skill not installed when neither path is present", async () => {
    const fs = new MemFs({ lenient: true });
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.skill.installed).toBe(false);
      expect(result.data.skill.targets.every((t) => !t.installed)).toBe(true);
      expect(result.data.skill.targets.every((t) => !t.legacy_leftover)).toBe(true);
    }
  });

  it("flags legacy skill leftover in claude target", async () => {
    const fs = new MemFs({ lenient: true })
      .dir("/home/u/.claude/skills/w")
      .dir("/home/u/.claude/skills/agent-workflow-manager");
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.skill.targets.find((t) => t.target === "claude");
      const codex = result.data.skill.targets.find((t) => t.target === "codex");
      expect(claude?.installed).toBe(true);
      expect(claude?.legacy_leftover).toBe(true);
      expect(claude?.legacy_leftover_path).toBe("/home/u/.claude/skills/agent-workflow-manager");
      expect(claude?.legacy_leftover_warning).toContain("agent-workflow-manager");
      expect(codex?.legacy_leftover).toBeUndefined();
    }
  });

  it("flags the pre-rename `agent-workflow` dir as a legacy leftover (w migration)", async () => {
    const fs = new MemFs({ lenient: true })
      .dir("/home/u/.claude/skills/w")
      .dir("/home/u/.claude/skills/agent-workflow");
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.skill.targets.find((t) => t.target === "claude");
      expect(claude?.installed).toBe(true);
      expect(claude?.legacy_leftover).toBe(true);
      expect(claude?.legacy_leftover_path).toBe("/home/u/.claude/skills/agent-workflow");
    }
  });

  it("flags legacy skill leftover in codex target independently", async () => {
    const fs = new MemFs({ lenient: true }).dir("/home/u/.codex/skills/agent-workflow-manager");
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const codex = result.data.skill.targets.find((t) => t.target === "codex");
      expect(codex?.installed).toBe(false);
      expect(codex?.legacy_leftover).toBe(true);
      expect(codex?.legacy_leftover_path).toBe("/home/u/.codex/skills/agent-workflow-manager");
    }
  });

  it("omits agents target when ~/.agents/ does not exist", async () => {
    const fs = new MemFs({ lenient: true }).dir("/home/u/.claude/skills/w");
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const targets = result.data.skill.targets.map((t) => t.target);
      expect(targets).toEqual(["claude", "codex", "warp", "gemini", "opencode", "crush"]);
      expect(targets).not.toContain("agents");
    }
  });

  it("includes agents target when ~/.agents/ exists; parses lock for canonical entry", async () => {
    const fs = new MemFs({ lenient: true })
      .dir("/home/u/.agents")
      .dir("/home/u/.agents/skills/w")
      .file(
        "/home/u/.agents/.skill-lock.json",
        JSON.stringify({
          version: 3,
          skills: { w: { source: "x" } },
          dismissed: {},
          lastSelectedAgents: ["codex"],
        }),
      );
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const agents = result.data.skill.targets.find((t) => t.target === "agents");
      expect(agents).toBeDefined();
      expect(agents?.installed).toBe(true);
      expect(agents?.lock_present).toBe(true);
      expect(agents?.lock_canonical_entry).toBe(true);
      expect(agents?.lock_legacy_entry).toBe(false);
    }
  });

  it("flags legacy_leftover and lock_legacy_entry when ~/.agents has agent-workflow-manager", async () => {
    const fs = new MemFs({ lenient: true })
      .dir("/home/u/.agents")
      .dir("/home/u/.agents/skills/agent-workflow-manager")
      .file(
        "/home/u/.agents/.skill-lock.json",
        JSON.stringify({
          version: 3,
          skills: { "agent-workflow-manager": { source: "github" } },
          dismissed: {},
          lastSelectedAgents: ["codex"],
        }),
      );
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const agents = result.data.skill.targets.find((t) => t.target === "agents");
      expect(agents?.installed).toBe(false);
      expect(agents?.legacy_leftover).toBe(true);
      expect(agents?.lock_canonical_entry).toBe(false);
      expect(agents?.lock_legacy_entry).toBe(true);
    }
  });

  it("emits lock_warning when ~/.agents/.skill-lock.json is malformed", async () => {
    const fs = new MemFs({ lenient: true })
      .dir("/home/u/.agents")
      .file("/home/u/.agents/.skill-lock.json", "{ not json");
    const result = await selfDoctor(ctx(fs));
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const agents = result.data.skill.targets.find((t) => t.target === "agents");
      expect(agents?.lock_present).toBe(true);
      expect(agents?.lock_warning).toContain("Could not parse");
      expect(agents?.lock_canonical_entry).toBeUndefined();
    }
  });
});
