import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runArtifactsCommand } from "../../src/application/artifacts-service.js";
import { runCheckpointRead, runResumeSummary } from "../../src/application/checkpoint-service.js";
import {
  runAutoCompactOnClose,
  runCheckpointWrite,
  writeRefugeCheckpoint,
} from "../../src/application/checkpoint-write-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { hashContextId, lookupBinding } from "../../src/application/session-binding-service.js";
import type { CliContext } from "../../src/cli/types.js";
import type { GitPort, LocalChange, NumstatCounts } from "../../src/ports/git.js";
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

/**
 * A workspace whose TASKS.md cannot be read, so `extractSessionState` throws and
 * the write path reports `{ error }` instead of writing a CHECKPOINT — the shape
 * an I/O failure has in production.
 */
class UnreadableTasksFs extends MemFs {
  override async readText(p: string): Promise<string> {
    if (p.endsWith("TASKS.md")) throw new Error("EIO: TASKS.md ilegible");
    return super.readText(p);
  }
}

/**
 * Un refugio que no se deja borrar: permisos, o la corrida que ganó la carrera
 * lo borró primero. La adopción corre FUERA del try/catch de la escritura, así
 * que sin protección propia esa excepción sale hasta `main.ts` y se vuelve
 * exit 1 — que es exactamente como un host RETIENE su compactación.
 */
class UnremovableRefugeFs extends MemFs {
  override async remove(p: string): Promise<void> {
    if (p.includes("/.refuge/")) throw new Error("EACCES: no se puede borrar el refugio");
    return super.remove(p);
  }
}

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

const refugeDir = `${sessionsDir}/.refuge`;

/** The refuge a conversation's own PreCompact would park, by absolute path. */
function refugeOf(contextId: string): string {
  return `${refugeDir}/${hashContextId(contextId)}.md`;
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

// An unresolved session used to be able to HOLD the host's compaction (exit 2)
// so a person could name the target first. It trapped the conversation: the
// `--code` remedy the notice printed does not always bind the conversation, so
// the next /compact hit the same ambiguity and blocked again. The compaction now
// always completes, and what replaces the pause is the refuge checkpoint.
describe("an unresolved session degrades with a refuge, never a held compaction", () => {
  it("an ambiguity parks a refuge naming the reason, the candidates and the way out", async () => {
    const fs = seedTwoActive();
    const result = await runCheckpointWrite(fs, env, git, paths, { contextId: "conv-a" });
    if (!("continuity" in result)) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    expect(result.primary_session).toBeNull();
    expect(result.candidates).toHaveLength(2);
    // No session line was touched: the refuge is the ONLY thing written.
    expect(checkpointsWritten(fs)).toEqual([]);
    expect([...fs.writes.keys()]).toEqual([refugeOf("conv-a")]);
    expect(result.refuge_path).toBe(`.workflow/sessions/.refuge/${hashContextId("conv-a")}.md`);

    const body = await fs.readText(refugeOf("conv-a"));
    expect(body).toContain("# CHECKPOINT de refugio");
    expect(body).toContain("hook de ciclo de vida (PreCompact o SessionEnd)");
    expect(body).toContain("- Motivo: hay 2 sesiones activas");
    expect(body).toContain("- Candidatas: 020-vieja-quick (active) · 044-nueva-plan-exec (active)");
    expect(body).toContain("- Acción: indicá cuál con --code");
    // Same rule as the bindings registry: the raw conversation id never lands.
    expect(body).toContain(`- Conversación: sha256:${hashContextId("conv-a")}`);
    expect(body).not.toContain("conv-a");
  });

  // A refuge nobody could ever adopt is not a rescue, it is litter: a workspace
  // between runs is the ordinary state, and every compaction there would leave
  // a file naming no session.
  it("with nothing to select there is no refuge at all, only the notice", async () => {
    const fs = new MemFs({ lenient: true });
    const result = await runCheckpointWrite(fs, env, git, paths, { contextId: "conv-a" });
    if (!("continuity" in result)) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    expect(result.refuge_path).toBeNull();
    expect(await fs.exists(refugeDir)).toBe(false);
    expect(fs.writes.size).toBe(0);
  });

  it("every session closed: still degraded, and the closed folders are the candidates", async () => {
    const fs = seedTwoActive();
    for (const folder of ["020-vieja-quick", "044-nueva-plan-exec"]) {
      fs.file(`${sessionsDir}/${folder}/.closed`, "");
    }
    const result = await runCheckpointWrite(fs, env, git, paths, { contextId: "conv-a" });
    if (!("continuity" in result)) throw new Error(JSON.stringify(result));
    expect(result.reason).toContain("no hay sesiones activas");
    expect(checkpointsWritten(fs)).toEqual([]);
    // Reopening one of them is a real way out, so the parked state is worth keeping.
    expect(result.refuge_path).not.toBeNull();
    expect(await fs.readText(refugeOf("conv-a"))).toContain("(closed)");
  });

  it("a broken bindings registry degrades rather than holding the compaction", async () => {
    const fs = seedTwoActive();
    fs.file(`${sessionsDir}/.bindings.json`, '{"version":1,"bindings":{');
    const result = await runCheckpointWrite(fs, env, git, paths, { contextId: "conv-a" });
    if (!("continuity" in result)) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    expect(result.refuge_path).not.toBeNull();
    // Fail-closed: the corrupt registry is never rewritten.
    expect(await fs.readText(`${sessionsDir}/.bindings.json`)).toBe('{"version":1,"bindings":{');
    expect(checkpointsWritten(fs)).toEqual([]);
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

  // PostCompact is the one lifecycle channel the model actually reads, so a
  // refuge that is not named here is a file nobody will ever adopt.
  it("PostCompact names the refuge its own PreCompact left, and nobody else's", async () => {
    const fs = seedTwoActive();
    const pre = await runCheckpointWrite(fs, env, git, paths, { contextId: "conv-a" });
    if (!("continuity" in pre)) throw new Error(JSON.stringify(pre));

    const mine = await runResumeSummary(fs, paths, { contextId: "conv-a" });
    expect(mine.continuity).toBe("degraded");
    expect(mine.refuge?.path).toBe(pre.refuge_path);
    expect(mine.refuge?.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const other = await runResumeSummary(fs, paths, { contextId: "conv-b" });
    expect(other.continuity).toBe("degraded");
    expect(other.refuge).toBeNull();
  });

  // La asimetría que dejaba mudo al único canal que el modelo lee: la MISMA
  // forma de invocación que crea un refugio anónimo (PreCompact TOML de
  // kimi/crush, o un `aw checkpoint-write` desde una shell cualquiera) era la
  // única que no podía reportarlo, y `refuge: null` no dice «no sé», afirma que
  // no hay ninguno.
  it("PostCompact sin identidad de conversación nombra el refugio anónimo que dejó su PreCompact", async () => {
    const fs = seedTwoActive();
    const pre = await runCheckpointWrite(fs, env, git, paths, {});
    if (!("continuity" in pre)) throw new Error(JSON.stringify(pre));
    expect(pre.refuge_path).toBe(".workflow/sessions/.refuge/desconocida.md");

    const post = await runResumeSummary(fs, paths, {});
    expect(post.continuity).toBe("degraded");
    expect(post.refuge?.path).toBe(pre.refuge_path);
    expect(post.refuge?.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // Y no se lo atribuye a una conversación que tiene identidad propia.
    const conConversacion = await runResumeSummary(fs, paths, { contextId: "conv-a" });
    expect(conConversacion.refuge).toBeNull();
  });

  // The whole point of parking it: the loop that comes back and names its
  // session gets the state folded into the checkpoint it will read.
  it("the refuge survives the compaction and the --code run adopts it", async () => {
    const fs = seedTwoActive();
    const pre = await runCheckpointWrite(fs, env, git, paths, { contextId: "conv-a" });
    if (!("continuity" in pre)) throw new Error(JSON.stringify(pre));

    const fix = await runCheckpointWrite(fs, env, git, paths, {
      code: "044",
      contextId: "conv-a",
    });
    if (!("checkpoint_path" in fix)) throw new Error(JSON.stringify(fix));
    expect(fix.session).toBe("044-nueva-plan-exec");
    expect(fix.refuge_adopted).toEqual([pre.refuge_path]);

    const cp = await fs.readText(`${sessionsDir}/044-nueva-plan-exec/CHECKPOINT.md`);
    expect(cp).toContain("## Refugio adoptado (");
    expect(cp).toContain("- Motivo: hay 2 sesiones activas");
    // Gone from disk: a refuge left behind gets adopted again on every run.
    expect(await fs.exists(refugeOf("conv-a"))).toBe(false);
  });
});

describe("SessionEnd acts on one session, never on every active one", () => {
  it("ambiguous close writes no checkpoint at all, and parks the state instead", async () => {
    const fs = seedTwoActive();
    const result = await runAutoCompactOnClose(fs, env, git, paths, { contextId: "conv-a" });
    expect(result.checkpoints_written).toEqual([]);
    expect(result.continuity).toBe("degraded");
    expect(result.primary_session).toBeNull();
    expect(result.candidates).toHaveLength(2);
    // The heart of it: no session was touched — the refuge is the only write.
    expect(checkpointsWritten(fs)).toEqual([]);
    expect([...fs.writes.keys()]).toEqual([refugeOf("conv-a")]);
    expect(result.refuge_path).toBe(`.workflow/sessions/.refuge/${hashContextId("conv-a")}.md`);
  });

  it("a close that DOES resolve adopts the refuge its own compaction left", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file(`${sessionsDir}/001-sola-quick/SESSION.md`, "# SESSION — 001-sola-quick\n");
    const parked = await writeRefugeCheckpoint(fs, paths, {
      reason: "hay 2 sesiones activas y la conversación no tiene una asociación",
      action: "indicá cuál con --code <NNN>",
      candidates: [{ folder: "001-sola-quick", code: "001", state: "active" }],
      contextId: "conv-a",
    });

    const result = await runAutoCompactOnClose(fs, env, git, paths, { contextId: "conv-a" });
    expect(result.checkpoints_written[0]?.refuge_adopted).toEqual([parked]);
    const cp = await fs.readText(`${sessionsDir}/001-sola-quick/CHECKPOINT.md`);
    expect(cp).toContain("## Refugio adoptado (");
    expect(await fs.exists(refugeOf("conv-a"))).toBe(false);
  });

  // El guard que sólo adopta cuando el CHECKPOINT se pudo escribir. Sin él,
  // `writeText`/`appendText` CREAN el archivo: el estado parqueado quedaría
  // archivado bajo una línea de sesión que nadie escribió (sin H1 ni sello) y el
  // refugio borrado — irrecuperable.
  it("un cierre que NO logra escribir el CHECKPOINT no se lleva el refugio", async () => {
    const fs = new UnreadableTasksFs({ lenient: true });
    fs.file(`${sessionsDir}/001-sola-quick/SESSION.md`, "# SESSION — 001-sola-quick\n");
    fs.file(`${sessionsDir}/001-sola-quick/TASKS.md`, "- [x] T1\n- [ ] T2\n");
    const parked = await writeRefugeCheckpoint(fs, paths, {
      reason: "hay 2 sesiones activas y la conversación no tiene una asociación",
      action: "indicá cuál con --code <NNN>",
      candidates: [{ folder: "001-sola-quick", code: "001", state: "active" }],
      contextId: "conv-a",
    });

    const result = await runAutoCompactOnClose(fs, env, git, paths, { contextId: "conv-a" });
    expect(result.checkpoints_written).toHaveLength(1);
    expect(result.checkpoints_written[0]?.error).toContain("TASKS.md ilegible");
    expect(result.checkpoints_written[0]?.refuge_adopted).toBeUndefined();
    // Nada creado, nada perdido: el refugio sigue ahí para la próxima corrida.
    expect(checkpointsWritten(fs)).toEqual([]);
    expect(await fs.exists(refugeOf("conv-a"))).toBe(true);
    expect(await fs.readText(`/cwd/${parked}`)).toContain("- Motivo: hay 2 sesiones activas");
  });

  // El cierre regenera por su propio camino, así que arrastrar lo adoptado tiene
  // que valer también acá: si no, el SessionEnd que sigue a una adopción borra
  // la sección y el refugio ya no existe en disco.
  it("un cierre que regenera el CHECKPOINT conserva el refugio ya adoptado", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file(`${sessionsDir}/001-sola-quick/SESSION.md`, "# SESSION — 001-sola-quick\n");
    await writeRefugeCheckpoint(fs, paths, {
      reason: "hay 2 sesiones activas y la conversación no tiene una asociación",
      action: "indicá cuál con --code <NNN>",
      candidates: [{ folder: "001-sola-quick", code: "001", state: "active" }],
      contextId: "conv-a",
    });
    await runCheckpointWrite(fs, env, git, paths, { contextId: "conv-a" });
    const cpPath = `${sessionsDir}/001-sola-quick/CHECKPOINT.md`;
    expect(await fs.readText(cpPath)).toContain("## Refugio adoptado (");

    const close = await runAutoCompactOnClose(fs, env, git, paths, { contextId: "conv-a" });
    expect(close.checkpoints_written[0]?.preserved).toBeUndefined();
    expect(close.checkpoints_written[0]?.session).toBe("001-sola-quick");
    const cp = await fs.readText(cpPath);
    expect(cp).toContain("## Refugio adoptado (");
    expect(cp.match(/## Refugio adoptado \(/g)).toHaveLength(1);
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
      contextId: "conv-a",
    });
    // The compaction completes. What matters is that the closed line itself is
    // untouched and the reason says how to reach it — reopening it is a real way
    // out, so the state is parked next to it rather than dropped.
    if (!("continuity" in result)) throw new Error(JSON.stringify(result));
    expect(result.continuity).toBe("degraded");
    expect(result.reason).toContain("cerrada");
    expect(result.action).toContain("--reopen");
    expect(checkpointsWritten(fs)).toEqual([]);
    expect([...fs.writes.keys()]).toEqual([refugeOf("conv-a")]);
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

describe("checkpoint-write CLI — exit 0 always, and the person hears why", () => {
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

  const hostEnv = new FakeEnv("/home/u", "/cwd", { CLAUDE_CODE_SESSION_ID: "conv-claude" });

  // `--can-pause` is still accepted — hooks installed on people's machines keep
  // passing it, and a flag the parser does not know swallows the token after it
  // — but it decides nothing: with it or without it, the ambiguity degrades to
  // exactly the same result at exit 0.
  it("--can-pause is inert: the same ambiguity, the same degraded result, exit 0", async () => {
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
    const withFlag = await checkpointWriteCommand.execute(
      argv(["--can-pause"]),
      ctxFor(seedTwoActive(), hostEnv),
    );
    const without = await checkpointWriteCommand.execute(
      argv([]),
      ctxFor(seedTwoActive(), hostEnv),
    );
    expect(withFlag.ok).toBe(true);
    expect(withFlag.exitCode).toBe(0);
    expect(withFlag.data).toEqual(without.data);
  });

  it("nothing to select → exit 0, degraded", async () => {
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
    const result = await checkpointWriteCommand.execute(
      argv(["--can-pause"]),
      ctxFor(new MemFs({ lenient: true })),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("an unambiguous --code writes and exits 0 with the inert flag present", async () => {
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
    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");

    const fix = await checkpointWriteCommand.execute(
      argv(["--can-pause"], [["code", "044"]]),
      ctxFor(fs, hostEnv),
    );
    expect(fix.exitCode).toBe(0);

    const retry = await checkpointWriteCommand.execute(argv(["--can-pause"]), ctxFor(fs, hostEnv));
    expect(retry.ok).toBe(true);
    expect(retry.exitCode).toBe(0);
    // Resolved, not degraded: the retry wrote the bound session's checkpoint.
    expect(checkpointsWritten(fs)).toEqual([`${sessionsDir}/044-nueva-plan-exec/CHECKPOINT.md`]);
  });

  // La limpieza del refugio no puede costar la compactación: adoptar es
  // escribir el bloque, y borrar el archivo es lo que sigue. Un `remove` que
  // falla dejaba escapar la excepción hasta el proceso, o sea el host retenía
  // la compactación por no poder borrar un archivo cuyo contenido ya estaba a
  // salvo dentro del CHECKPOINT.
  it("un refugio que no se puede borrar no retiene la compactación: exit 0", async () => {
    const fs = new UnremovableRefugeFs({ lenient: true });
    fs.file(`${sessionsDir}/044-nueva-plan-exec/SESSION.md`, "# SESSION — 044-nueva-plan-exec\n");
    fs.file(`${sessionsDir}/044-nueva-plan-exec/TASKS.md`, "- [x] T1\n- [ ] T2\n");
    await writeRefugeCheckpoint(fs, paths, {
      reason: "hay 2 sesiones activas y la conversación no tiene una asociación",
      action: "indicá cuál con --code <NNN>",
      candidates: [{ folder: "044-nueva-plan-exec", code: "044", state: "active" }],
      contextId: "conv-claude",
    });

    const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
    const result = await checkpointWriteCommand.execute(
      argv([], [["code", "044"]]),
      ctxFor(fs, hostEnv),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // Y el estado sí quedó adoptado: lo que falló fue la limpieza.
    expect(await fs.readText(`${sessionsDir}/044-nueva-plan-exec/CHECKPOINT.md`)).toContain(
      "## Refugio adoptado (",
    );
  });

  // Claude Code shows a person stderr for a lifecycle hook; the stdout envelope
  // it never shows. Without this line a degraded compaction is silent.
  async function noticeFor(fs: MemFs): Promise<{ exitCode?: number; notice: string }> {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { checkpointWriteCommand } = await import("../../src/cli/commands/checkpoint-write.js");
      const result = await checkpointWriteCommand.execute(
        argv(["--can-pause"]),
        ctxFor(fs, hostEnv),
      );
      return {
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        notice: spy.mock.calls.map((call) => String(call[0])).join(""),
      };
    } finally {
      spy.mockRestore();
    }
  }

  it("a degraded compaction says on stderr what happened and where the refuge is", async () => {
    const { exitCode, notice } = await noticeFor(seedTwoActive());
    expect(exitCode).toBe(0);
    expect(notice).toContain("compactación continúa sin checkpoint");
    expect(notice).toContain("2 sesiones activas");
    expect(notice).toContain(`refugio: .workflow/sessions/.refuge/${hashContextId("conv-claude")}`);
  });

  it("with nothing to park, the notice promises no refuge", async () => {
    const { exitCode, notice } = await noticeFor(new MemFs({ lenient: true }));
    expect(exitCode).toBe(0);
    expect(notice).toContain("compactación continúa sin checkpoint");
    expect(notice).not.toContain("refugio");
  });
});

describe("la plantilla de hooks ya no puede pedir una pausa", () => {
  interface HookCommand {
    type: string;
    command?: string;
    prompt?: string;
  }

  async function template(): Promise<Record<string, { hooks: HookCommand[] }[]>> {
    const path = resolve(__dirname, "..", "..", "skills", "w", "hooks", "hooks.template.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, { hooks: HookCommand[] }[]>;
    };
    return parsed.hooks;
  }

  it("PreCompact invoca checkpoint-write a secas — sin --can-pause en ninguna parte", async () => {
    const hooks = await template();
    expect(hooks.PreCompact?.[0]?.hooks[0]?.command).toBe("agent-workflow checkpoint-write");
    expect(JSON.stringify(hooks)).not.toContain("--can-pause");
  });

  it("el prompt de PostCompact enseña a mostrar y adoptar el refugio", async () => {
    const hooks = await template();
    const prompt = hooks.PostCompact?.[0]?.hooks.find((h) => h.type === "prompt")?.prompt ?? "";
    expect(prompt).toContain("`refuge`");
    expect(prompt).toContain("aw checkpoint-write --code");
  });
});
