import { describe, expect, it, vi } from "vitest";
import { runArtifactsCommand } from "../../src/application/artifacts-service.js";
import { runCheckpointRead, runResumeSummary } from "../../src/application/checkpoint-service.js";
import {
  runAutoCompactOnClose,
  runCheckpointWrite,
} from "../../src/application/checkpoint-write-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { lookupBinding } from "../../src/application/session-binding-service.js";
import type { CliContext } from "../../src/cli/types.js";
import type { DiffNumstatEntry, GitPort } from "../../src/ports/git.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";
const env = new FakeEnv("/home/u", "/cwd");

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
  async diffNumstat(): Promise<DiffNumstatEntry[]> {
    return [];
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

/** Two active sessions — the concurrency case the whole spec exists for. */
function seedTwoActive(): MemFs {
  const fs = new MemFs({ lenient: true });
  for (const folder of ["020-vieja-quick", "044-nueva-plan-exec"]) {
    fs.file(`${sessionsDir}/${folder}/SESSION.md`, `# SESSION — ${folder}\n`);
    fs.file(`${sessionsDir}/${folder}/TASKS.md`, "- [x] T1\n- [ ] T2\n");
  }
  return fs;
}

function checkpointsWritten(fs: MemFs): string[] {
  return [...fs.writes.keys()].filter((p) => p.endsWith("CHECKPOINT.md"));
}

describe("PreCompact → PostCompact keep one folder (same session_id)", () => {
  // The reported regression: sessions 020 and 044 both active, the conversation
  // works in 044; `checkpoint-write --code 044` was skipped and `resume-summary`
  // handed back 020.
  it("an explicit current-model code writes only its own session", async () => {
    const fs = seedTwoActive();
    const result = await runCheckpointWrite(fs, env, git, paths, { code: "044" });
    if (!("checkpoint_path" in result)) throw new Error(JSON.stringify(result));
    expect(result.session).toBe("044-nueva-plan-exec");
    expect(checkpointsWritten(fs)).toEqual([`${sessionsDir}/044-nueva-plan-exec/CHECKPOINT.md`]);
  });

  it("the conversation's own line survives compaction and a new process", async () => {
    const fs = seedTwoActive();
    const contextId = "conv-precompact";

    // PreCompact: the conversation names its line once, which also associates it.
    const pre = await runCheckpointWrite(fs, env, git, paths, { code: "044", contextId });
    if (!("checkpoint_path" in pre)) throw new Error(JSON.stringify(pre));
    expect(pre.session).toBe("044-nueva-plan-exec");

    // PostCompact, a NEW process: no --code, same conversation id.
    const post = await runResumeSummary(
      fs,
      new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd"),
      {
        contextId,
      },
    );
    expect(post.primary_session).toBe("044-nueva-plan-exec");
    expect(post.primary_session_code).toBe("044");
    expect(post.continuity).toBe("ok");
    // The other active session is listed, never mixed in as the target.
    expect(post.active_sessions).toEqual(["020-vieja-quick", "044-nueva-plan-exec"]);
  });

  it("a second conversation keeps its own line through the same surfaces", async () => {
    const fs = seedTwoActive();
    await runCheckpointWrite(fs, env, git, paths, { code: "044", contextId: "conv-a" });
    await runCheckpointWrite(fs, env, git, paths, { code: "020", contextId: "conv-b" });

    const a = await runResumeSummary(fs, paths, { contextId: "conv-a" });
    const b = await runResumeSummary(fs, paths, { contextId: "conv-b" });
    expect(a.primary_session).toBe("044-nueva-plan-exec");
    expect(b.primary_session).toBe("020-vieja-quick");
  });
});

describe("ambiguity resolves by declared capability", () => {
  it("pausable host: blocks with the candidates and mutates nothing", async () => {
    const fs = seedTwoActive();
    const result = await runCheckpointWrite(fs, env, git, paths, { canPauseCompaction: true });
    if (!("blocked" in result)) throw new Error(`expected a block, got: ${JSON.stringify(result)}`);
    expect(result.selection_required).toBe(true);
    expect(result.sessionError.code).toBe("SESSION_AMBIGUOUS");
    expect(result.sessionError.candidates.map((c) => c.folder)).toEqual([
      "020-vieja-quick",
      "044-nueva-plan-exec",
    ]);
    expect(checkpointsWritten(fs)).toEqual([]);
  });

  it("non-pausable host: degrades with primary_session null and mutates nothing", async () => {
    const fs = seedTwoActive();
    const result = await runCheckpointWrite(fs, env, git, paths, {});
    if (!("skipped" in result) || !result.skipped) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    expect(result.primary_session).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(fs.writes.size).toBe(0);
  });

  // Blocking is the answer to AMBIGUITY, not to every failure. A pausable host
  // in a workspace with no active session (the normal state between runs) must
  // still complete its compaction: there is nothing to select, and holding it
  // would fail every compaction with an empty candidate list.
  async function expectDegradedNotBlocked(fs: MemFs): Promise<void> {
    const result = await runCheckpointWrite(fs, env, git, paths, { canPauseCompaction: true });
    expect("blocked" in result).toBe(false);
    if (!("skipped" in result) || !result.skipped) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    expect(fs.writes.size).toBe(0);
  }

  it("pausable host does NOT block a workspace with no sessions at all", async () => {
    await expectDegradedNotBlocked(new MemFs({ lenient: true }));
  });

  it("pausable host does NOT block when every session is closed", async () => {
    const fs = seedTwoActive();
    for (const folder of ["020-vieja-quick", "044-nueva-plan-exec"]) {
      fs.file(`${sessionsDir}/${folder}/.closed`, "");
    }
    await expectDegradedNotBlocked(fs);
  });

  it("a broken bindings registry degrades rather than holding the compaction", async () => {
    const fs = seedTwoActive();
    fs.file(`${sessionsDir}/.bindings.json`, '{"version":1,"bindings":{');
    const result = await runCheckpointWrite(fs, env, git, paths, {
      contextId: "conv-a",
      canPauseCompaction: true,
    });
    expect("blocked" in result).toBe(false);
    if (!("skipped" in result) || !result.skipped) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    // Fail-closed: the corrupt registry is never rewritten.
    expect(await fs.readText(`${sessionsDir}/.bindings.json`)).toBe('{"version":1,"bindings":{');
  });

  it("PostCompact never presents an arbitrary session as primary", async () => {
    const fs = seedTwoActive();
    const summary = await runResumeSummary(fs, paths, {});
    expect(summary.primary_session).toBeNull();
    expect(summary.primary_session_code).toBeNull();
    expect(summary.continuity).toBe("degraded");
    expect(summary.needs_ai_action).toBe(true);
    expect(summary.candidates?.map((c) => c.folder)).toEqual([
      "020-vieja-quick",
      "044-nueva-plan-exec",
    ]);
    expect(summary.action).toContain("--code");
    expect(fs.writes.size).toBe(0);
  });
});

describe("SessionEnd acts on one session, never on every active one", () => {
  it("ambiguous close writes no checkpoint at all", async () => {
    const fs = seedTwoActive();
    const result = await runAutoCompactOnClose(fs, env, git, paths, {});
    expect(result.checkpoints_written).toEqual([]);
    expect(result.continuity).toBe("degraded");
    expect(result.primary_session).toBeNull();
    expect(result.candidates).toHaveLength(2);
    // The heart of it: byte-for-byte, no session was touched.
    expect(fs.writes.size).toBe(0);
  });

  it("with an identity it checkpoints exactly that session", async () => {
    const fs = seedTwoActive();
    const result = await runAutoCompactOnClose(fs, env, git, paths, { code: "020" });
    expect(result.checkpoints_written).toHaveLength(1);
    expect(result.checkpoints_written[0]?.session).toBe("020-vieja-quick");
    expect(checkpointsWritten(fs)).toEqual([`${sessionsDir}/020-vieja-quick/CHECKPOINT.md`]);
  });

  it("the sole active session is a sufficient identity", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file(`${sessionsDir}/001-sola-quick/SESSION.md`, "# SESSION — 001-sola-quick\n");
    const result = await runAutoCompactOnClose(fs, env, git, paths, {});
    expect(result.checkpoints_written).toHaveLength(1);
    expect(result.checkpoints_written[0]?.session).toBe("001-sola-quick");
  });
});

describe("lifecycle surfaces never write to a closed session", () => {
  it("an explicit closed target is refused, not checkpointed", async () => {
    const fs = seedTwoActive();
    fs.file(`${sessionsDir}/020-vieja-quick/.closed`, "");
    const result = await runCheckpointWrite(fs, env, git, paths, {
      code: "020",
      canPauseCompaction: true,
    });
    // Not a block: a closed target is not something a SELECTION fixes, so the
    // compaction completes. What matters is that the closed line is untouched
    // and the reason says how to reach it.
    if (!("skipped" in result) || !result.skipped) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    expect(result.reason).toContain("cerrada");
    expect(result.action).toContain("--reopen");
    expect(fs.writes.size).toBe(0);
  });
});

describe("reading never moves the conversation's line", () => {
  /** Where `conv-a` points right now, `null` when it points nowhere. */
  async function bound(fs: MemFs): Promise<string | null> {
    const lookup = await lookupBinding(fs, paths, "conv-a");
    return lookup.status === "bound" ? lookup.folder : null;
  }

  // The reported hijack, end to end: the conversation works on 020, someone
  // reads ANOTHER session's checkpoint, and the SessionEnd hook — which carries
  // no `--code` — used to write to the session that was merely looked at,
  // leaving the real line with no checkpoint at all.
  it("a checkpoint-read of another session does not redirect the close", async () => {
    const fs = seedTwoActive();
    const contextId = "conv-a";
    await runCheckpointWrite(fs, env, git, paths, { code: "020", contextId });
    expect(await bound(fs)).toBe("020-vieja-quick");

    const read = await runCheckpointRead(fs, paths, { code: "044", contextId });
    if ("sessionError" in read) throw new Error(JSON.stringify(read));
    expect(read.session).toBe("044-nueva-plan-exec");
    expect(await bound(fs)).toBe("020-vieja-quick");

    const close = await runAutoCompactOnClose(fs, env, git, paths, { contextId });
    expect(close.checkpoints_written[0]?.session).toBe("020-vieja-quick");
  });

  it("reading a session this conversation never claimed leaves it unclaimed", async () => {
    const fs = seedTwoActive();
    const read = await runCheckpointRead(fs, paths, {
      code: "044",
      contextId: "conv-a",
    });
    if ("sessionError" in read) throw new Error(JSON.stringify(read));
    // Nothing at all was written: not the registry, not the session.
    expect(fs.writes.size).toBe(0);
    expect(await bound(fs)).toBeNull();
  });

  it("the PostCompact summary reports a line without claiming it", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file(`${sessionsDir}/001-sola-quick/SESSION.md`, "# SESSION — 001-sola-quick\n");

    const summary = await runResumeSummary(fs, paths, { contextId: "conv-a" });
    expect(summary.primary_session).toBe("001-sola-quick");
    expect(fs.writes.size).toBe(0);
    expect(await bound(fs)).toBeNull();
  });

  // The same hijack through the OTHER read surface. `session-artifacts` counts a
  // session's artifacts and writes nothing, but it shared the request helper with
  // the write paths, so inspecting another line re-pointed the conversation at it
  // — and the SessionEnd hook that followed, carrying no `--code`, wrote there.
  it("a session-artifacts of another session does not redirect the close either", async () => {
    const fs = seedTwoActive();
    const contextId = "conv-a";
    await runCheckpointWrite(fs, env, git, paths, { code: "020", contextId });
    expect(await bound(fs)).toBe("020-vieja-quick");

    const artifacts = await runArtifactsCommand(fs, env, paths, { code: "044", contextId });
    if ("sessionError" in artifacts) throw new Error(JSON.stringify(artifacts));
    expect(await bound(fs)).toBe("020-vieja-quick");

    const close = await runAutoCompactOnClose(fs, env, git, paths, { contextId });
    expect(close.checkpoints_written[0]?.session).toBe("020-vieja-quick");
  });

  // Writing is what claims a line, and it still must: quick 115's loop depends
  // on the `--code` run binding so the hook run that follows resolves alone.
  it("checkpoint-write still binds, because writing IS claiming", async () => {
    const fs = seedTwoActive();
    await runCheckpointWrite(fs, env, git, paths, { code: "044", contextId: "conv-a" });
    expect(await bound(fs)).toBe("044-nueva-plan-exec");
  });
});

describe("checkpoint-write CLI — exit codes carry the capability decision", () => {
  function ctxFor(fs: MemFs, envOverride: FakeEnv = env): CliContext {
    return { fs, env: envOverride, git, paths } as unknown as CliContext;
  }

  function argv(flags: string[], values: [string, string][] = []) {
    return {
      rest: [],
      plugin: {},
      flags: new Set(flags),
      values: new Map(values),
      valuesMulti: new Map(),
    };
  }

  it("--can-pause + ambiguity → exit 2 with the candidates to choose from", async () => {
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
    const result = await checkpointWriteCommand.execute(
      argv(["--can-pause"]),
      ctxFor(seedTwoActive()),
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.error?.code).toBe("SESSION_AMBIGUOUS");
  });

  // Regression: this used to exit 2 as well, so every compaction failed in any
  // workspace with no active session — the normal state between runs.
  it("--can-pause with nothing to select → exit 0, degraded", async () => {
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
    const result = await checkpointWriteCommand.execute(
      argv(["--can-pause"]),
      ctxFor(new MemFs({ lenient: true })),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("without --can-pause ambiguity degrades at exit 0", async () => {
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
    const result = await checkpointWriteCommand.execute(argv([]), ctxFor(seedTwoActive()));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("an unambiguous --code writes and exits 0 even on a pausable host", async () => {
    const fs = seedTwoActive();
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
    const result = await checkpointWriteCommand.execute(
      argv(["--can-pause"], [["code", "044"]]),
      ctxFor(fs),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(checkpointsWritten(fs)).toEqual([`${sessionsDir}/044-nueva-plan-exec/CHECKPOINT.md`]);
  });

  // The reported loop (quick 115): /compact held, the agent runs the suggested
  // `--code` fix, /compact holds again — nothing ever bound the conversation
  // because the agent's shell carries no AW_CONTEXT_ID. With the host-exported
  // id as fallback, the --code run binds, and the NEXT hook run resolves.
  it("the host-exported id makes a --code run bind, so the retry resolves", async () => {
    const fs = seedTwoActive();
    const hostEnv = new FakeEnv("/home/u", "/cwd", { CLAUDE_CODE_SESSION_ID: "conv-claude" });
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");

    const fix = await checkpointWriteCommand.execute(
      argv(["--can-pause"], [["code", "044"]]),
      ctxFor(fs, hostEnv),
    );
    expect(fix.exitCode).toBe(0);

    const retry = await checkpointWriteCommand.execute(argv(["--can-pause"]), ctxFor(fs, hostEnv));
    expect(retry.ok).toBe(true);
    expect(retry.exitCode).toBe(0);
  });

  // Claude Code shows stderr for a held compaction; the stdout envelope it
  // never shows. Without this line the person sees only the generic block.
  it("a held compaction tells the person on stderr what to run", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
      const result = await checkpointWriteCommand.execute(
        argv(["--can-pause"]),
        ctxFor(seedTwoActive()),
      );
      expect(result.exitCode).toBe(2);
      const notice = spy.mock.calls.map((call) => String(call[0])).join("");
      expect(notice).toContain("aw checkpoint-write --code");
      expect(notice).toContain("020-vieja-quick");
      expect(notice).toContain("044-nueva-plan-exec");
    } finally {
      spy.mockRestore();
    }
  });
});
