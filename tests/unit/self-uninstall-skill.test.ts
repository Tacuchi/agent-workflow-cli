import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { TARGET_ROOTS } from "../../src/application/self/install-targets.js";
import { selfUninstallSkill } from "../../src/application/self/uninstall-skill.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

function buildArgs(values: Record<string, string>, flags: string[]): ParsedArgs {
  return {
    rest: ["uninstall-skill"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string, fs: FileSystemPort, process: ProcessPort): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const paths = new PathsService(ns, home, home);
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs,
    env: new FakeEnv(home),
    process,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

async function seedTarget(
  home: string,
  target: "claude" | "codex" | "agents" | "gemini" | "opencode" | "crush",
  skillName: string,
): Promise<string> {
  // Derive from TARGET_ROOTS so the seed can't drift from the installer
  // (crush's root is XDG, not `.crush`).
  const path = join(home, ...TARGET_ROOTS[target], skillName);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${skillName}\n---\nbody\n`, "utf8");
  return path;
}

async function seedAgentsLock(home: string, skills: Record<string, unknown>): Promise<string> {
  const lockPath = join(home, ".agents", ".skill-lock.json");
  await mkdir(join(home, ".agents"), { recursive: true });
  const content = {
    version: 3,
    skills,
    dismissed: { findSkillsPrompt: true },
    lastSelectedAgents: ["codex", "claude-code"],
  };
  await writeFile(lockPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return lockPath;
}

describe("selfUninstallSkill", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-uninstall-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("--target=all (default) removes canonical from claude+codex (no legacy unless --legacy)", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const claudeCanonical = await seedTarget(home, "claude", "w");
    const codexCanonical = await seedTarget(home, "codex", "w");
    const claudeLegacy = await seedTarget(home, "claude", "agent-workflow-manager");

    const result = await selfUninstallSkill(buildArgs({}, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("removed");
      const paths = result.data.removed.map((r) => r.path);
      expect(paths).toContain(claudeCanonical);
      expect(paths).toContain(codexCanonical);
      expect(paths).not.toContain(claudeLegacy);
    }
    expect(await fs.exists(claudeCanonical)).toBe(false);
    expect(await fs.exists(codexCanonical)).toBe(false);
    expect(await fs.exists(claudeLegacy)).toBe(true); // preserved without --legacy
  });

  it("--target=claude --legacy removes both canonical and legacy in claude only", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const claudeCanonical = await seedTarget(home, "claude", "w");
    const claudeLegacy = await seedTarget(home, "claude", "agent-workflow-manager");
    const codexCanonical = await seedTarget(home, "codex", "w");

    const result = await selfUninstallSkill(buildArgs({ target: "claude" }, ["--legacy"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const kinds = result.data.removed.map((r) => `${r.target}:${r.kind}`);
      expect(kinds).toContain("claude:canonical");
      expect(kinds).toContain("claude:legacy");
      expect(kinds.every((k) => k.startsWith("claude:"))).toBe(true);
    }
    expect(await fs.exists(claudeCanonical)).toBe(false);
    expect(await fs.exists(claudeLegacy)).toBe(false);
    expect(await fs.exists(codexCanonical)).toBe(true); // codex untouched
  });

  it("--legacy also removes the pre-rename `agent-workflow` dir (w migration)", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const canonical = await seedTarget(home, "claude", "w");
    const oldCanonical = await seedTarget(home, "claude", "agent-workflow");

    const result = await selfUninstallSkill(buildArgs({ target: "claude" }, ["--legacy"]), ctx);

    expect(result.ok).toBe(true);
    expect(await fs.exists(canonical)).toBe(false);
    expect(await fs.exists(oldCanonical)).toBe(false); // legacy agent-workflow cleaned
  });

  it("--target=agents --legacy updates .skill-lock.json removing both entries", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const agentsCanonical = await seedTarget(home, "agents", "w");
    const agentsLegacy = await seedTarget(home, "agents", "agent-workflow-manager");
    const lockPath = await seedAgentsLock(home, {
      w: { source: "x", sourceUrl: "y" },
      "agent-workflow-manager": { source: "z", sourceUrl: "w" },
    });

    const result = await selfUninstallSkill(buildArgs({ target: "agents" }, ["--legacy"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.lock_updated).toBe(true);
      expect(result.data.lock_path).toBe(lockPath);
    }
    expect(await fs.exists(agentsCanonical)).toBe(false);
    expect(await fs.exists(agentsLegacy)).toBe(false);

    const updatedLock = JSON.parse(await fs.readText(lockPath));
    expect(updatedLock.skills).toEqual({});
    // Preserved fields:
    expect(updatedLock.dismissed.findSkillsPrompt).toBe(true);
    expect(updatedLock.lastSelectedAgents).toContain("codex");
  });

  it("--dry-run reports what would be removed but doesn't touch fs or lock", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const claudeCanonical = await seedTarget(home, "claude", "w");
    const lockPath = await seedAgentsLock(home, {
      w: { source: "x", sourceUrl: "y" },
    });

    const result = await selfUninstallSkill(buildArgs({}, ["--dry-run"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
      expect(result.data.removed.every((r) => r.status === "dry-run")).toBe(true);
    }
    expect(await fs.exists(claudeCanonical)).toBe(true); // preserved
    const lockAfter = JSON.parse(await fs.readText(lockPath));
    expect(lockAfter.skills.w).toBeDefined(); // preserved
  });

  it("covers gemini/opencode/crush: single target and --target=all (install↔uninstall round-trip)", async () => {
    // Regression: ALL_TARGETS was a literal 5-host list, so the three hosts
    // added in v14.5.0 were rejected and `--target all` left residue behind
    // (same family as the clean-legacy v14.5.1 bug).
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const gemini = await seedTarget(home, "gemini", "w");
    const opencode = await seedTarget(home, "opencode", "w");
    const crush = await seedTarget(home, "crush", "w");

    const single = await selfUninstallSkill(buildArgs({ target: "gemini" }, []), ctx);
    expect(single.ok).toBe(true);
    expect(await fs.exists(gemini)).toBe(false);

    const all = await selfUninstallSkill(buildArgs({}, []), ctx);
    expect(all.ok).toBe(true);
    expect(await fs.exists(opencode)).toBe(false);
    expect(await fs.exists(crush)).toBe(false);
  });

  it("--target=invalid is rejected with INVALID_TARGET", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const result = await selfUninstallSkill(buildArgs({ target: "vscode" }, []), ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("INVALID_TARGET");
    }
  });

  it("noop when nothing exists", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const result = await selfUninstallSkill(buildArgs({}, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("noop");
      expect(result.data.removed).toEqual([]);
    }
  });

  it("malformed .skill-lock.json emits warning and leaves lock untouched", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const lockPath = join(home, ".agents", ".skill-lock.json");
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(lockPath, "{ not json", "utf8");

    const result = await selfUninstallSkill(buildArgs({ target: "agents" }, ["--legacy"]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.lock_updated).toBe(false);
      expect(result.data.lock_warning).toContain("Could not parse");
    }
    // Malformed lock left untouched.
    expect(await fs.readText(lockPath)).toBe("{ not json");
  });
});
