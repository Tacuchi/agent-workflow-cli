import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  COMMAND_SKILL_MARKER,
  SKILL_DIR_NAME,
  TARGET_ROOTS,
} from "../../src/application/self/install-skill.js";
import type { InstallTarget } from "../../src/application/self/install-skill.js";
import { selfUninstall } from "../../src/application/self/uninstall.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

function buildArgs(values: Record<string, string>, flags: string[]): ParsedArgs {
  return {
    rest: ["uninstall"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string, fs: FileSystemPort): CliContext {
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
    process: new FakeProcess(),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

const ALL_TARGETS: readonly InstallTarget[] = [
  "claude",
  "codex",
  "agents",
  "warp",
  "oz",
  "gemini",
  "opencode",
  "crush",
];

function skillDir(home: string, target: InstallTarget): string {
  return join(home, ...TARGET_ROOTS[target], SKILL_DIR_NAME);
}

async function seedDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: w\n---\nbody\n", "utf8");
}

async function seedSettings(home: string, hooks: Record<string, unknown>): Promise<string> {
  const settingsPath = join(home, ".claude", "settings.json");
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify({ model: "sonnet", hooks }, null, 2)}\n`, "utf8");
  return settingsPath;
}

const OUR_HOOK = [{ hooks: [{ type: "command", command: "agent-workflow x" }] }];
const USER_HOOK = [{ hooks: [{ type: "command", command: "my-own-thing" }] }];

describe("selfUninstall (full uninstall — 8 targets, hooks, flatten sweep)", () => {
  let workdir: string;
  let home: string;
  let fs: RealFs;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-full-uninstall-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
    fs = new RealFs();
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("--target=all removes the canonical skill from every one of the 8 hosts", async () => {
    const ctx = buildCtx(home, fs);
    // agents and oz share .agents/skills, so seed distinct dirs by path.
    const distinctPaths = new Set(ALL_TARGETS.map((t) => skillDir(home, t)));
    for (const p of distinctPaths) await seedDir(p);

    const result = await selfUninstall(buildArgs({}, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("removed");
    }
    for (const p of distinctPaths) {
      expect(await fs.exists(p)).toBe(false);
    }
  });

  it("--with-hooks strips only our events from settings.json, preserving user hooks + a backup", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "claude"));
    const settingsPath = await seedSettings(home, {
      SessionStart: OUR_HOOK,
      PreToolUse: OUR_HOOK,
      Notification: USER_HOOK,
    });

    const result = await selfUninstall(buildArgs({ target: "claude" }, ["--with-hooks"]), ctx);

    expect(result.ok).toBe(true);
    const after = JSON.parse(await fs.readText(settingsPath));
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.PreToolUse).toBeUndefined();
    expect(after.hooks.Notification).toEqual(USER_HOOK); // user's own survives
    expect(after.model).toBe("sonnet"); // unrelated keys survive

    if (result.ok && result.data) {
      const hookStep = result.data.steps.find((s) => s.kind === "hooks");
      expect(hookStep?.status).toBe("removed");
      expect(hookStep?.reason).toContain("SessionStart");
      expect(hookStep?.reason).toContain("PreToolUse");
    }
    const backups = (await readdir(join(home, ".claude"))).filter((f) =>
      f.startsWith("settings.json.bak."),
    );
    expect(backups.length).toBe(1);
  });

  it("does NOT touch settings.json without --with-hooks", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "claude"));
    const settingsPath = await seedSettings(home, { SessionStart: OUR_HOOK });

    const result = await selfUninstall(buildArgs({ target: "claude" }, []), ctx);

    expect(result.ok).toBe(true);
    const after = JSON.parse(await fs.readText(settingsPath));
    expect(after.hooks.SessionStart).toEqual(OUR_HOOK);
    if (result.ok && result.data) {
      expect(result.data.steps.some((s) => s.kind === "hooks")).toBe(false);
    }
  });

  it("--dry-run reports steps but touches neither the skill dir nor settings.json", async () => {
    const ctx = buildCtx(home, fs);
    const canonical = skillDir(home, "claude");
    await seedDir(canonical);
    const settingsPath = await seedSettings(home, { SessionStart: OUR_HOOK });

    const result = await selfUninstall(
      buildArgs({ target: "claude" }, ["--dry-run", "--with-hooks"]),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
      expect(result.data.steps.length).toBeGreaterThan(0);
      expect(result.data.steps.every((s) => s.status === "dry-run")).toBe(true);
    }
    expect(await fs.exists(canonical)).toBe(true); // preserved
    const after = JSON.parse(await fs.readText(settingsPath));
    expect(after.hooks.SessionStart).toEqual(OUR_HOOK); // preserved
  });

  it("sweeps flattened sub-skills (agent-workflow-*) on warp with ownership proof, leaving foreign dirs", async () => {
    const ctx = buildCtx(home, fs);
    const warpRoot = join(home, ...TARGET_ROOTS.warp);
    const canonical = join(warpRoot, SKILL_DIR_NAME);
    // ≤v18 flatten fingerprint: dir `<prefix><name>` with frontmatter `name: <name>`.
    const flatA = join(warpRoot, "agent-workflow-writing");
    const flatB = join(warpRoot, "agent-workflow-git-conventions");
    // Third-party skill whose name merely starts with the prefix: name == dir.
    const foreign = join(warpRoot, "agent-workflow-helper");
    const unrelated = join(warpRoot, "someone-elses-skill");
    await seedDir(canonical);
    await mkdir(flatA, { recursive: true });
    await writeFile(join(flatA, "SKILL.md"), "---\nname: writing\ndescription: x\n---\n", "utf8");
    await mkdir(flatB, { recursive: true });
    await writeFile(
      join(flatB, "SKILL.md"),
      "---\nname: git-conventions\ndescription: x\n---\n",
      "utf8",
    );
    await mkdir(foreign, { recursive: true });
    await writeFile(
      join(foreign, "SKILL.md"),
      "---\nname: agent-workflow-helper\ndescription: x\n---\n",
      "utf8",
    );
    await mkdir(unrelated, { recursive: true });

    const result = await selfUninstall(buildArgs({ target: "warp" }, []), ctx);

    expect(result.ok).toBe(true);
    expect(await fs.exists(canonical)).toBe(false);
    expect(await fs.exists(flatA)).toBe(false);
    expect(await fs.exists(flatB)).toBe(false);
    expect(await fs.exists(foreign)).toBe(true); // name == dir → not ours, preserved
    expect(await fs.exists(unrelated)).toBe(true); // not ours — preserved
  });

  it("--skill-only keeps the synthesized w-* wrappers (they are the command surface on codex)", async () => {
    const ctx = buildCtx(home, fs);
    const codexRoot = join(home, ...TARGET_ROOTS.codex);
    const canonical = join(codexRoot, SKILL_DIR_NAME);
    const synth = join(codexRoot, "w-quick");
    await seedDir(canonical);
    await mkdir(synth, { recursive: true });
    await writeFile(
      join(synth, "SKILL.md"),
      `---\nname: w-quick\ndescription: x\n---\n\n> ${COMMAND_SKILL_MARKER}. …\n`,
      "utf8",
    );

    const result = await selfUninstall(buildArgs({ target: "codex" }, ["--skill-only"]), ctx);

    expect(result.ok).toBe(true);
    expect(await fs.exists(canonical)).toBe(false); // the bundle goes
    expect(await fs.exists(synth)).toBe(true); // wrappers gated like commands
  });

  it("removes the native command wrappers dir per host (gemini/opencode/crush)", async () => {
    const ctx = buildCtx(home, fs);
    const dirs = [
      { target: "gemini", rel: ".gemini/commands/w" },
      { target: "opencode", rel: ".opencode/command/w" },
      { target: "crush", rel: ".crush/commands/w" },
    ] as const;
    for (const { target, rel } of dirs) {
      await seedDir(skillDir(home, target));
      const cmdDir = join(home, rel);
      await mkdir(cmdDir, { recursive: true });
      const result = await selfUninstall(buildArgs({ target }, []), ctx);
      expect(result.ok).toBe(true);
      expect(await fs.exists(cmdDir), rel).toBe(false);
    }
  });

  it("sweeps w-* wrappers with ownership proof on EVERY command-skills host (install/uninstall symmetry)", async () => {
    const { COMMAND_SKILLS_HOSTS } = await import("../../src/application/self/install-targets.js");
    // The set is the single source both sides consume; pin its membership.
    expect([...COMMAND_SKILLS_HOSTS].sort()).toEqual(["codex", "gemini", "oz", "warp"]);
    const ctx = buildCtx(home, fs);
    for (const target of COMMAND_SKILLS_HOSTS) {
      const root = join(home, ...TARGET_ROOTS[target]);
      const synth = join(root, "w-quick");
      const foreign = join(root, "w-mia");
      await seedDir(skillDir(home, target));
      await mkdir(synth, { recursive: true });
      await writeFile(
        join(synth, "SKILL.md"),
        `---\nname: w-quick\ndescription: x\n---\n\n> ${COMMAND_SKILL_MARKER}. …\n`,
        "utf8",
      );
      await mkdir(foreign, { recursive: true });
      await writeFile(join(foreign, "SKILL.md"), "---\nname: w-mia\ndescription: x\n---\n", "utf8");

      const result = await selfUninstall(buildArgs({ target }, []), ctx);

      expect(result.ok, target).toBe(true);
      expect(await fs.exists(synth), `${target}: owned wrapper swept`).toBe(false);
      expect(await fs.exists(foreign), `${target}: foreign w-* preserved`).toBe(true);
      await rm(foreign, { recursive: true, force: true });
    }
  });

  it("crush: removes the bundle from the XDG root AND the dead legacy ~/.crush/skills root", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "crush"));
    const legacyBundle = join(home, ".crush/skills/w");
    await mkdir(join(legacyBundle, "harness"), { recursive: true });
    await writeFile(
      join(legacyBundle, "SKILL.md"),
      "---\nname: w\ndescription: bundle\n---\n",
      "utf8",
    );
    await writeFile(join(legacyBundle, "harness/HARNESS.md"), "# harness\n", "utf8");

    const result = await selfUninstall(buildArgs({ target: "crush" }, []), ctx);

    expect(result.ok).toBe(true);
    expect(await fs.exists(skillDir(home, "crush"))).toBe(false);
    expect(await fs.exists(legacyBundle)).toBe(false);
    // The emptied dead root is pruned too.
    expect(await fs.exists(join(home, ".crush/skills"))).toBe(false);
  });

  it("crush: a foreign `w` dir in the legacy root (no bundle fingerprint) survives uninstall", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "crush"));
    const foreignW = join(home, ".crush/skills/w");
    await mkdir(foreignW, { recursive: true });
    await writeFile(
      join(foreignW, "SKILL.md"),
      "---\nname: w\ndescription: user's own\n---\n",
      "utf8",
    );

    const result = await selfUninstall(buildArgs({ target: "crush" }, []), ctx);

    expect(result.ok).toBe(true);
    expect(await fs.exists(foreignW)).toBe(true);
  });

  it("crush: --dry-run reports the legacy-root bundle but removes nothing", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "crush"));
    const legacyBundle = join(home, ".crush/skills/w");
    await mkdir(join(legacyBundle, "harness"), { recursive: true });
    await writeFile(
      join(legacyBundle, "SKILL.md"),
      "---\nname: w\ndescription: bundle\n---\n",
      "utf8",
    );
    await writeFile(join(legacyBundle, "harness/HARNESS.md"), "# harness\n", "utf8");

    const result = await selfUninstall(buildArgs({ target: "crush" }, ["--dry-run"]), ctx);

    expect(result.ok).toBe(true);
    expect(await fs.exists(skillDir(home, "crush"))).toBe(true);
    expect(await fs.exists(legacyBundle)).toBe(true);
    if (result.ok && result.data) {
      const legacyStep = result.data.steps.find((s) => s.path === legacyBundle);
      expect(legacyStep?.status).toBe("dry-run");
    }
  });

  it("crush: --legacy sweeps pre-rename names from the dead ~/.crush/skills root too", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "crush"));
    const preRename = join(home, ".crush/skills/agent-workflow-manager");
    await seedDir(preRename);

    const withoutLegacy = await selfUninstall(buildArgs({ target: "crush" }, []), ctx);
    expect(withoutLegacy.ok).toBe(true);
    expect(await fs.exists(preRename)).toBe(true);

    await seedDir(skillDir(home, "crush"));
    const withLegacy = await selfUninstall(buildArgs({ target: "crush" }, ["--legacy"]), ctx);
    expect(withLegacy.ok).toBe(true);
    expect(await fs.exists(preRename)).toBe(false);
  });

  it("codex: prunes the emptied ~/.codex/commands parent on uninstall", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "codex"));
    await mkdir(join(home, ".codex/commands/w"), { recursive: true });
    await writeFile(join(home, ".codex/commands/w/quick.md"), "# stale\n", "utf8");

    const result = await selfUninstall(buildArgs({ target: "codex" }, []), ctx);

    expect(result.ok).toBe(true);
    expect(await fs.exists(join(home, ".codex/commands"))).toBe(false);
  });

  it("removes user-commands by default but keeps them with --skill-only", async () => {
    const ctx = buildCtx(home, fs);
    await seedDir(skillDir(home, "claude"));
    const commandsDir = join(home, ".claude", "commands", "w");
    await mkdir(commandsDir, { recursive: true });

    const kept = await selfUninstall(buildArgs({ target: "claude" }, ["--skill-only"]), ctx);
    expect(kept.ok).toBe(true);
    expect(await fs.exists(commandsDir)).toBe(true);
    if (kept.ok && kept.data) {
      expect(kept.data.steps.some((s) => s.kind === "user-commands")).toBe(false);
    }

    await seedDir(skillDir(home, "claude"));
    const removed = await selfUninstall(buildArgs({ target: "claude" }, []), ctx);
    expect(removed.ok).toBe(true);
    expect(await fs.exists(commandsDir)).toBe(false);
    if (removed.ok && removed.data) {
      expect(removed.data.steps.some((s) => s.kind === "user-commands")).toBe(true);
    }
  });

  it("--legacy also removes legacy skill dirs; without it they are preserved", async () => {
    const ctx = buildCtx(home, fs);
    const canonical = skillDir(home, "claude");
    const legacy = join(home, ...TARGET_ROOTS.claude, "agent-workflow-manager");
    await seedDir(canonical);
    await seedDir(legacy);

    const withoutLegacy = await selfUninstall(buildArgs({ target: "claude" }, []), ctx);
    expect(withoutLegacy.ok).toBe(true);
    expect(await fs.exists(legacy)).toBe(true);

    await seedDir(canonical);
    const withLegacy = await selfUninstall(buildArgs({ target: "claude" }, ["--legacy"]), ctx);
    expect(withLegacy.ok).toBe(true);
    expect(await fs.exists(legacy)).toBe(false);
    if (withLegacy.ok && withLegacy.data) {
      expect(withLegacy.data.steps.some((s) => s.kind === "legacy-skill")).toBe(true);
    }
  });

  it("rejects an unknown --target with INVALID_TARGET", async () => {
    const ctx = buildCtx(home, fs);
    const result = await selfUninstall(buildArgs({ target: "vscode" }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("INVALID_TARGET");
    }
  });

  it("is a noop when nothing is installed", async () => {
    const ctx = buildCtx(home, fs);
    const result = await selfUninstall(buildArgs({}, []), ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("noop");
      expect(result.data.steps).toEqual([]);
    }
  });
});
