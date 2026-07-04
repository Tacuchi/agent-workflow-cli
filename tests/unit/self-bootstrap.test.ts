import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfBootstrap } from "../../src/application/self/bootstrap.js";
import { resolveBundledSkillPath } from "../../src/application/self/install-skill.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

function buildArgs(flags: string[]): ParsedArgs {
  return {
    rest: ["bootstrap"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(),
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

describe("selfBootstrap", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-bootstrap-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("clean install on empty machine: doctor → skip uninstall → install → next-steps", async () => {
    const fs = new NoScanFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    // Bundled skill must be resolvable from this checkout for install to succeed.
    const bundled = await resolveBundledSkillPath();
    expect(bundled).not.toBeNull();

    const result = await selfBootstrap(buildArgs([]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const stepNames = result.data.steps.map((s) => `${s.name}:${s.status}`);
      expect(stepNames).toContain("doctor:ok");
      expect(stepNames).toContain("uninstall-legacy:skipped");
      expect(stepNames).toContain("install-skill:ok");
      expect(stepNames).toContain("next-steps:ok");
      expect(result.data.next_steps).toHaveLength(2);
      expect(result.data.next_steps.map((n) => n.harness)).toEqual(["claude-code", "codex"]);
    }

    expect(await fs.exists(join(home, ".claude/skills/w"))).toBe(true);
    expect(await fs.exists(join(home, ".codex/skills/w"))).toBe(true);
  });

  it("dirty machine with legacy: doctor → uninstall-legacy ok → install ok", async () => {
    const fs = new NoScanFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    // Seed a legacy skill in .claude
    const legacyPath = join(home, ".claude/skills/agent-workflow-manager");
    await mkdir(legacyPath, { recursive: true });
    await writeFile(
      join(legacyPath, "SKILL.md"),
      "---\nname: agent-workflow-manager\n---\n",
      "utf8",
    );

    const result = await selfBootstrap(buildArgs([]), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const uninstallStep = result.data.steps.find((s) => s.name === "uninstall-legacy");
      expect(uninstallStep?.status).toBe("ok");
      const installStep = result.data.steps.find((s) => s.name === "install-skill");
      expect(installStep?.status).toBe("ok");
    }

    // Legacy gone, canonical present
    expect(await fs.exists(legacyPath)).toBe(false);
    expect(await fs.exists(join(home, ".claude/skills/w"))).toBe(true);
  });

  it("--dry-run preserves filesystem and reports dry-run sub-steps", async () => {
    const fs = new NoScanFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const legacyPath = join(home, ".claude/skills/agent-workflow-manager");
    await mkdir(legacyPath, { recursive: true });
    await writeFile(
      join(legacyPath, "SKILL.md"),
      "---\nname: agent-workflow-manager\n---\n",
      "utf8",
    );

    const result = await selfBootstrap(buildArgs(["--dry-run"]), ctx);

    expect(result.ok).toBe(true);
    // Legacy preserved (no actual fs writes)
    expect(await fs.exists(legacyPath)).toBe(true);
    expect(await fs.exists(join(home, ".claude/skills/w"))).toBe(false);
    if (result.ok && result.data) {
      const installStep = result.data.steps.find((s) => s.name === "install-skill");
      expect(installStep?.status).toBe("ok");
      const data = installStep?.data as { status?: string } | undefined;
      expect(data?.status).toBe("dry-run");
    }
  });
});
