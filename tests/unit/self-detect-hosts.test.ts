import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfDetectHosts } from "../../src/application/self/detect-hosts.js";
import { SKILL_DIR_NAME } from "../../src/application/self/install-skill.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new NoScanFs(),
    env: new FakeEnv(home),
    process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("selfDetectHosts", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "self-detect-hosts-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns 8 hosts, all undetected when no config dirs exist", async () => {
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.hosts).toHaveLength(8);
      // Order pins INSTALL_TARGETS (TARGET_ROOTS key order) — the single source.
      expect(result.data.hosts.map((h) => h.target)).toEqual([
        "claude",
        "codex",
        "agents",
        "warp",
        "oz",
        "gemini",
        "opencode",
        "crush",
      ]);
      expect(result.data.detected_count).toBe(0);
      expect(result.data.installed_count).toBe(0);
      expect(result.data.summary).toContain("No host config");
    }
  });

  it("detects OpenCode via its XDG dir ~/.config/opencode (not ~/.opencode)", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const oc = result.data.hosts.find((h) => h.target === "opencode");
      expect(oc?.config_dir).toBe(join(home, ".config", "opencode"));
      expect(oc?.config_dir_present).toBe(true);
      expect(result.data.detected_count).toBe(1);
    }
  });

  it("detects Gemini via ~/.gemini", async () => {
    await mkdir(join(home, ".gemini"), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const gemini = result.data.hosts.find((h) => h.target === "gemini");
      expect(gemini?.config_dir_present).toBe(true);
    }
  });

  it("detects ~/.claude/ when present", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.hosts.find((h) => h.target === "claude");
      expect(claude?.config_dir_present).toBe(true);
      expect(claude?.skill_installed).toBe(false);
      expect(result.data.detected_count).toBe(1);
    }
  });

  it("detects skill installed under ~/.claude/skills/agent-workflow/", async () => {
    await mkdir(join(home, ".claude", "skills", SKILL_DIR_NAME), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.hosts.find((h) => h.target === "claude");
      expect(claude?.skill_installed).toBe(true);
      expect(result.data.installed_count).toBe(1);
    }
  });

  it("reports multiple hosts independently", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".warp", "skills", SKILL_DIR_NAME), { recursive: true });
    const ctx = buildCtx(home);
    const result = await selfDetectHosts(ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.detected_count).toBe(3);
      expect(result.data.installed_count).toBe(1);
      expect(result.data.summary).toContain("Detected 3");
      expect(result.data.summary).toContain("installed in 1");
    }
  });
});
