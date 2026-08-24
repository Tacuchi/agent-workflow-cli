import { describe, expect, it } from "vitest";
import {
  runAutoCompactOnClose,
  runCheckpointWrite,
} from "../../src/application/checkpoint-write-service.js";
import { formatCheckpointMd } from "../../src/application/checkpoint/markdown.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { GitPort, LocalChange, NumstatCounts } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The guard that decides whether a CHECKPOINT may be overwritten.
 *
 * It used to be `!existing.includes("_[AI:")` — the very string the template
 * always emits — so the only protected state was "zero markers anywhere" and a
 * half-written checkpoint was treated as a disposable draft. Both hooks shipped
 * in the template (`PreCompact: checkpoint-write` and `SessionEnd:
 * auto-compact-on-close`) run that path unattended, which made destruction the
 * DEFAULT route. These are the cases nothing covered.
 */

const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";
const env = new FakeEnv("/home/u", "/cwd");
const folder = "044-nueva-plan-exec";
const cpPath = `${sessionsDir}/${folder}/CHECKPOINT.md`;

class FakeGit implements GitPort {
  async isGitRepo() {
    return true;
  }
  async currentBranch() {
    return "main";
  }
  async isDirty() {
    return false;
  }
  async changedFiles() {
    return [];
  }
  async repoPrefix(): Promise<string | null> {
    return "";
  }

  // Seeded, not empty: a fake without `localChanges` made the whole collection
  // throw and degrade to "unit not observed", so these suites exercised only
  // the failure branch while looking green.
  async localChanges(): Promise<LocalChange[]> {
    return [
      {
        path: "src/foo.ts",
        from: null,
        code: "M.",
        staged: true,
        unstaged: false,
        untracked: false,
        head_mode: "100644",
        worktree_mode: "100644",
      },
    ];
  }

  async head(): Promise<string | null> {
    return "abc1234def5678";
  }

  async numstatFor(
    _repo: string,
    tracked: string[],
    _untracked: string[],
  ): Promise<Record<string, NumstatCounts>> {
    const counts: Record<string, NumstatCounts> = {};
    for (const path of tracked) counts[path] = { added: "3", removed: "1" };
    return counts;
  }
  async checkout(): Promise<void> {}
  async pull(): Promise<void> {}
  async merge(): Promise<{ ok: boolean; conflicted: string[] }> {
    return { ok: true, conflicted: [] };
  }
  async push(): Promise<void> {}
  async isMerging(): Promise<boolean> {
    return false;
  }
  async conflictedFiles(): Promise<string[]> {
    return [];
  }
}

const git = new FakeGit();

/** One active session, so identity is never the thing under test here. */
function soleActive(): MemFs {
  const fs = new MemFs({ lenient: true });
  fs.file(`${sessionsDir}/${folder}/SESSION.md`, `# SESSION — ${folder}\n`);
  fs.file(`${sessionsDir}/${folder}/TASKS.md`, "- [x] T1\n- [ ] T2\n");
  return fs;
}

const PROSA = "Cerré el guard de sobrescritura y lo verifiqué con un relleno parcial.";

/**
 * The exact reported scenario: the CLI writes the template, the agent fills SOME
 * sections with real prose, and the other markers stay where they were.
 */
async function seedPartiallyFilled(fs: MemFs): Promise<string> {
  const first = await runCheckpointWrite(fs, env, git, paths, {});
  if (!("checkpoint_path" in first) || first.skipped === true) {
    throw new Error(`the first write should produce a template: ${JSON.stringify(first)}`);
  }
  const template = await fs.readText(cpPath);
  const filled = template.replace(
    "_[AI: 1-3 sentences on the last concrete progress. Review recent diffs and the latest entry in DECISIONS.md.]_",
    PROSA,
  );
  // The premise of the whole defect: markers survive a partial fill.
  expect(filled).toContain("_[AI:");
  expect(filled).not.toBe(template);
  await fs.writeText(cpPath, filled);
  return filled;
}

describe("checkpoint-write — an untouched template is still free to regenerate", () => {
  it("rewrites its own pristine output instead of preserving it forever", async () => {
    const fs = soleActive();
    await runCheckpointWrite(fs, env, git, paths, {});
    const second = await runCheckpointWrite(fs, env, git, paths, {});
    if (!("checkpoint_path" in second)) throw new Error(JSON.stringify(second));
    expect(second.skipped).toBeUndefined();
    expect(second.preserved).toBeUndefined();
    expect(second.lines_written).toBeGreaterThan(0);
  });
});

describe("checkpoint-write — a PARTIALLY filled CHECKPOINT survives the default route", () => {
  it("preserves the prose and says so instead of writing", async () => {
    const fs = soleActive();
    const filled = await seedPartiallyFilled(fs);

    const result = await runCheckpointWrite(fs, env, git, paths, {});
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("--force");
    expect(await fs.readText(cpPath)).toBe(filled);
    expect(await fs.readText(cpPath)).toContain(PROSA);
  });

  it("SessionEnd preserves it too — the hook nobody is watching", async () => {
    const fs = soleActive();
    const filled = await seedPartiallyFilled(fs);

    const result = await runAutoCompactOnClose(fs, env, git, paths, {});
    expect(result.checkpoints_written).toHaveLength(1);
    expect(result.checkpoints_written[0]?.preserved).toBe(true);
    expect(result.checkpoints_written[0]?.session).toBe(folder);
    expect(await fs.readText(cpPath)).toBe(filled);
  });

  it("--force is what overwrites it, and only --force", async () => {
    const fs = soleActive();
    const filled = await seedPartiallyFilled(fs);

    const result = await runCheckpointWrite(fs, env, git, paths, { force: true });
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(await fs.readText(cpPath)).not.toBe(filled);
    expect(await fs.readText(cpPath)).not.toContain(PROSA);
  });

  // A fill that happens to remove every marker was already safe; it must stay so.
  it("a fully synthesised CHECKPOINT is preserved as well", async () => {
    const fs = soleActive();
    await runCheckpointWrite(fs, env, git, paths, {});
    const synthesised = (await fs.readText(cpPath)).replaceAll(/_\[AI:[^\]]*\]_/g, PROSA);
    expect(synthesised).not.toContain("_[AI:");
    await fs.writeText(cpPath, synthesised);

    const result = await runCheckpointWrite(fs, env, git, paths, {});
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBe(true);
    expect(await fs.readText(cpPath)).toBe(synthesised);
  });
});

describe("checkpoint-write — a CHECKPOINT from a previous version", () => {
  /** How the template rendered before the seal existed: same shape, no digest. */
  function unsealed(body: string): string {
    return `${body}\n<!-- written by agent-workflow.checkpoint at 2026-05-08 12:00 -->\n`;
  }

  it("is preserved rather than lost, even carrying the old markers", async () => {
    const fs = soleActive();
    const legacy = unsealed(
      [
        `# Checkpoint — ${folder}`,
        "",
        "- Updated: 2026-05-08 12:00",
        "",
        "## Last action",
        "",
        PROSA,
        "",
        "## Next step",
        "",
        "_[AI: 1-2 sentences on what remains. Review the first open item in TASKS.md.]_",
        "",
      ].join("\n"),
    );
    fs.file(cpPath, legacy);

    const result = await runCheckpointWrite(fs, env, git, paths, {});
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBe(true);
    expect(await fs.readText(cpPath)).toBe(legacy);
  });

  it("does not break: --force still regenerates it into the sealed shape", async () => {
    const fs = soleActive();
    fs.file(cpPath, unsealed(`# Checkpoint — ${folder}\n\n## Last action\n\n${PROSA}\n`));

    const result = await runCheckpointWrite(fs, env, git, paths, { force: true });
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBeUndefined();
    expect(await fs.readText(cpPath)).toContain("· template sha256=");
  });
});

describe("the sentinel is no longer a string the generator emits", () => {
  // The regression in one line: whatever the template says, it can never hand
  // itself the permission to be destroyed.
  it("the template's own bytes are the only thing that reads as pristine", async () => {
    const fs = soleActive();
    await runCheckpointWrite(fs, env, git, paths, {});
    const template = await fs.readText(cpPath);
    expect(template).toContain("_[AI:");

    const forged = formatCheckpointMd({
      folder,
      tasks: { open: 0, closed: 0, total: 0 },
      progress_pct: null,
      last_decision: null,
      artefacts: {},
      files_touched: {
        observed: [{ alias: "workspace", boundary: "/ws", reference: "abc1234" }],
        unobserved: [],
        linked: [],
        contextual: [],
        omitted: 0,
      },
      origen: null,
      timestamp: "2026-05-08 12:00",
    }).replace("## Refs", `## Notas mías\n\n${PROSA}\n\n## Refs`);
    await fs.writeText(cpPath, forged);

    const result = await runCheckpointWrite(fs, env, git, paths, {});
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.preserved).toBe(true);
  });
});
