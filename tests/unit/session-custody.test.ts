import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { recordCommit } from "../../src/application/session-custody-recorder.js";
import { readCustody } from "../../src/application/session-custody-service.js";
import { runWorktree } from "../../src/application/worktree-service.js";
import type {
  WorktreeEnsureOutput,
  WorktreeError,
} from "../../src/application/worktree-service.js";
import {
  CUSTODY_FILE,
  type SessionCustody,
  attributableCommits,
  custodyCompleteness,
} from "../../src/domain/session/custody.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * Real git and a real filesystem, for the same reason the worktree tests use
 * them: a custody's whole value is that its baseline matches what git and the
 * disk really held, and a fake would only ever confirm our own assumption about
 * that back to us.
 */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function block(sourcePath: string): string {
  return `<!-- WORKFLOW-PROJECT-START -->
## Proyecto

Test.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| acme | ${sourcePath} | main |

## Status

- Ramas de trabajo actuales:
  - acme: main
<!-- WORKFLOW-PROJECT-END -->
`;
}

describe("session custody — what a run received, created and changed", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let source: string;
  let paths: PathsService;
  let deps: Parameters<typeof runWorktree>[0];
  const fs = new NodeFileSystem();

  function sessionsDir(): string {
    return join(workspace, ".workflow", "sessions");
  }

  async function custodyOf(folder: string): Promise<SessionCustody> {
    const read = await readCustody(fs, join(sessionsDir(), folder));
    if (read.status !== "present") throw new Error(`custodia ${read.status}`);
    return read.custody;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "custody-"));
    home = join(root, "home");
    workspace = join(root, "ws");
    source = join(root, "acme");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    mkdirSync(sessionsDir(), { recursive: true });
    mkdirSync(source, { recursive: true });

    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.email", "t@example.com");
    git(source, "config", "user.name", "T");
    writeFileSync(join(source, "README.md"), "hola\n");
    git(source, "add", "-A");
    git(source, "commit", "-m", "inicial");

    writeFileSync(join(workspace, "CLAUDE.md"), block(source));
    const env = new FakeEnv(home, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), home, workspace);
    deps = { fs, env, git: new GitCliAdapter(new NodeProcess()), paths };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function create(
    name: string,
    inputs: string[] = [],
  ): Promise<{ folder: string; path: string }> {
    const result = await runSessionCreate(fs, paths, {
      type: "exec",
      name,
      objetivo: "ejecutar",
      ...(inputs.length > 0 ? { inputs } : {}),
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    return { folder: result.sessionCreate.folder, path: result.sessionCreate.path };
  }

  it("is sealed with the session, before it can produce any effect", async () => {
    const plan = "docs/plans/024-plan-x.md";
    writeFileSync(join(workspace, plan), "# Plan 024\n> Estado: open\n");

    const session = await create("x-plan-exec", [plan]);

    // The record exists the moment the folder does — not after the first write.
    expect(existsSync(join(session.path, CUSTODY_FILE))).toBe(true);
    const custody = await custodyOf(session.folder);
    expect(custody.subject).toEqual({ kind: "session", key: session.folder });
    // The declared input IS the provenance: the plan is a typed parent.
    expect(custody.parents).toEqual([{ kind: "plan", key: "024" }]);
    // Byte-exact, so a restore can reproduce it rather than approximate it.
    expect(custody.artifacts).toEqual([
      {
        path: plan,
        role: "input",
        before: {
          existed: true,
          digest: expect.any(String),
          bytes: Buffer.byteLength("# Plan 024\n> Estado: open\n", "utf8"),
          content: "# Plan 024\n> Estado: open\n",
        },
      },
    ]);
    expect(custodyCompleteness(custody)).toEqual({ complete: true, gaps: [] });
  });

  it("records an input that does not exist yet as an explicit absence", async () => {
    const session = await create("y-plan-new", ["docs/plans/031-plan-nuevo.md"]);
    const custody = await custodyOf(session.folder);
    expect(custody.artifacts[0]?.before).toEqual({
      existed: false,
      digest: null,
      bytes: null,
      content: null,
    });
    expect(custodyCompleteness(custody).complete).toBe(true);
  });

  /**
   * The protocol's own road: the five command skills open a session with
   * `--name <slug>-<flow>` and pass no `--input`, so what the custody ends up
   * holding is exactly what the CLI can derive from that descriptor.
   */
  describe("a session born through the documented protocol declares its inputs", () => {
    async function bare(type: string, name: string) {
      const result = await runSessionCreate(fs, paths, { type, name, objetivo: "o" });
      if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
      return result.sessionCreate;
    }

    beforeEach(() => mkdirSync(join(workspace, "docs", "specs"), { recursive: true }));

    it("seals the plan a `-plan-exec` works on, with no skill passing --input", async () => {
      const plan = "docs/plans/024-plan-correo-otp.md";
      writeFileSync(join(workspace, plan), "# Plan 024\n> Estado: open\n");

      const record = await bare("exec", "correo-otp-plan-exec");

      expect(record.inputs).toEqual([plan]);
      expect(record.inputs_from).toBe("derived");
      expect(record.inputs_note).toBeUndefined();
      const custody = await custodyOf(record.folder);
      // The baseline is the real bytes, so this session is resettable — which is
      // precisely what it was not before the derivation existed.
      expect(custody.artifacts[0]?.before.content).toBe("# Plan 024\n> Estado: open\n");
      // And the document becomes a PROVABLE parent instead of no edge at all.
      expect(custody.parents).toEqual([{ kind: "plan", key: "024" }]);
    });

    it("seals the SPEC for `-plan-new`: the plan it writes has no number yet", async () => {
      const spec = "docs/specs/029-spec-correo-otp.md";
      writeFileSync(join(workspace, spec), "---\nstatus: ready-for-plan\n---\n");
      writeFileSync(join(workspace, "docs/plans/024-plan-correo-otp.md"), "# Plan 024\n");

      const record = await bare("refine", "correo-otp-plan-new");

      expect(record.inputs).toEqual([spec]);
      expect((await custodyOf(record.folder)).parents).toEqual([{ kind: "spec", key: "029" }]);
    });

    it("seals the spec a `-spec-refine` works on", async () => {
      const spec = "docs/specs/029-spec-correo-otp.md";
      writeFileSync(join(workspace, spec), "---\nstatus: draft\n---\n");
      expect((await bare("refine", "correo-otp-spec-refine")).inputs).toEqual([spec]);
    });

    it("derives nothing for a quick: a quick works on no document", async () => {
      writeFileSync(join(workspace, "docs/plans/024-plan-suelto.md"), "# Plan 024\n");
      const record = await bare("quick", "suelto-quick");
      expect(record.inputs).toEqual([]);
      expect(record.inputs_from).toBe("none");
      // No flow document to look for, so there is nothing to explain either.
      expect(record.inputs_note).toBeUndefined();
    });

    it("refuses to CHOOSE when two documents answer to the same slug, and says so", async () => {
      writeFileSync(join(workspace, "docs/plans/024-plan-correo-otp.md"), "# Plan 024\n");
      writeFileSync(join(workspace, "docs/plans/031-plan-correo-otp.md"), "# Plan 031\n");

      const record = await bare("exec", "correo-otp-plan-exec");

      // Sealing the wrong plan is worse than sealing none: a later reset would
      // put somebody else's bytes back.
      expect(record.inputs).toEqual([]);
      expect(record.inputs_from).toBe("none");
      expect(record.inputs_note).toContain("024-plan-correo-otp.md");
      expect(record.inputs_note).toContain("031-plan-correo-otp.md");
      expect(record.inputs_note).toContain("--input");
      expect((await custodyOf(record.folder)).artifacts).toEqual([]);
    });

    it("says why the custody is empty when the flow's document is not there", async () => {
      const record = await bare("exec", "inexistente-plan-exec");
      expect(record.inputs).toEqual([]);
      expect(record.inputs_from).toBe("none");
      expect(record.inputs_note).toContain("docs/plans/NNN-plan-inexistente.md");
    });

    it("never derives from a descriptor that is only a flow name", async () => {
      // `--name plan-exec` leaves an empty slug: matching on it would adopt any
      // `docs/plans/NNN-plan.md` as this run's input.
      writeFileSync(join(workspace, "docs/plans/024-plan.md"), "# Plan 024\n");
      const record = await bare("exec", "plan-exec");
      expect(record.inputs).toEqual([]);
      expect(record.inputs_note).toBeUndefined();
    });

    it("lets an explicit --input win: the caller is the authority", async () => {
      const derivable = "docs/plans/024-plan-correo-otp.md";
      const chosen = "docs/specs/029-spec-otra-cosa.md";
      writeFileSync(join(workspace, derivable), "# Plan 024\n");
      writeFileSync(join(workspace, chosen), "---\nstatus: draft\n---\n");

      const result = await runSessionCreate(fs, paths, {
        type: "exec",
        name: "correo-otp-plan-exec",
        objetivo: "o",
        inputs: [chosen],
      });
      if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
      expect(result.sessionCreate.inputs).toEqual([chosen]);
      expect(result.sessionCreate.inputs_from).toBe("declared");
    });
  });

  it("refuses an input that is not a workspace-relative path", async () => {
    const result = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "z-quick",
      objetivo: "o",
      inputs: ["/etc/passwd"],
    });
    expect("error" in result && result.code).toBe("INVALID_INPUT");
    // Nothing was created: the refusal comes before the claim.
    expect(existsSync(join(sessionsDir(), "001-z-quick"))).toBe(false);
  });

  it("never re-mints a number that only HISTORY still remembers", async () => {
    const first = await create("uno-quick");
    expect(first.folder).toBe("001-uno-quick");

    // The row survives the folder — which is exactly what a retirement leaves.
    writeFileSync(
      paths.cwdHistoryFile(),
      "# Session History\n\n| Sesión | Fecha | Estado | Refs |\n|---|---|---|---|\n| 001-uno-quick | 2026-08-13 | discarded | — |\n",
    );
    rmSync(first.path, { recursive: true, force: true });

    const second = await create("dos-quick");
    expect(second.folder).toBe("002-dos-quick");
  });

  it("never leaves a session folder that exists without its custody, even racing", async () => {
    // The established contract for a create/create race is "one wins, the other
    // reports LOCK_BUSY" (see session-concurrency.test.ts). What matters here is
    // the other half: whatever DID get created carries its seal, because the
    // folder and the custody are written inside the same critical section.
    const results = await Promise.all([
      runSessionCreate(fs, paths, { type: "quick", name: "a-quick", objetivo: "a" }),
      runSessionCreate(fs, paths, { type: "quick", name: "b-quick", objetivo: "b" }),
    ]);
    const created = results.filter(
      (r): r is Exclude<typeof r, { error: string }> => !("error" in r),
    );
    expect(created.length).toBeGreaterThanOrEqual(1);

    const folders = (await fs.list(sessionsDir())).filter((e) => e.type === "dir");
    expect(folders.map((f) => f.name).sort()).toEqual(
      created.map((r) => r.sessionCreate.folder).sort(),
    );
    for (const folder of folders) {
      expect(custodyCompleteness(await custodyOf(folder.name)).complete).toBe(true);
    }
    // Distinct `NNN-` prefixes: an identity is never handed out twice.
    expect(new Set(folders.map((f) => f.name.slice(0, 3))).size).toBe(folders.length);
  });

  it("seals the source's git baseline when the session takes its unit", async () => {
    // Somebody else's uncommitted work, present BEFORE the session arrives.
    writeFileSync(join(source, "ajeno.txt"), "no es mio\n");
    const session = await create("tres-plan-exec");
    const head = git(source, "rev-parse", "HEAD").trim();

    const unit = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: session.folder,
    })) as WorktreeEnsureOutput;
    expect(unit.created).toBe(true);

    const custody = await custodyOf(session.folder);
    expect(custody.sources).toHaveLength(1);
    const recorded = custody.sources[0];
    expect(recorded?.alias).toBe("acme");
    expect(recorded?.branch).toBe("main");
    expect(recorded?.baseline_head).toBe(head);
    expect(recorded?.unit_branch).toBe(`aw/${session.folder}`);
    expect(recorded?.unit_path).toBe(unit.path);
    // The pre-existing dirt is named, so it can never be attributed to this run.
    expect(recorded?.dirty_paths).toContain("ajeno.txt");
    expect(custodyCompleteness(custody).complete).toBe(true);
  });

  it("keeps the FIRST baseline when the unit is ensured again", async () => {
    const session = await create("cuatro-plan-exec");
    await runWorktree(deps, { action: "ensure", alias: "acme", sessionCode: session.folder });
    const first = await custodyOf(session.folder);

    // The session commits inside its unit, then asks for the unit again.
    const unitPath = (first.sources[0]?.unit_path ?? "") as string;
    writeFileSync(join(unitPath, "nuevo.txt"), "trabajo\n");
    git(unitPath, "add", "-A");
    git(unitPath, "commit", "-m", "trabajo de la sesión");
    await runWorktree(deps, { action: "ensure", alias: "acme", sessionCode: session.folder });

    const second = await custodyOf(session.folder);
    // A baseline that moved with the work would stop being a baseline.
    expect(second.sources[0]?.baseline_head).toBe(first.sources[0]?.baseline_head);
    expect(second.sources).toHaveLength(1);
  });

  it("refuses the unit when the custody exists but cannot be read", async () => {
    const session = await create("cinco-plan-exec");
    writeFileSync(join(session.path, CUSTODY_FILE), "{ esto no es json");

    const outcome = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: session.folder,
    })) as WorktreeError;
    expect(outcome.error).toBe("custody_unreadable");
    expect(outcome.message).toContain(session.folder);
  });

  it("leaves a legacy session with no custody working exactly as before", async () => {
    // A folder created by hand: no custody, like every session born before it.
    const folder = "090-legacy-plan-exec";
    mkdirSync(join(sessionsDir(), folder), { recursive: true });
    writeFileSync(join(sessionsDir(), folder, "SESSION.md"), `# SESSION — ${folder}\n`);

    const unit = (await runWorktree(deps, {
      action: "ensure",
      alias: "acme",
      sessionCode: folder,
    })) as WorktreeEnsureOutput;

    expect(unit.created).toBe(true);
    expect(existsSync(join(sessionsDir(), folder, CUSTODY_FILE))).toBe(false);
  });

  it("records a typed commit's own SHAs, never a reading taken afterwards", async () => {
    const session = await create("seis-plan-exec");
    writeFileSync(join(source, "otro.txt"), "x\n");
    git(source, "add", "-A");
    const before = git(source, "rev-parse", "HEAD").trim();

    const receipt = await deps.git.commit(source, "cambio con recibo");
    expect(receipt.before).toBe(before);
    expect(receipt.after).toBe(git(source, "rev-parse", "HEAD").trim());
    expect(receipt.parents).toEqual([before]);
    expect(receipt.branch).toBe("main");

    await recordCommit(deps, session.folder, "acme", receipt);
    const custody = await custodyOf(session.folder);
    expect(attributableCommits(custody, "acme")).toEqual([receipt.after]);
    const effect = custody.effects.find((e) => e.kind === "commit");
    expect(effect?.before).toBe(before);
    expect(effect?.ref).toBe("refs/heads/main");
  });

  it("reports a hand-edited record as incomplete instead of trusting it", async () => {
    const plan = "docs/plans/024-plan-x.md";
    writeFileSync(join(workspace, plan), "original\n");
    const session = await create("siete-plan-exec", [plan]);

    const raw = JSON.parse(readFileSync(join(session.path, CUSTODY_FILE), "utf-8")) as {
      artifacts: Array<{ before: { content: string } }>;
    };
    // Somebody rewrites the baseline by hand: the seal no longer covers it.
    const first = raw.artifacts[0];
    if (first !== undefined) first.before.content = "otra cosa\n";
    writeFileSync(join(session.path, CUSTODY_FILE), JSON.stringify(raw));

    const verdict = custodyCompleteness(await custodyOf(session.folder));
    expect(verdict.complete).toBe(false);
    expect(verdict.gaps.map((g) => g.what)).toContain("sello de la custodia");
  });
});
